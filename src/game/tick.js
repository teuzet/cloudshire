import { newId } from './ids.js';
import {
  createLoreFact,
  loreToPromptText,
  recentChronicleText,
  advanceGameDate,
  filterChronicleForDomain,
  normalizeDomain,
} from './models.js';
import { formatStatsForPrompt, statDeltaLimits, applyStatDeltas } from './stats.js';
import {
  processConfluxApproachingPhase,
  advanceDockedConfluxes,
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
} from './plotlines.js';
import { runDirector, runConfluxDirector } from './director.js';
import { getLogger } from '../log.js';

function clampPopulation(n, config) {
  const min = 1000;
  const max = Math.max(config.genesis?.population?.max || 100000, 500000);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pickEventCount(config, rng = Math.random) {
  const { min = 3, max = 6 } = config.tick?.chronicleEvents || {};
  return min + Math.floor(rng() * (max - min + 1));
}

function typicalStatDelta(config) {
  return statDeltaLimits(config).typicalMax;
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
  if (typeof working.population !== 'number') working.population = config.genesis.population.min;
  const chronicleAdds = [];
  const advancedIds = new Set();
  const eventTarget = pickEventCount(config);
  const activePending = (working.state.pendingActions || [])
    .filter((a) => a.status === 'active')
    .map(normalizePending);
  const deltaTypical = typicalStatDelta(config);
  const breakthroughList =
    breakthroughs.length > 0
      ? breakthroughs
      : (working.plotlines || []).filter((p) => p.breakthroughThisTick);

  if (!working.state) working.state = { events: [], modifiers: [], pendingActions: [] };
  if (!Array.isArray(working.state.modifiers)) working.state.modifiers = [];
  if (!Array.isArray(working.state.events)) working.state.events = [];

  const tools = [
    {
      name: 'read_context',
      description: 'Контекст домена: космология, описание, state, статы, pending, плотлайны, недавняя хроника',
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
        pendingActionsPriority: activePending,
        plotlines: formatPlotlinesForPrompt(working),
        breakthroughsThisTick: breakthroughList.map((p) => ({
          id: p.id,
          title: p.title,
          summary: p.summary,
        })),
        recentChronicle: recentChronicleText(working.lore, 14),
        fullLore: loreToPromptText(working.lore),
        rules: {
          typicalStatDelta: deltaTypical,
          note:
            `Статы через statDeltas: обычно ±1…${deltaTypical}; при катастрофе/триумфе — любая величина ` +
            '(напр. разорение → prosperity почти к 0). Итог клипится 0–100. ' +
            'Pending: chronicle + advance_pending или cancel_pending. ' +
            'ПРОРЫВЫ плотлайнов — сильный сдвиг ПЕРВЫМИ. Важные постоянные итоги → upsert_modifier. Будь смелым.',
        },
      }),
    },
    {
      name: 'add_chronicle',
      description:
        `Запись хроники месяца. Опционально statDeltas (напр. {faith: 3} или {prosperity: -70} при разорении). Обычно ≤±${deltaTypical}. Сначала pending.`,
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
            description: `Дельты статов; типично ±${deltaTypical}, при катастрофе — сколько нужно (итог 0–100)`,
          },
        },
      },
      handler: async ({ text, importance, relatedPendingId, statDeltas }) => {
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
        'Пример: ежемесячный осмотр амбаров; водоотводы на уступах приведены в порядок. Мелочи — только хроника.',
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
        if (!body) return { ok: false, error: 'text required' };
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
        return { ok: removed, removed };
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
    {
      name: 'cancel_pending',
      description:
        'Отменить active pending (сорвано, разрушено, потеряло смысл). Обычно вместе с add_chronicle о причине. Можно по воле резолвера, если мир логично ломает намерение.',
      parameters: {
        type: 'object',
        required: ['actionId', 'reason'],
        properties: {
          actionId: { type: 'string' },
          reason: {
            type: 'string',
            description: 'Кратко: почему отменено (для лога; детали — в хронике)',
          },
        },
      },
      handler: async ({ actionId, reason }) => {
        const action = working.state.pendingActions.find(
          (a) => a.id === actionId && a.status === 'active',
        );
        if (!action) return { ok: false, error: 'pending не найден' };
        action.status = 'cancelled';
        action.cancelReason = String(reason || '').trim() || 'сорвано';
        action.updatedAt = new Date().toISOString();
        action.resolvedTick = world.tickIndex;
        advancedIds.add(actionId);
        log.info('resolver.cancel_pending', {
          actionId,
          reason: action.cancelReason,
          summary: action.summary,
        });
        return { ok: true, action: { id: action.id, summary: action.summary, status: action.status } };
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

  const breakthroughBlock = formatBreakthroughMandate(breakthroughList);

  const userPrompt = [
    `Резольв месяца для города «${working.name}» (${world.gameDate.label}).`,
    'Сначала read_context. Учти описание, state, плотлайны и недавнюю хронику.',
    '',
    breakthroughBlock,
    breakthroughBlock ? '' : null,
    'ПРИОРИТЕТ — для КАЖДОГО active pending: add_chronicle (relatedPendingId) + advance_pending',
    'ИЛИ cancel_pending, если дело сорвано/разрушено (с хроникой о причине).',
    pendingBlock,
    '',
    `Затем другие события. Всего записей хроники около ${eventTarget} (включая прогресс pending).`,
    `Статы — только statDeltas в add_chronicle: обычно ≤±${deltaTypical}; при катастрофе — обвал/взлёт без потолка (итог 0–100).`,
    'State: временные процессы → set_state_events; важные постоянные итоги → upsert_modifier; мелочи — только хроника.',
    'Будь смелым: избегай стагнации и «всё спокойно». Месяц должен сдвинуть город.',
    'Не завершай многомесячную стройку за один тик без сильной причины.',
    'Интересные исходы; не сглаживай жёсткие приказы. Текст: OK.',
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

  const confluxPhase = await processConfluxApproachingPhase({
    config,
    runtime,
    storage,
    world,
  });

  const domains = await storage.listDomains();
  const results = [];
  const handled = new Set();
  const confluxNotes = [...(confluxPhase.notes || [])];

  // Docked pairs: heat/roll → resolve → undock → director → narrate
  const pairBatches = [];
  const plotCfg = plotlinesConfig(config);
  for (const conflux of confluxPhase.dockedConfluxes || []) {
    const preludeAddsByDomain = {};
    const breakthroughsByDomain = {};
    for (const id of conflux.domainIds || []) {
      preludeAddsByDomain[id] = confluxPhase.chronicleAddsByDomain.get(id) || [];
      const d = await storage.getDomain(id);
      if (!d) continue;
      normalizeDomain(d);
      if (plotCfg.enabled) {
        heatPlotlines(d, plotCfg.heatPerTick);
        breakthroughsByDomain[id] = rollBreakthroughs(d);
        getLogger().info('plotlines.roll', {
          domainId: id,
          name: d.name,
          heat: plotCfg.heatPerTick,
          breakthroughs: breakthroughsByDomain[id].map((p) => p.title),
          board: formatPlotlinesForPrompt(d),
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
    pairBatches.push({ conflux, resolved });
  }

  const advanced = await advanceDockedConfluxes(
    { storage, runtime, world },
    confluxPhase.dockedConfluxes,
  );
  confluxNotes.push(...(advanced.notes || []));

  for (const { conflux, resolved } of pairBatches) {
    const chronicleByDomain = {};
    for (const domain of resolved.domains) {
      handled.add(domain.id);
      chronicleByDomain[domain.id] = resolved.newsChronicleByDomain[domain.id] || [];
    }

    if (plotCfg.enabled) {
      await runConfluxDirector({
        config,
        runtime,
        domains: resolved.domains,
        world,
        chronicleByDomain,
        conflux,
      });
    }

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

      results.push({
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
  }

  // Solo: everyone not in an active docked pair (incl. approaching)
  for (const domain of domains) {
    if (handled.has(domain.id)) continue;
    if (domain.status && domain.status !== 'playing') {
      results.push({ domainId: domain.id, skipped: true, reason: domain.status });
      continue;
    }

    normalizeDomain(domain);
    let breakthroughs = [];
    if (plotCfg.enabled) {
      heatPlotlines(domain, plotCfg.heatPerTick);
      breakthroughs = rollBreakthroughs(domain);
      getLogger().info('plotlines.roll', {
        domainId: domain.id,
        name: domain.name,
        heat: plotCfg.heatPerTick,
        breakthroughs: breakthroughs.map((p) => p.title),
        board: formatPlotlinesForPrompt(domain),
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

    results.push({
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
    });
  }

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
