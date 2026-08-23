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
  guessProcessDuration,
  resolveLinkedStats,
} from './processes.js';
import { formatBoardForPrompt } from './plotlines.js';
import { ensureErrandForProcess, linkProcessToPlotline } from './plotEngine.js';
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
  const after = Math.max(1, Math.round(Number(s.afterSilentMonths) || 2));
  return {
    afterSilentMonths: after,
    every: Math.max(1, Math.round(Number(s.every) || after)),
  };
}

export function shouldRunSteward(domain, config) {
  const cfg = stewardConfig(config);
  const character = domain?.characters?.[0];
  const silent = countTrailingUnansweredNews(character?.dialogHistory || []);
  if (silent < cfg.afterSilentMonths) return { ok: false, silent };
  if (silent % cfg.every !== 0) return { ok: false, silent };
  return { ok: true, silent };
}

function rememberFact(domain, { text, world, character }) {
  domain.lore = domain.lore || [];
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['fact', 'steward'],
    gameDateLabel: world?.gameDate?.label || null,
    tick: world?.tickIndex ?? null,
    author: `steward:${character?.name || 'ruler'}`,
  });
  domain.lore.push(fact);
  return fact;
}

function applyProcess(domain, args, { config, world, character }) {
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
  const asked = Math.max(1, Math.min(12, Math.round(Number(args.expectedMonths) || 1)));
  const duration = guessProcessDuration(summary, detail, asked);
  const action = {
    id: newId('act'),
    summary,
    detail,
    expectedMonths: duration,
    durationMonths: duration,
    monthsLeft: duration,
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
  let plot = args.plotId ? linkProcessToPlotline(domain, action.id, String(args.plotId)) : null;
  if (!plot) {
    plot = ensureErrandForProcess(domain, action, {
      tick: world?.tickIndex ?? null,
      config,
    }).plot;
  }
  action.plotlineId = plot?.id || null;
  rememberFact(domain, {
    world,
    character,
    text: `Правитель ${character?.name || ''} сам, без воли покровителя, поручил: ${summary}.`,
  });
  return { action, plot };
}

function applyOrder(domain, text, { world, character }) {
  const body = String(text || '').trim().slice(0, 400);
  if (body.length < 3) return { error: 'too_short', message: 'Слишком короткое правило.' };
  if (!domain.state.modifiers) domain.state.modifiers = [];
  const mod = {
    id: newId('mod'),
    text: body,
    kind: 'order',
    since: new Date().toISOString(),
    declaredTick: world?.tickIndex ?? null,
    updatedAt: new Date().toISOString(),
    by: character?.name || 'правитель',
    initiative: 'ruler',
  };
  domain.state.modifiers.push(mod);
  rememberFact(domain, {
    world,
    character,
    text: `Действующий указ города (сам правитель, без воли покровителя): ${body}`,
  });
  return { modifier: mod };
}

/**
 * Один ход наместника в начале месяца, если покровитель молчит.
 * @returns {{ silent: number, act: object|null }}
 */
export async function runSteward({ config, runtime, domain, world, log: parentLog }) {
  const gate = shouldRunSteward(domain, config);
  if (!gate.ok) return { silent: gate.silent, act: null };

  const character = domain.characters?.[0];
  if (!character) return { silent: gate.silent, act: null };

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
          action: { type: 'string', enum: ['none', 'process', 'standing_order'] },
          summary: { type: 'string', description: 'Название дела, 1–8 слов' },
          detail: { type: 'string', description: 'Что именно поручено и кому' },
          expectedMonths: { type: 'number', description: 'Срок 1–12' },
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
          const applied = applyProcess(domain, args, { config, world, character });
          if (applied.error) return toolFail(applied.error, applied.message);
          draft.data = { kind: 'process', summary: applied.action.summary, id: applied.action.id };
          return { ok: true };
        }
        if (kind === 'standing_order') {
          const applied = applyOrder(domain, args.text, { world, character });
          if (applied.error) return toolFail(applied.error, applied.message);
          draft.data = { kind: 'standing_order', text: applied.modifier.text, id: applied.modifier.id };
          return { ok: true };
        }
        return toolFail('bad_action', 'action: none, process или standing_order.');
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
  const orders = (domain.state?.modifiers || [])
    .map((m) => `- ${m.text}${m.initiative === 'ruler' ? ' (сам правитель)' : ''}`)
    .join('\n');
  const openStories = (domain.plotlines || []).filter((p) => p.kind !== 'errand' && !(p.relatedProcessIds || []).length);

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
          `Покровитель молчит уже ${gate.silent} месяца. Один ход: заведи дело, объяви порядок — или ничего.`,
          'Это ТВОЁ решение, не воля бога. Не приписывай приказ покровителю.',
          'Одно действие. Если город и так занят и ничего не горит — action=none.',
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
  return { silent: gate.silent, act: draft.data };
}
