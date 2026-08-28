/**
 * Наместник: когда покровитель долго молчит, правитель сам отдаёт один приказ.
 * Движок решает КОГДА; агент — ЧТО. Приказ пишется в дела/указы с initiative=ruler.
 */

import { newId } from './ids.js';
import { createLoreFact, chronicleEntries, formatCastForPrompt } from './models.js';
import {
  activeProcesses,
  canStartProcess,
  findDuplicateProcess,
  resolveLinkedStats,
  applyObjectiveSchedule,
  pausedProcesses,
  resumeProcess,
} from './processes.js';
import { estimateProcessDuration } from './durationJudge.js';
import { formatBoardForPrompt, isThreeActPlot } from './plotlines.js';
import { queueOrderRequest, listStandingOrders } from './orders.js';
import { ensureErrandForProcess, linkProcessToPlotline } from './plotEngine.js';
import { judgeProcessAlignment } from './plotAlign.js';
import { qualitativeStatsBrief, qualitativePopulation } from './stats.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

export function countTrailingUnansweredNews(dialogHistory = []) {
  let n = 0;
  for (let i = dialogHistory.length - 1; i >= 0; i -= 1) {
    const m = dialogHistory[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.kind === 'tick_news') n += 1;
  }
  return n;
}

export function stewardConfig(config) {
  const s = config?.tick?.steward || {};
  return {
    loseAfterLetters: Math.max(1, Math.round(Number(s.loseAfterLetters) ?? 2)),
    afterSilentMonths: Math.max(1, Math.round(Number(s.afterSilentMonths) ?? 3)),
  };
}

export function shouldRunSteward(domain, config) {
  const cfg = stewardConfig(config);
  const character = domain?.characters?.[0];
  const silent = countTrailingUnansweredNews(character?.dialogHistory || []);
  return { ok: silent >= cfg.afterSilentMonths, silent };
}

/** Одно письмо на полосу молчания: «куда ты делся», даже если окно в три месяца уже проскочили. */
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

function rememberFact(domain, { text, world, character, chronicleAdds }) {
  domain.lore = domain.lore || [];
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'fact', 'steward'],
    gameDateLabel: world?.gameDate?.label || null,
    tick: world?.tickIndex ?? null,
    author: `steward:${character?.name || 'ruler'}`,
  });
  domain.lore.push(fact);
  if (chronicleAdds) chronicleAdds.push(fact);
  return fact;
}

async function applyProcess(domain, args, { config, runtime, world, character, log, chronicleAdds }) {
  const slots = canStartProcess(domain, config);
  if (!slots.ok) {
    return { error: 'too_many_processes', message: `Уже ${slots.active}/${slots.max} дел.` };
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
    return { error: 'linked_stats_required', message: 'Нужен хотя бы один стат.' };
  }
  const action = {
    id: newId('act'),
    summary,
    detail,
    goal: String(args.goal || '').trim() || null,
    expectedMonths: 1,
    durationMonths: 1,
    monthsLeft: 1,
    monthsDone: 0,
    linkedStats: linked,
    onBehalfOf: character?.name || 'правитель',
    characterId: character?.id || null,
    characterName: character?.name || null,
    characterNote: args.note || null,
    hardDeadline: false,
    status: 'active',
    initiative: 'ruler',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  domain.state.pendingActions.push(action);
  const estimated = await estimateProcessDuration({
    config,
    runtime,
    domain,
    summary,
    detail,
    log,
  });
  applyObjectiveSchedule(action, estimated.months);
  let plot = args.plotId ? linkProcessToPlotline(domain, action.id, String(args.plotId)) : null;
  if (!plot) {
    plot = ensureErrandForProcess(domain, action, {
      tick: world?.tickIndex ?? null,
      config,
    }).plot;
  }
  action.plotlineId = plot?.id || null;
  if (plot && isThreeActPlot(plot)) {
    await judgeProcessAlignment({ runtime, domain, process: action, plot, log });
  }
  rememberFact(domain, {
    world,
    character,
    chronicleAdds,
    text: `Правитель ${character?.name || ''} сам, без воли покровителя, поручил: ${summary}.`,
  });
  return { action, plot };
}

function applyOrder(domain, text, { world, character }) {
  return queueOrderRequest(domain, {
    action: 'create',
    text,
    by: character?.name || 'правитель',
    initiative: 'ruler',
    tick: world?.tickIndex ?? null,
  });
}

/**
 * Один ход наместника в начале месяца, если покровитель молчит.
 * @returns {{ silent: number, act: object|null, chronicleAdds: object[] }}
 */
export async function runSteward({ config, runtime, domain, world, log: parentLog }) {
  const gate = shouldRunSteward(domain, config);
  if (!gate.ok) return { silent: gate.silent, act: null, chronicleAdds: [] };

  const character = domain.characters?.[0];
  if (!character) return { silent: gate.silent, act: null, chronicleAdds: [] };
  const chronicleAdds = [];

  const log = (parentLog || getLogger()).child({ scope: 'steward', domainId: domain.id });
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const tools = [
    {
      name: 'submit_steward_act',
      description:
        'Одно решение правителя, пока бог молчит. process — новое дело, standing_order — постоянный порядок, none — ничего не менять.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['none', 'process', 'standing_order', 'resume'] },
          summary: { type: 'string', description: 'Название дела, 1–8 слов' },
          detail: { type: 'string', description: 'Что именно поручено и кому' },
          goal: {
            type: 'string',
            description: 'Одной фразой: что считается достигнутой целью. Не обязательно.',
          },
          linkedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `1–3 из: ${statIds}`,
          },
          plotId: {
            type: 'string',
            description:
              'id истории без поручения, если дело про неё. Не подставляй соседнюю нить.',
          },
          processId: {
            type: 'string',
            description: 'Для resume — id дела на паузе.',
          },
          text: { type: 'string', description: 'Формулировка постоянного порядка' },
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
            character,
            log,
            chronicleAdds,
          });
          if (applied.error) return toolFail(applied.error, applied.message);
          draft.data = { kind: 'process', summary: applied.action.summary, id: applied.action.id };
          return { ok: true };
        }
        if (kind === 'resume') {
          const paused = pausedProcesses(domain, config);
          const raw = String(args.processId || args.summary || '').trim().toLowerCase();
          const action =
            paused.find((a) => a.id === args.processId) ||
            paused.find((a) => String(a.summary || '').toLowerCase().includes(raw));
          if (!action) return toolFail('not_paused', 'Нет такого дела на паузе.');
          const applied = resumeProcess(action, domain, config);
          if (!applied.ok) {
            return toolFail(
              applied.error,
              applied.error === 'too_many_processes'
                ? `Уже ${applied.active}/${applied.max} дел, слота нет.`
                : applied.error,
            );
          }
          rememberFact(domain, {
            world,
            character,
            chronicleAdds,
            text: `Правитель ${character?.name || ''} сам возобновил дело: ${action.summary}.`,
          });
          draft.data = { kind: 'resume', summary: action.summary, id: action.id };
          return { ok: true };
        }
        if (kind === 'standing_order') {
          const applied = applyOrder(domain, args.text, { world, character });
          if (applied.error) return toolFail(applied.error, applied.message);
          draft.data = { kind: 'standing_order', text: applied.request.text, id: applied.request.id };
          return { ok: true };
        }
        return toolFail('bad_action', 'action: none, process, resume или standing_order.');
      },
    },
  ];

  const recent = chronicleEntries(domain.lore)
    .slice(-6)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${e.text}`)
    .join('\n');
  const processes = activeProcesses(domain, config)
    .map((p) => `- ${p.summary} (ещё ~${p.monthsLeft} мес.${p.initiative === 'ruler' ? ', сам правитель' : ''})`)
    .join('\n');
  const orders = listStandingOrders(domain)
    .map((m) => `- ${m.text}${m.initiative === 'ruler' ? ' (сам правитель)' : ''}${m.pending ? ` [${m.pending}]` : ''}`)
    .join('\n');
  const openStories = (domain.plotlines || []).filter((p) => p.kind === 'story' && !(p.relatedProcessIds || []).length);

  await runtime.run({
    agentId: 'steward',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_steward_act' } },
    log,
    scene: 'steward',
    domainId: domain.id,
    extraSystem: `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}». Покровитель молчит.`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Покровитель молчит уже ${gate.silent} месяца. Письмо ему пишет другой — ты только одно поручение.`,
          'По сводке ниже заведи дело, объяви порядок — или ничего. Это ТВОЁ решение, не воля бога.',
          'Одно действие. Если город и так занят и ничего не горит — action=none.',
          'Дела на паузе можно возобновить (action=resume), если слот свободен.',
          pausedProcesses(domain, config).length
            ? `На паузе:\n${pausedProcesses(domain, config)
                .map((p) => `- [${p.id}] ${p.summary} (ещё ~${p.monthsLeft} мес.)`)
                .join('\n')}`
            : null,
          openStories.length
            ? `Истории без поручения (если действовать — plotId одной из них):\n${openStories
                .map((p) => `- [${p.id}] «${p.title}»: ${p.synopsis || ''}`)
                .join('\n')}`
            : null,
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
          'Постоянные порядки:',
          orders || '- (нет)',
          '',
          'Люди:',
          formatCastForPrompt(domain.lore, { limit: 12 }),
          '',
          'Недавняя хроника:',
          recent || '- (нет)',
          '',
          'Вызови submit_steward_act.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  log.info('steward.done', {
    silent: gate.silent,
    act: draft.data ? `${draft.data.kind}:${draft.data.summary || draft.data.text || 'none'}` : 'no_tool',
    preview: truncate(draft.data?.summary || draft.data?.text || '', 120),
  });
  return { silent: gate.silent, act: draft.data, chronicleAdds };
}
