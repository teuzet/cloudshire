import { newId } from './ids.js';
import {
  createLoreFact,
  advanceGameDate,
  filterChronicleForDomain,
  normalizeDomain,
} from './models.js';
import { formatChroniclePromptBlock, refreshChronicleDigest } from './memory.js';
import { formatStatsForPrompt, statDeltaLimits, applyStatDeltas } from './stats.js';
import {
  processConfluxApproachingPhase,
  advanceDockedConfluxes,
  maybeMatchmakeConfluxes,
  advanceConfluxLifetimeCounters,
} from './conflux.js';
import { resolveConfluxTick } from './confluxResolve.js';
import {
  normalizePlotlines,
  heatPlotlines,
  rollBreakthroughs,
  clearBreakthroughFlags,
  formatPlotlinesForPrompt,
  formatBreakthroughMandate,
  plotlinesConfig,
  rollPlotSpawn,
  listClosureCandidates,
  grantAttentionToIds,
} from './plotlines.js';
import {
  normalizeDomainProcesses,
  normalizeProcess,
  activeProcesses,
  rollAllProcessAdvances,
  applyProcessAdvance,
  formatProcessLine,
  formatProcessRollsForPrompt,
  formatActiveProcessesForAgent,
} from './processes.js';
import { runDirector, runConfluxDirector } from './director.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function clampPopulation(n, config) {
  const min = 1000;
  const max = Math.max(config.genesis?.population?.max || 100000, 500000);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pickEventCount(config, rng = Math.random) {
  const { min = 2, max = 4 } = config.tick?.chronicleEvents || {};
  return min + Math.floor(rng() * (max - min + 1));
}

function sideEventsMax(config) {
  const n = Number(config.tick?.sideEventsMax);
  return Number.isFinite(n) && n >= 0 ? Math.min(4, Math.round(n)) : 2;
}

function typicalStatDelta(config) {
  return statDeltaLimits(config).typicalMax;
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

export async function resolveDomainTick({
  config,
  runtime,
  storage,
  domain,
  world,
  breakthroughs = [],
}) {
  const log = getLogger().child({ scope: 'resolver', domainId: domain.id, name: domain.name });
  const working = structuredClone(domain);
  normalizeDomain(working);
  normalizePlotlines(working);
  normalizeDomainProcesses(working, config);
  if (typeof working.population !== 'number') working.population = config.genesis.population.min;
  const chronicleAdds = [];
  const advancedIds = new Set();
  const eventTarget = pickEventCount(config);
  const processList = activeProcesses(working, config);
  const processRolls = rollAllProcessAdvances(working, config);
  const processRollById = Object.fromEntries(processRolls.map((r) => [r.processId, r]));
  const deltaTypical = typicalStatDelta(config);
  const breakthroughList =
    breakthroughs.length > 0
      ? breakthroughs
      : (working.plotlines || []).filter((p) => p.breakthroughThisTick);

  log.info('processes.rolls', {
    rolls: processRolls.map((r) => ({
      id: r.processId,
      summary: r.summary,
      roll: r.roll,
      avg: r.avg,
      advance: r.advance,
      kind: r.kind,
    })),
  });

  if (!working.state) working.state = { events: [], modifiers: [], pendingActions: [] };
  if (!Array.isArray(working.state.modifiers)) working.state.modifiers = [];
  if (!Array.isArray(working.state.events)) working.state.events = [];

  const tools = [
    {
      name: 'read_context',
      description: 'Контекст домена: космология, описание, state, статы, процессы, плотлайны, хроника',
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
        stateEvents: working.state.events,
        stateModifiers: working.state.modifiers,
        processes: processList.map((p) => ({
          id: p.id,
          summary: p.summary,
          detail: p.detail,
          monthsLeft: p.monthsLeft,
          expectedMonths: p.expectedMonths,
          linkedStats: p.linkedStats,
        })),
        processRollsThisTick: processRolls,
        plotlines: formatPlotlinesForPrompt(working, world.tickIndex),
        breakthroughsThisTick: breakthroughList.map((p) => ({
          id: p.id,
          title: p.title,
          summary: p.summary,
          relatedPendingIds: p.relatedPendingIds || [],
        })),
        chronicle: formatChroniclePromptBlock(working, config),
        rules: {
          typicalStatDelta: deltaTypical,
          note:
            `Статы через statDeltas: обычно ±1…${deltaTypical}; при катастрофе — любая величина (итог 0–100). ` +
            'ПРОЦЕССЫ: add_chronicle(relatedPendingId) + advance_process(advance из processRollsThisTick). ' +
            'Если хроника говорит «готово/сорвано» — complete/cancel в том же тике. ' +
            'ЗАСТОЙ(0)/РЫВОК(2) обязательно обыграй. cancel_process если сорвано. ' +
            'ПРОРЫВЫ плотлайнов — первыми; связанные процессы прорыва затронь. Постоянные итоги → upsert_modifier. ' +
            'Полный лор не приложен — опирайся на chronicle (digest+recent), описание и state.',
        },
      }),
    },
    {
      name: 'add_chronicle',
      description:
        `Запись хроники. Сначала процессы (особенно застой/рывок). statDeltas обычно ≤±${deltaTypical}.`,
      parameters: {
        type: 'object',
        required: ['text', 'importance'],
        properties: {
          text: { type: 'string' },
          importance: { type: 'string', enum: ['minor', 'major', 'critical'] },
          relatedPendingId: {
            type: 'string',
            description: 'Id процесса',
          },
          relatedPlotlineIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Опционально: id плотлайнов, которые это событие явно продолжает (не обязательно на каждую запись)',
          },
          statDeltas: {
            type: 'object',
            additionalProperties: { type: 'number' },
            description: `Дельты статов; типично ±${deltaTypical}`,
          },
        },
      },
      handler: async ({ text, importance, relatedPendingId, relatedPlotlineIds, statDeltas }) => {
        const plotCfg = plotlinesConfig(config);
        const statChanges = applyStatDeltas(working.stats, statDeltas);
        const fact = createLoreFact({
          id: newId('lore'),
          text,
          tags: ['chronicle'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: 'resolver',
          importance: importance || 'minor',
          relatedPendingId: relatedPendingId || null,
          relatedPlotlineIds: relatedPlotlineIds || null,
          statChanges: Object.keys(statChanges).length ? statChanges : null,
        });
        working.lore.push(fact);
        chronicleAdds.push(fact);
        const att = grantAttentionToIds(
          working,
          fact.relatedPlotlineIds,
          plotCfg.attention.chronicleLink,
        );
        log.info('resolver.chronicle', {
          factId: fact.id,
          importance: fact.importance,
          relatedPendingId: fact.relatedPendingId || null,
          relatedPlotlineIds: fact.relatedPlotlineIds || null,
          attentionGranted: att,
          statChanges,
          textPreview: String(text).slice(0, 200),
        });
        return {
          ok: true,
          factId: fact.id,
          countThisTick: chronicleAdds.length,
          statChanges,
          stats: working.stats,
          attentionGranted: att,
        };
      },
    },
    {
      name: 'set_state_events',
      description:
        'Заменить ВРЕМЕННЫЕ процессы state.events (бунт, фестиваль, осада, нехватка…). Не для постоянных порядков.',
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
        log.info('resolver.set_state_events', { count: working.state.events.length });
        return { ok: true, count: working.state.events.length };
      },
    },
    {
      name: 'upsert_modifier',
      description:
        'Добавить/обновить ВАЖНЫЙ постоянный модификатор state.modifiers (институт, установленный порядок, хроническое условие). ' +
        'Пример: установленный порядок или хроническое условие. Мелочи — только хроника.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          id: {
            type: 'string',
            description: 'Если обновляешь существующий — передай его id',
          },
          text: { type: 'string', description: 'Краткая формулировка постоянного условия' },
          kind: {
            type: 'string',
            enum: ['institution', 'order', 'condition', 'other'],
            description: 'Тип модификатора',
          },
        },
      },
      handler: async ({ id, text, kind }) => {
        const body = String(text || '').trim();
        if (!body) {
          return toolFail(
            'text_required',
            'text пуст. Передай краткую формулировку постоянного условия и вызови upsert_modifier снова.',
          );
        }
        const list = working.state.modifiers;
        let mod = id ? list.find((m) => m.id === id) : null;
        if (!mod) {
          mod = {
            id: id || newId('mod'),
            text: body,
            kind: kind || 'other',
            sinceTick: world.tickIndex,
            updatedTick: world.tickIndex,
            at: new Date().toISOString(),
          };
          list.push(mod);
          log.info('resolver.modifier.add', { id: mod.id, text: body.slice(0, 160) });
          return { ok: true, created: true, modifier: mod };
        }
        mod.text = body;
        if (kind) mod.kind = kind;
        mod.updatedTick = world.tickIndex;
        mod.at = new Date().toISOString();
        log.info('resolver.modifier.update', { id: mod.id, text: body.slice(0, 160) });
        return { ok: true, created: false, modifier: mod };
      },
    },
    {
      name: 'remove_modifier',
      description: 'Убрать постоянный модификатор, если он больше не действует',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      handler: async ({ id }) => {
        const before = working.state.modifiers.length;
        working.state.modifiers = working.state.modifiers.filter((m) => m.id !== id);
        const removed = before !== working.state.modifiers.length;
        log.info('resolver.modifier.remove', { id, removed });
        if (!removed) {
          const ids = working.state.modifiers.map((m) => m.id).join(', ') || '(пусто)';
          return toolFail(
            'modifier_not_found',
            `Модификатор id=${id} не найден. Существующие: ${ids}. Проверь id из read_context.`,
          );
        }
        return { ok: true, removed: true };
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
      name: 'advance_process',
      description:
        'Продвинуть процесс по броску тика (advance из processRollsThisTick). complete=true только при реальном завершении.',
      parameters: {
        type: 'object',
        required: ['processId'],
        properties: {
          processId: { type: 'string' },
          advance: {
            type: 'number',
            description: '0/1/2 из броска; если не указать — из processRollsThisTick',
          },
          complete: { type: 'boolean', description: 'Принудительно завершить (успех уже в хронике)' },
          failed: { type: 'boolean', description: 'Завершить как провал' },
        },
      },
      handler: async ({ processId, advance, complete = false, failed = false }) => {
        const action = working.state.pendingActions.find((a) => a.id === processId && a.status === 'active');
        if (!action) {
          return toolFail(
            'process_not_found',
            `processId=${processId} не найден среди active. Возьми id из списка:\n` +
              formatActiveProcessesForAgent(working, config),
          );
        }
        normalizeProcess(action, config);
        const rolled = processRollById[processId];
        const step =
          advance != null
            ? Math.max(0, Math.min(6, Math.round(Number(advance))))
            : rolled
              ? rolled.advance
              : 1;
        const { finished, monthsLeft } = applyProcessAdvance(action, step, {
          complete,
          failed,
          tick: world.tickIndex,
        });
        advancedIds.add(processId);
        log.info('resolver.advance_process', {
          processId,
          step,
          monthsLeft,
          status: action.status,
          roll: rolled || null,
        });
        return {
          ok: true,
          process: {
            id: action.id,
            summary: action.summary,
            monthsLeft: action.monthsLeft,
            expectedMonths: action.expectedMonths,
            linkedStats: action.linkedStats,
            status: action.status,
          },
          finished,
          roll: rolled || null,
        };
      },
    },
    {
      name: 'cancel_process',
      description: 'Отменить процесс (сорвано/разрушено). Вместе с add_chronicle о причине.',
      parameters: {
        type: 'object',
        required: ['processId', 'reason'],
        properties: {
          processId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ processId, reason }) => {
        const action = working.state.pendingActions.find(
          (a) => a.id === processId && a.status === 'active',
        );
        if (!action) {
          return toolFail(
            'process_not_found',
            `processId=${processId} не найден среди active. Возьми id из списка:\n` +
              formatActiveProcessesForAgent(working, config),
          );
        }
        action.status = 'cancelled';
        action.cancelReason = String(reason || '').trim() || 'сорвано';
        action.updatedAt = new Date().toISOString();
        action.resolvedTick = world.tickIndex;
        advancedIds.add(processId);
        log.info('resolver.cancel_process', {
          processId,
          reason: action.cancelReason,
          summary: action.summary,
        });
        return { ok: true, process: { id: action.id, summary: action.summary, status: action.status } };
      },
    },
  ];

  const processBlock = processList.length
    ? processList.map((p) => formatProcessLine(p, config)).join('\n')
    : '(нет активных процессов)';

  const breakthroughBlock = formatBreakthroughMandate(breakthroughList, working);

  const sideMax = sideEventsMax(config);
  const userPrompt = [
    `Резольв месяца для города «${working.name}» (${world.gameDate.label}).`,
    'Сначала read_context. Учти описание, state, процессы, плотлайны и хронику.',
    '',
    breakthroughBlock,
    breakthroughBlock ? '' : null,
    'ПРИОРИТЕТ — для КАЖДОГО active процесса: add_chronicle (relatedPendingId) + advance_process',
    'ИЛИ cancel_process, если сорвано (с хроникой). Броски:',
    formatProcessRollsForPrompt(processRolls),
    '',
    'Процессы:',
    processBlock,
    '',
    `Затем не больше ${sideMax} побочных событий (бюджет месяца ~${eventTarget} записей вместе с процессами).`,
    'Если в хронике процесс «завершён/построен/окончен» — complete=true в том же тике.',
    `Статы — только statDeltas: обычно ≤±${deltaTypical}; при катастрофе — без потолка.`,
    'State: временное → set_state_events; постоянное важное → upsert_modifier.',
    'Будь смелым. Не завершай многомесячный процесс без причины/броска. Текст: OK.',
  ]
    .filter((line) => line != null)
    .join('\n');

  await runtime.run({
    agentId: 'resolver',
    userMessages: [{ role: 'user', content: userPrompt }],
    tools,
    maxTurns: 16,
    toolChoice: { type: 'function', function: { name: 'read_context' } },
    log,
    scene: 'tick_resolve',
    domainId: working.id,
  });

  if (processList.length) {
    const covered = new Set(
      chronicleAdds.filter((c) => c.relatedPendingId).map((c) => c.relatedPendingId),
    );
    for (const action of processList) {
      const live = working.state.pendingActions.find((a) => a.id === action.id);
      if (!live || live.status !== 'active') continue;
      normalizeProcess(live, config);
      const rolled = processRollById[action.id] || { advance: 1, kind: 'normal', unusual: false };

      if (!covered.has(action.id)) {
        const leftAfter = Math.max(0, live.monthsLeft - rolled.advance);
        let text;
        if (rolled.kind === 'stall') {
          text = `${world.gameDate.label}. По делу «${action.summary}»: месяц ушёл впустую — задержки и срывы, почти без сдвига.`;
        } else if (rolled.kind === 'surge') {
          text =
            leftAfter > 0
              ? `${world.gameDate.label}. По делу «${action.summary}»: неожиданный рывок, срок заметно сократился (ещё ~${leftAfter} мес.).`
              : `${world.gameDate.label}. По делу «${action.summary}»: рывок довёл работу почти до конца.`;
        } else {
          text =
            leftAfter > 0
              ? `${world.gameDate.label}. По делу «${action.summary}»: обычный ход работ, до завершения ещё около ${leftAfter} мес.`
              : `${world.gameDate.label}. По делу «${action.summary}»: работы близки к итогу.`;
        }
        const fact = createLoreFact({
          id: newId('lore'),
          text,
          tags: ['chronicle'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: 'resolver-process-fallback',
          importance: rolled.unusual ? 'major' : 'minor',
          relatedPendingId: action.id,
        });
        working.lore.push(fact);
        chronicleAdds.push(fact);
        log.warn('resolver.process_fallback', {
          processId: action.id,
          summary: action.summary,
          kind: rolled.kind,
        });
      }

      if (!advancedIds.has(action.id)) {
        applyProcessAdvance(live, rolled.advance, { tick: world.tickIndex });
        log.info('resolver.process_auto_advance', {
          processId: action.id,
          advance: rolled.advance,
          monthsLeft: live.monthsLeft,
          status: live.status,
        });
      }
    }
  }

  refreshChronicleDigest(working, config);

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
  app?.beginWorldTick?.();
  try {
    return await runWorldTickInner({ config, runtime, storage, app });
  } finally {
    app?.endWorldTick?.();
  }
}

async function runWorldTickInner({ config, runtime, storage, app }) {
  const world = await storage.getWorld();
  advanceGameDate(world);
  await storage.saveWorld(world);

  const matchmake = await maybeMatchmakeConfluxes({ config, storage, world });
  const confluxPhase = await processConfluxApproachingPhase({
    config,
    runtime,
    storage,
    world,
  });
  // После стыка/прелюдии: docked = конфлюкс, approaching+solo = соло (~50/50 цель).
  await advanceConfluxLifetimeCounters({ storage, world });

  const domains = await storage.listDomains();
  const results = [];
  const handled = new Set();
  const confluxNotes = [...(matchmake.notes || []), ...(confluxPhase.notes || [])];
  const plotCfg = plotlinesConfig(config);

  // Docked pairs — параллельно по разным conflux
  const pairBatches = await Promise.all(
    (confluxPhase.dockedConfluxes || []).map(async (conflux) => {
      const preludeAddsByDomain = {};
      const breakthroughsByDomain = {};
      const spawnByDomain = {};
      for (const id of conflux.domainIds || []) {
        preludeAddsByDomain[id] = confluxPhase.chronicleAddsByDomain.get(id) || [];
        const d = await storage.getDomain(id);
        if (!d) continue;
        normalizeDomain(d);
        if (plotCfg.enabled) {
          heatPlotlines(d, plotCfg.heatPerTick, plotCfg);
          breakthroughsByDomain[id] = rollBreakthroughs(d, Math.random, plotCfg);
          spawnByDomain[id] = rollPlotSpawn(d, plotCfg, Math.random, config);
          getLogger().info('plotlines.roll', {
            domainId: id,
            name: d.name,
            heat: plotCfg.heatPerTick,
            breakthroughs: breakthroughsByDomain[id].map((p) => p.title),
            spawn: {
              hit: spawnByDomain[id].hit,
              chance: spawnByDomain[id].chance,
              seeds: spawnByDomain[id].seedText,
            },
            board: formatPlotlinesForPrompt(d, world.tickIndex),
          });
        } else {
          breakthroughsByDomain[id] = [];
        }
        await storage.saveDomain(d);
      }

      const resolved = await resolveConfluxTick({
        config,
        runtime,
        storage,
        conflux,
        world,
        preludeAddsByDomain,
        breakthroughsByDomain,
      });
      return { conflux, resolved, spawnByDomain };
    }),
  );

  const advanced = await advanceDockedConfluxes(
    { storage, runtime, world },
    confluxPhase.dockedConfluxes,
  );
  confluxNotes.push(...(advanced.notes || []));

  const pairResults = await Promise.all(
    pairBatches.map(async ({ conflux, resolved, spawnByDomain }) => {
      const chronicleByDomain = {};
      for (const domain of resolved.domains) {
        handled.add(domain.id);
        chronicleByDomain[domain.id] = resolved.newsChronicleByDomain[domain.id] || [];
      }

      if (plotCfg.enabled) {
        const directorMetaByDomain = {};
        for (const domain of resolved.domains) {
          directorMetaByDomain[domain.id] = {
            spawn: spawnByDomain?.[domain.id] || null,
            closureCandidates: listClosureCandidates(domain, world.tickIndex, plotCfg),
          };
        }
        await runConfluxDirector({
          config,
          runtime,
          domains: resolved.domains,
          world,
          chronicleByDomain,
          directorMetaByDomain,
          conflux,
        });
      }

      const batchResults = [];
      for (const domain of resolved.domains) {
        clearBreakthroughFlags(domain, world.tickIndex);
        await storage.saveDomain(domain);

        const newsBase = chronicleByDomain[domain.id] || [];
        const undockAdds = advanced.undockAddsByDomain?.get(domain.id) || [];
        const newsAdds = filterChronicleForDomain([...newsBase, ...undockAdds], domain.id);
        const partnerId = (conflux.domainIds || []).find((id) => id !== domain.id);
        const partnerName =
          resolved.domains.find((d) => d.id === partnerId)?.name || null;
        const news = await app.narrateTickNews(domain, newsAdds, world.gameDate, {
          undock: undockAdds.length > 0,
          partnerName,
        });
        await app.persistDialog(domain, 'assistant', news, { kind: 'tick_news' });
        await app.emitOutbound(domain.ownerUserId, news, {
          agent: 'ruler',
          domainId: domain.id,
          kind: 'tick_news',
        });

        batchResults.push({
          domainId: domain.id,
          name: domain.name,
          chronicleCount: newsAdds.length,
          status: domain.status,
          inConfluxDocked: undockAdds.length === 0,
          confluxEnded: undockAdds.length > 0,
          confluxId: conflux.id,
          plotlines: (domain.plotlines || []).map((p) => ({
            id: p.id,
            title: p.title,
            temperature: p.temperature,
          })),
          news,
          statChanges: newsAdds
            .filter((c) => c.statChanges)
            .map((c) => ({ id: c.id, changes: c.statChanges })),
        });
      }
      return batchResults;
    }),
  );
  for (const batch of pairResults) results.push(...batch);

  // Solo — параллельно по доменам
  const soloDomains = domains.filter(
    (d) => !handled.has(d.id) && (!d.status || d.status === 'playing'),
  );
  for (const domain of domains) {
    if (handled.has(domain.id)) continue;
    if (domain.status && domain.status !== 'playing') {
      results.push({ domainId: domain.id, skipped: true, reason: domain.status });
    }
  }

  const soloResults = await Promise.all(
    soloDomains.map(async (domain) => {
      normalizeDomain(domain);
      let breakthroughs = [];
      let directorMeta = null;
      if (plotCfg.enabled) {
        heatPlotlines(domain, plotCfg.heatPerTick, plotCfg);
        breakthroughs = rollBreakthroughs(domain, Math.random, plotCfg);
        const spawn = rollPlotSpawn(domain, plotCfg, Math.random, config);
        directorMeta = {
          spawn,
          closureCandidates: listClosureCandidates(domain, world.tickIndex, plotCfg),
        };
        getLogger().info('plotlines.roll', {
          domainId: domain.id,
          name: domain.name,
          heat: plotCfg.heatPerTick,
          breakthroughs: breakthroughs.map((p) => p.title),
          spawn: { hit: spawn.hit, chance: spawn.chance, seeds: spawn.seedText },
          board: formatPlotlinesForPrompt(domain, world.tickIndex),
        });
      }

      const resolved = await resolveDomainTick({
        config,
        runtime,
        storage,
        domain,
        world,
        breakthroughs,
      });

      if (plotCfg.enabled) {
        await runDirector({
          config,
          runtime,
          domain: resolved.domain,
          world,
          chronicleAdds: resolved.chronicleAdds,
          directorMeta: {
            spawn: directorMeta?.spawn || null,
            closureCandidates: listClosureCandidates(
              resolved.domain,
              world.tickIndex,
              plotCfg,
            ),
          },
        });
      }
      clearBreakthroughFlags(resolved.domain, world.tickIndex);
      await storage.saveDomain(resolved.domain);

      const prelude = confluxPhase.chronicleAddsByDomain.get(domain.id) || [];
      const newsAdds = filterChronicleForDomain(
        [...prelude, ...resolved.chronicleAdds],
        domain.id,
      );
      const news = await app.narrateTickNews(resolved.domain, newsAdds, world.gameDate);
      await app.persistDialog(resolved.domain, 'assistant', news, { kind: 'tick_news' });
      await app.emitOutbound(resolved.domain.ownerUserId, news, {
        agent: 'ruler',
        domainId: resolved.domain.id,
        kind: 'tick_news',
      });

      return {
        domainId: resolved.domain.id,
        name: resolved.domain.name,
        chronicleCount: newsAdds.length,
        status: resolved.domain.status,
        inConfluxDocked: false,
        plotlines: (resolved.domain.plotlines || []).map((p) => ({
          id: p.id,
          title: p.title,
          temperature: p.temperature,
        })),
        news,
        statChanges: newsAdds
          .filter((c) => c.statChanges)
          .map((c) => ({ id: c.id, changes: c.statChanges })),
      };
    }),
  );
  results.push(...soloResults);

  return {
    world: {
      id: world.id,
      tickIndex: world.tickIndex,
      gameDate: world.gameDate,
    },
    conflux: confluxNotes,
    results,
  };
}
