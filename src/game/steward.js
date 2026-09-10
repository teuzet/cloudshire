/**
 * Наместник больше не правит сам: при молчании покровителя ходит случайный свободный сановник.
 * Движок решает КОГДА и КОГО; агент officerAct — ЧТО в рамках должности.
 */

import { newId } from './ids.js';
import { createLoreFact, chronicleEntries } from './models.js';
import {
  activeProcesses,
  canStartProcess,
  findDuplicateProcess,
  resolveLinkedStats,
} from './processes.js';
import { judgeDeed } from './deedJudge.js';
import { startDeed, deedRemainingBand } from './deeds.js';
import { gameDateFromDay } from './gameClock.js';
import { scheduleDeedJob } from './worldLoop.js';
import { DURATION_SPEC } from './bands.js';
import { formatBoardForPrompt, isStakedStory, plotHasLiveProcess } from './plotlines.js';
import { ensureErrandForProcess, linkProcessToPlotline, rehomeUnrelatedProcess } from './plotEngine.js';
import { judgeProcessAlignment, engagementOf } from './plotAlign.js';
import { qualitativeStatsBrief, qualitativePopulation } from './stats.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import {
  pickRandomFreeOfficer,
  bindOfficerProcess,
  isOffPortfolio,
  formatOfficersForPrompt,
  officeStrategy,
} from './officers.js';

export function countTrailingUnansweredNews(dialogHistory = []) {
  let n = 0;
  for (let i = dialogHistory.length - 1; i >= 0; i -= 1) {
    const m = dialogHistory[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && (m.kind === 'event' || m.kind === 'tick_news')) n += 1;
  }
  return n;
}

export function stewardConfig(config) {
  const s = config?.tick?.steward || {};
  return {
    loseAfterLetters: Math.max(1, Math.round(Number(s.loseAfterLetters) ?? 2)),
    afterSilentMonths: Math.max(1, Math.round(Number(s.afterSilentMonths) ?? 3)),
    // Чаще этого сановники сами не берутся: иначе они завалят доску без покровителя.
    cooldownDays: Math.max(1, Math.round(Number(s.cooldownDays) ?? 30)),
  };
}

/** Не чаще раза в cooldownDays: молчание покровителя не должно рождать поток дел. */
export function stewardOffCooldown(domain, day, config) {
  const last = Number(domain?.state?.lastStewardDay);
  if (!Number.isFinite(last)) return true;
  return Math.round(Number(day) || 0) - last >= stewardConfig(config).cooldownDays;
}

export function markStewardRan(domain, day) {
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  domain.state.lastStewardDay = Math.round(Number(day) || 0);
  return domain;
}

export function shouldRunSteward(domain, config) {
  const cfg = stewardConfig(config);
  const character = domain?.characters?.[0];
  const silent = countTrailingUnansweredNews(character?.dialogHistory || []);
  return { ok: silent >= cfg.afterSilentMonths, silent };
}

/** Одно письмо на полосу молчания: «куда ты делся», даже если порог давно проскочили. */
export function shouldAskPatronPresence(domain, config) {
  const cfg = stewardConfig(config);
  const character = domain?.characters?.[0];
  const silent = countTrailingUnansweredNews(character?.dialogHistory || []);
  if (silent < cfg.loseAfterLetters) return { ok: false, silent };
  if (domain?.state?.patronPresenceAsked) return { ok: false, silent };
  return { ok: true, silent };
}

export function markPatronPresenceAsked(domain) {
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  domain.state.patronPresenceAsked = true;
}

export function clearPatronPresenceAsked(domain) {
  if (domain?.state) domain.state.patronPresenceAsked = false;
}

/**
 * След того, что сановник взялся за дело сам.
 *
 * Это не событие города, а служебная отметка: начало дела игрок и так видит в
 * списке дел, а в летописи такая строка называет дело по имени и палит
 * метагейм. Поэтому запись техническая — без тега `chronicle` и скрытая,
 * так что ни хроника, ни жрец её не видят.
 */
function rememberOfficerInitiative(domain, { text, world, officer, day = 0 }) {
  domain.lore = domain.lore || [];
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['fact', 'officer', 'initiative'],
    gameDateLabel: gameDateFromDay(day).label,
    tick: world?.tickIndex ?? null,
    day,
    author: `officer:${officer?.office || 'unknown'}`,
    secret: true,
  });
  domain.lore.push(fact);
  return fact;
}

async function applyProcess(domain, args, { config, runtime, world, officer, day = 0, log }) {
  const slots = canStartProcess(domain, config);
  if (!slots.ok || !officer) {
    return { error: 'too_many_processes', message: 'Все сановники заняты.' };
  }
  const summary = String(args.summary || '').trim();
  const detail = String(args.detail || '').trim();
  if (summary.length < 3 || detail.length < 8) {
    return { error: 'thin', message: 'Нужны название и суть поручения.' };
  }
  const dup = findDuplicateProcess(domain, summary, detail);
  if (dup) {
    return { error: 'duplicate_process', message: `Уже идёт «${dup.summary}».` };
  }
  const linked = resolveLinkedStats(args.linkedStats, config);
  if (!linked.length) {
    return { error: 'linked_stats_required', message: 'Нужен один стат характера дела.' };
  }
  const linkedStat = linked[0];
  const action = {
    id: newId('act'),
    summary,
    detail,
    goal: String(args.goal || '').trim() || null,
    linkedStats: [linkedStat],
    officerId: officer.id,
    office: officer.office,
    offPortfolio: isOffPortfolio(officer, linkedStat),
    onBehalfOf: officer.name,
    characterId: officer.id,
    characterName: officer.name,
    characterNote: args.note || null,
    status: 'active',
    initiative: 'officer',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  domain.state.pendingActions = domain.state.pendingActions || [];
  domain.state.pendingActions.push(action);
  bindOfficerProcess(domain, officer, action);
  const judged = await judgeDeed({
    runtime,
    domain,
    summary,
    detail,
    goal: action.goal || '',
    log,
  });
  if (judged.note) action.durationNote = judged.note;
  startDeed(action, { day, judged });
  scheduleDeedJob(world, domain, action);
  let plot = args.plotId ? linkProcessToPlotline(domain, action.id, String(args.plotId)) : null;
  if (!plot) {
    plot = ensureErrandForProcess(domain, action, {
      tick: world?.tickIndex ?? null,
      config,
    }).plot;
  }
  action.plotlineId = plot?.id || null;
  if (plot && isStakedStory(plot)) {
    await judgeProcessAlignment({ runtime, domain, process: action, plot, log });
    if (engagementOf(action) === 'UNRELATED') {
      const moved = rehomeUnrelatedProcess(domain, action, {
        tick: world?.tickIndex ?? null,
        config,
      });
      plot = moved.plot;
      action.plotlineId = plot?.id || null;
    }
  }
  rememberOfficerInitiative(domain, {
    world,
    officer,
    day,
    text: `${officer.title} ${officer.name} сам взялся за дело: ${summary}.`,
  });
  return { action, plot };
}

/**
 * Ход сановника, когда покровитель давно молчит. Когда и кем — решает движок.
 * @returns {{ silent: number, act: object|null }}
 */
export async function runOfficerAct({
  config,
  runtime,
  domain,
  world,
  day = 0,
  log: parentLog,
  rng = Math.random,
}) {
  const gate = shouldRunSteward(domain, config);
  if (!gate.ok) return { silent: gate.silent, act: null };

  const officer = pickRandomFreeOfficer(domain, rng);
  if (!officer) return { silent: gate.silent, act: null };

  const log = (parentLog || getLogger()).child({ scope: 'officerAct', domainId: domain.id });
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const tools = [
    {
      name: 'submit_officer_act',
      description:
        'Одно дело от лица выбранного сановника. process — новое дело на одну открытую историю, none — ничего.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['none', 'process'] },
          summary: { type: 'string', description: 'Название дела, 1–8 слов' },
          detail: { type: 'string', description: 'Что именно делает этот сановник' },
          goal: { type: 'string' },
          linkedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Ровно один стат характера ДЕЛА из: ${statIds}`,
          },
          plotId: {
            type: 'string',
            description: 'id одной открытой истории без поручения.',
          },
          note: { type: 'string' },
        },
      },
      handler: async (args) => {
        const kind = String(args?.action || '');
        if (kind === 'none') {
          draft.data = { kind: 'none' };
          return { ok: true };
        }
        if (kind === 'process') {
          const applied = await applyProcess(domain, args, {
            config,
            runtime,
            world,
            officer,
            day,
            log,
          });
          if (applied.error) return toolFail(applied.error, applied.message);
          draft.data = {
            kind: 'process',
            summary: applied.action.summary,
            id: applied.action.id,
            office: officer.office,
            officerName: officer.name,
          };
          return { ok: true };
        }
        return toolFail('bad_action', 'action: none или process.');
      },
    },
  ];

  const recent = chronicleEntries(domain.lore)
    .slice(-6)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${e.text}`)
    .join('\n');
  const processes = activeProcesses(domain, config)
    .map((p) => `- ${p.summary} (ждать ещё: ${DURATION_SPEC[deedRemainingBand(p, day)].label})`)
    .join('\n');
  const openStories = (domain.plotlines || []).filter(
    (p) => p.kind === 'story' && !plotHasLiveProcess(domain, p),
  );

  await runtime.run({
    agentId: 'officerAct',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_officer_act' } },
    log,
    scene: 'officer_act',
    domainId: domain.id,
          extraSystem: [
      `Ты действуешь от лица сановника: ${officer.title} ${officer.name}. Покровитель молчит. Жрец не правит сам.`,
      officeStrategy(officer, config) ? `Как ты действуешь: ${officeStrategy(officer, config)}` : '',
      String(domain.proxyText || domain.state?.confluxDirective?.text || '').trim()
        ? `Доверенность правителя — как подходить к делам: ${String(domain.proxyText || domain.state.confluxDirective.text).trim()}`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    userMessages: [
      {
        role: 'user',
        content: [
          `Покровитель не отвечает уже ${gate.silent} вестей подряд.`,
          `Движок выбрал сановника: ${officer.title} ${officer.name} (${officer.office}, стат ${officer.statId}).`,
          officer.nature ? `Характер: ${officer.nature}` : '',
          officeStrategy(officer, config) ? `Стратегия должности: ${officeStrategy(officer, config)}` : '',
          'Заведи ОДНО дело в рамках своего класса на ОДНУ открытую историю без поручения (включая сопряжение).',
          'Если история требует чужого умения — всё равно делай её ты, linkedStats от характера задачи (чужое дело).',
          'Не объявляй постоянных правил. Не возобновляй паузы. Не резюмируй от жреца.',
          'Если не за что браться — action=none.',
          openStories.length
            ? `Истории без поручения:\n${openStories
                .map((p) => `- [${p.id}] «${p.title}»: ${p.synopsis || ''}`)
                .join('\n')}`
            : 'Открытых историй без поручения нет — можно none.',
          '',
          formatOfficersForPrompt(domain, config),
          '',
          `Город: ${qualitativePopulation(domain.population || 0)}`,
          qualitativeStatsBrief(domain.stats || {}, config),
          '',
          'Живые нити:',
          formatBoardForPrompt(domain),
          '',
          'Уже идут дела:',
          processes || '- (нет)',
          '',
          'Недавняя хроника:',
          recent || '- (нет)',
          '',
          'Вызови submit_officer_act.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  log.info('officerAct.done', {
    silent: gate.silent,
    office: officer.office,
    act: draft.data ? `${draft.data.kind}:${draft.data.summary || 'none'}` : 'no_tool',
    preview: truncate(draft.data?.summary || '', 120),
  });
  return { silent: gate.silent, act: draft.data };
}

export const runSteward = runOfficerAct;
