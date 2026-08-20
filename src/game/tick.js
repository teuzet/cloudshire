import { newId } from './ids.js';
import { createLoreFact, loreToPromptText, advanceGameDate } from './models.js';
import { formatStatsForPrompt } from './stats.js';

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

export async function resolveDomainTick({ config, runtime, storage, domain, world }) {
  const working = structuredClone(domain);
  if (typeof working.population !== 'number') working.population = config.genesis.population.min;
  const chronicleAdds = [];
  let clearedPending = false;
  const eventTarget = pickEventCount(config);
  const activePending = (working.state.pendingActions || []).filter((a) => a.status === 'active');

  const tools = [
    {
      name: 'read_context',
      description: 'Контекст домена для резольва',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        cosmology: config.world.cosmology,
        gameDate: world.gameDate,
        name: working.name,
        rulerName: working.characters?.[0]?.name,
        description: working.description,
        stats: working.stats,
        statsGuide: formatStatsForPrompt(working.stats, config),
        population: working.population,
        milestones: working.milestones,
        stateEvents: working.state.events,
        pendingActionsPriority: activePending,
        loreText: loreToPromptText(working.lore),
      }),
    },
    {
      name: 'add_chronicle',
      description: 'Сухая запись хроники месяца (не fact). Сначала закрой все pending.',
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
        },
      },
      handler: async ({ text, importance, relatedPendingId }) => {
        const fact = createLoreFact({
          id: newId('lore'),
          text,
          tags: ['chronicle'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: 'resolver',
          importance: importance || 'minor',
        });
        if (relatedPendingId) fact.relatedPendingId = relatedPendingId;
        working.lore.push(fact);
        chronicleAdds.push(fact);
        return { ok: true, factId: fact.id, countThisTick: chronicleAdds.length };
      },
    },
    {
      name: 'set_state_events',
      description: 'Заменить текущие процессы состояния',
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
      name: 'adjust_stats',
      description: 'Скорректировать статы 0–100 умеренно',
      parameters: {
        type: 'object',
        required: ['stats'],
        properties: {
          stats: { type: 'object', additionalProperties: { type: 'number' } },
        },
      },
      handler: async ({ stats }) => {
        for (const [key, value] of Object.entries(stats || {})) {
          if (key in working.stats) working.stats[key] = clampStat(value);
        }
        return { ok: true, stats: working.stats };
      },
    },
    {
      name: 'adjust_population',
      description: 'Изменить население',
      parameters: {
        type: 'object',
        required: ['population'],
        properties: {
          population: { type: 'number' },
        },
      },
      handler: async ({ population }) => {
        working.population = clampPopulation(population, config);
        return { ok: true, population: working.population };
      },
    },
    {
      name: 'clear_pending_actions',
      description: 'Закрыть pending после резольва',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['clear_active', 'mark_resolved'],
            default: 'mark_resolved',
          },
        },
      },
      handler: async ({ mode = 'mark_resolved' }) => {
        if (mode === 'clear_active') {
          working.state.pendingActions = working.state.pendingActions.filter((a) => a.status !== 'active');
        } else {
          for (const a of working.state.pendingActions) {
            if (a.status === 'active') {
              a.status = 'resolved';
              a.resolvedTick = world.tickIndex;
              a.updatedAt = new Date().toISOString();
            }
          }
        }
        clearedPending = true;
        return { ok: true };
      },
    },
  ];

  const pendingBlock = activePending.length
    ? activePending.map((a) => `- [${a.id}] ${a.summary}: ${a.detail} (от ${a.onBehalfOf || a.characterName})`).join('\n')
    : '(нет активных pending)';

  const userPrompt = [
    `Резольв месяца для города «${working.name}» (${world.gameDate.label}).`,
    config.world.cosmology || '',
    '',
    'ПРИОРИТЕТ — закрыть КАЖДОЕ active pending явной записью хроники (relatedPendingId):',
    pendingBlock,
    '',
    `Затем добавь остальные события. Всего записей хроники около ${eventTarget} (включая исходы pending).`,
    'Это город на летающем острове, не королевство. Правитель уже есть — не выдумывай другого главу.',
    'Сухо. Затем state/stats/population при нужде и clear_pending_actions.',
    'Текстовый ответ: OK.',
  ].join('\n');

  await runtime.run({
    agentId: 'resolver',
    userMessages: [{ role: 'user', content: userPrompt }],
    tools,
    maxTurns: 16,
  });

  // Enforce: if pending existed but none related — append fallback outcomes
  if (activePending.length) {
    const covered = new Set(
      chronicleAdds.filter((c) => c.relatedPendingId).map((c) => c.relatedPendingId),
    );
    for (const action of activePending) {
      if (covered.has(action.id)) continue;
      const fact = createLoreFact({
        id: newId('lore'),
        text: `${world.gameDate.label}. По намерению «${action.summary}»: работы начаты / сдвинуты, полный итог ещё впереди.`,
        tags: ['chronicle'],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'resolver-pending-fallback',
        importance: 'major',
      });
      fact.relatedPendingId = action.id;
      working.lore.push(fact);
      chronicleAdds.push(fact);
    }
  }

  if (!clearedPending) {
    for (const a of working.state.pendingActions) {
      if (a.status === 'active') {
        a.status = 'resolved';
        a.resolvedTick = world.tickIndex;
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
      // Старые lost-домены пропускаем; win/lose на тике больше нет
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

    // Сбрасываем ошибочный lost с прошлых прогонов при желании играть дальше — нет, только wipe
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
