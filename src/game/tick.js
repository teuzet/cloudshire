import { newId } from './ids.js';
import {
  createLoreFact,
  loreToPromptText,
  recentChronicleText,
  advanceGameDate,
} from './models.js';
import { formatStatsForPrompt } from './stats.js';
import { getLogger } from '../log.js';

function clampStat(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampPopulation(n, config) {
  const min = 1000;
  const max = Math.max(config.genesis?.population?.max || 100000, 500000);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pickEventCount(config, rng = Math.random) {
  const { min = 3, max = 6 } = config.tick?.chronicleEvents || {};
  return min + Math.floor(rng() * (max - min + 1));
}

function maxStatDelta(config) {
  return Math.abs(config.tick?.maxStatDeltaPerEvent ?? 5);
}

function normalizePending(action) {
  if (action.durationMonths == null) {
    const text = `${action.summary || ''} ${action.detail || ''}`.toLowerCase();
    let guess = 1;
    if (/винодел|строи|храм|крепос|акаде|канал|верф|дворец|мануфакт/.test(text)) guess = 4;
    else if (/обучен|набор|кампан|жертв|праздн/.test(text)) guess = 2;
    action.durationMonths = guess;
  }
  action.durationMonths = Math.max(1, Math.min(12, Math.round(Number(action.durationMonths) || 1)));
  if (action.monthsDone == null) action.monthsDone = 0;
  return action;
}

/**
 * Apply per-event deltas (each key capped to ±maxDelta). Returns map of { from, to, delta }.
 */
function applyStatDeltas(stats, deltas, maxDelta) {
  const changes = {};
  for (const [key, raw] of Object.entries(deltas || {})) {
    if (!(key in stats)) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    const delta = Math.max(-maxDelta, Math.min(maxDelta, Math.round(n)));
    if (delta === 0) continue;
    const from = stats[key];
    const to = clampStat(from + delta);
    const applied = to - from;
    if (applied === 0) continue;
    stats[key] = to;
    changes[key] = { from, to, delta: applied };
  }
  return changes;
}

function descriptionBrief(domain, max = 2500) {
  const text = String(domain.description || '').trim();
  if (!text) {
    const aspects = domain.aspects || {};
    const joined = Object.entries(aspects)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
      .join('\n');
    return joined.slice(0, max) || '(нет описания)';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function resolveDomainTick({ config, runtime, storage, domain, world }) {
  const log = getLogger().child({ scope: 'resolver', domainId: domain.id, name: domain.name });
  const working = structuredClone(domain);
  if (typeof working.population !== 'number') working.population = config.genesis.population.min;
  const chronicleAdds = [];
  const advancedIds = new Set();
  const eventTarget = pickEventCount(config);
  const activePending = (working.state.pendingActions || [])
    .filter((a) => a.status === 'active')
    .map(normalizePending);
  const deltaCap = maxStatDelta(config);

  const tools = [
    {
      name: 'read_context',
      description: 'Контекст домена: космология, описание, state, статы, pending, недавняя хроника',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        cosmology: config.world.cosmology,
        gameDate: world.gameDate,
        name: working.name,
        rulerName: working.characters?.[0]?.name,
        rulerTitle: working.characters?.[0]?.title,
        description: descriptionBrief(working),
        stats: working.stats,
        statsGuide: formatStatsForPrompt(working.stats, config),
        population: working.population,
        milestones: working.milestones,
        stateEvents: working.state.events,
        pendingActionsPriority: activePending,
        recentChronicle: recentChronicleText(working.lore, 14),
        fullLore: loreToPromptText(working.lore),
        rules: {
          maxStatDeltaPerEvent: deltaCap,
          note: 'Статы через statDeltas в add_chronicle. Pending: chronicle + advance_pending; не закрывай длинные стройки за 1 месяц.',
        },
      }),
    },
    {
      name: 'add_chronicle',
      description:
        'Запись хроники месяца. Опционально statDeltas (например {faith: 3, stability: -2}), каждый ≤ ±cap. Сначала pending.',
      parameters: {
        type: 'object',
        required: ['text', 'importance'],
        properties: {
          text: { type: 'string' },
          importance: { type: 'string', enum: ['minor', 'major', 'critical'] },
          relatedPendingId: {
            type: 'string',
            description: 'Если запись — исход конкретного pending',
          },
          statDeltas: {
            type: 'object',
            additionalProperties: { type: 'number' },
            description: `Дельты статов, каждый ключ в [−${deltaCap}, +${deltaCap}]`,
          },
        },
      },
      handler: async ({ text, importance, relatedPendingId, statDeltas }) => {
        const statChanges = applyStatDeltas(working.stats, statDeltas, deltaCap);
        const fact = createLoreFact({
          id: newId('lore'),
          text,
          tags: ['chronicle'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: 'resolver',
          importance: importance || 'minor',
          relatedPendingId: relatedPendingId || null,
          statChanges: Object.keys(statChanges).length ? statChanges : null,
        });
        working.lore.push(fact);
        chronicleAdds.push(fact);
        log.info('resolver.chronicle', {
          factId: fact.id,
          importance: fact.importance,
          relatedPendingId: fact.relatedPendingId || null,
          statChanges,
          textPreview: String(text).slice(0, 200),
        });
        return {
          ok: true,
          factId: fact.id,
          countThisTick: chronicleAdds.length,
          statChanges,
          stats: working.stats,
        };
      },
    },
    {
      name: 'set_state_events',
      description: 'Заменить текущие процессы состояния (ongoing)',
      parameters: {
        type: 'object',
        required: ['events'],
        properties: {
          events: { type: 'array', items: { type: 'string' } },
        },
      },
      handler: async ({ events }) => {
        working.state.events = (events || []).map((text) => ({
          id: newId('ev'),
          text,
          tick: world.tickIndex,
          at: new Date().toISOString(),
        }));
        return { ok: true, count: working.state.events.length };
      },
    },
    {
      name: 'adjust_population',
      description: 'Изменить население умеренно (абсолютное значение)',
      parameters: {
        type: 'object',
        required: ['population'],
        properties: {
          population: { type: 'number' },
        },
      },
      handler: async ({ population }) => {
        const from = working.population;
        working.population = clampPopulation(population, config);
        return { ok: true, from, population: working.population };
      },
    },
    {
      name: 'advance_pending',
      description:
        'Продвинуть pending на месяцы (обычно 1). complete=true только при реальном завершении или исчерпании срока. Крупные стройки не закрывай за один тик без причины.',
      parameters: {
        type: 'object',
        required: ['actionId'],
        properties: {
          actionId: { type: 'string' },
          monthsAdvance: {
            type: 'number',
            description: 'Сколько месяцев прогресса добавить (обычно 1)',
            default: 1,
          },
          complete: {
            type: 'boolean',
            description: 'Принудительно завершить сейчас (успех/провал уже в хронике)',
          },
          failed: {
            type: 'boolean',
            description: 'Завершить как провал',
          },
        },
      },
      handler: async ({ actionId, monthsAdvance = 1, complete = false, failed = false }) => {
        const action = working.state.pendingActions.find((a) => a.id === actionId && a.status === 'active');
        if (!action) return { ok: false, error: 'pending не найден' };
        normalizePending(action);
        const step = Math.max(0, Math.min(6, Math.round(Number(monthsAdvance) || 1)));
        action.monthsDone = Math.min(
          action.durationMonths,
          (action.monthsDone || 0) + step,
        );
        action.updatedAt = new Date().toISOString();
        const finished =
          Boolean(failed) ||
          Boolean(complete) ||
          action.monthsDone >= action.durationMonths;
        if (finished) {
          action.status = failed ? 'failed' : 'resolved';
          action.resolvedTick = world.tickIndex;
        }
        advancedIds.add(actionId);
        log.info('resolver.advance_pending', {
          actionId,
          monthsDone: action.monthsDone,
          durationMonths: action.durationMonths,
          status: action.status,
        });
        return {
          ok: true,
          action: {
            id: action.id,
            summary: action.summary,
            monthsDone: action.monthsDone,
            durationMonths: action.durationMonths,
            status: action.status,
            remaining: Math.max(0, action.durationMonths - action.monthsDone),
          },
          finished,
        };
      },
    },
  ];

  const pendingBlock = activePending.length
    ? activePending
        .map((a) => {
          const rem = Math.max(0, (a.durationMonths || 1) - (a.monthsDone || 0));
          return `- [${a.id}] ${a.summary}: ${a.detail} | срок ${a.monthsDone || 0}/${a.durationMonths} мес. (осталось ~${rem}) (от ${a.onBehalfOf || a.characterName})`;
        })
        .join('\n')
    : '(нет активных pending)';

  const userPrompt = [
    `Резольв месяца для города «${working.name}» (${world.gameDate.label}).`,
    'Сначала read_context. Учти описание, state и недавнюю хронику.',
    '',
    'ПРИОРИТЕТ — для КАЖДОГО active pending: add_chronicle (relatedPendingId) + advance_pending:',
    pendingBlock,
    '',
    `Затем другие события. Всего записей хроники около ${eventTarget} (включая прогресс pending).`,
    `Статы — только statDeltas в add_chronicle, каждый ключ ≤ ±${deltaCap} за запись.`,
    'Не завершай многомесячную стройку за один тик без сильной причины.',
    'Интересные исходы; не сглаживай жёсткие приказы. Текст: OK.',
  ].join('\n');

  await runtime.run({
    agentId: 'resolver',
    userMessages: [{ role: 'user', content: userPrompt }],
    tools,
    maxTurns: 16,
    toolChoice: { type: 'function', function: { name: 'read_context' } },
    log,
  });

  if (activePending.length) {
    const covered = new Set(
      chronicleAdds.filter((c) => c.relatedPendingId).map((c) => c.relatedPendingId),
    );
    for (const action of activePending) {
      const live = working.state.pendingActions.find((a) => a.id === action.id);
      if (!live || live.status !== 'active') continue;
      normalizePending(live);

      if (!covered.has(action.id)) {
        const rem = Math.max(0, live.durationMonths - (live.monthsDone || 0) - 1);
        const fact = createLoreFact({
          id: newId('lore'),
          text:
            rem > 0
              ? `${world.gameDate.label}. По намерению «${action.summary}»: работы сдвинулись, до завершения ещё около ${rem} мес.`
              : `${world.gameDate.label}. По намерению «${action.summary}»: работы близки к итогу.`,
          tags: ['chronicle'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: 'resolver-pending-fallback',
          importance: 'major',
          relatedPendingId: action.id,
        });
        working.lore.push(fact);
        chronicleAdds.push(fact);
        log.warn('resolver.pending_fallback', { actionId: action.id, summary: action.summary });
      }

      if (!advancedIds.has(action.id)) {
        live.monthsDone = Math.min(live.durationMonths, (live.monthsDone || 0) + 1);
        live.updatedAt = new Date().toISOString();
        if (live.monthsDone >= live.durationMonths) {
          live.status = 'resolved';
          live.resolvedTick = world.tickIndex;
        }
        advancedIds.add(action.id);
        log.warn('resolver.advance_fallback', {
          actionId: action.id,
          monthsDone: live.monthsDone,
          status: live.status,
        });
      }
    }
  }

  if (!chronicleAdds.length) {
    const fallback = createLoreFact({
      id: newId('lore'),
      text: `${world.gameDate.label}. Существенных перемен в «${working.name}» не зафиксировано.`,
      tags: ['chronicle'],
      gameDateLabel: world.gameDate.label,
      tick: world.tickIndex,
      author: 'resolver-fallback',
      importance: 'minor',
    });
    working.lore.push(fallback);
    chronicleAdds.push(fallback);
  }

  working.lastTickAt = new Date().toISOString();
  await storage.saveDomain(working);

  log.info('resolver.done', {
    chronicleCount: chronicleAdds.length,
    withStats: chronicleAdds.filter((c) => c.statChanges).length,
    stats: working.stats,
  });

  return {
    domain: working,
    chronicleAdds,
  };
}

export async function runWorldTick({ config, runtime, storage, app }) {
  const world = await storage.getWorld();
  advanceGameDate(world);
  await storage.saveWorld(world);

  const domains = await storage.listDomains();
  const results = [];

  for (const domain of domains) {
    if (domain.status && domain.status !== 'playing') {
      results.push({ domainId: domain.id, skipped: true, reason: domain.status });
      continue;
    }

    const resolved = await resolveDomainTick({
      config,
      runtime,
      storage,
      domain,
      world,
    });

    const news = await app.narrateTickNews(resolved.domain, resolved.chronicleAdds, world.gameDate);
    await app.persistDialog(resolved.domain, 'assistant', news);
    await app.emitOutbound(resolved.domain.ownerUserId, news, {
      agent: 'ruler',
      domainId: resolved.domain.id,
      kind: 'tick_news',
    });

    results.push({
      domainId: resolved.domain.id,
      name: resolved.domain.name,
      chronicleCount: resolved.chronicleAdds.length,
      status: resolved.domain.status,
      news,
      statChanges: resolved.chronicleAdds
        .filter((c) => c.statChanges)
        .map((c) => ({ id: c.id, changes: c.statChanges })),
    });
  }

  return {
    world: {
      id: world.id,
      tickIndex: world.tickIndex,
      gameDate: world.gameDate,
    },
    results,
  };
}
