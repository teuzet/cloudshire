import { newId } from './ids.js';
import {
  createLoreFact,
  filterChronicleForDomain,
  formatChronicleScope,
} from './models.js';
import { formatStatsForPrompt, statDeltaLimits, applyStatDeltas } from './stats.js';
import {
  normalizePlotlines,
  formatPlotlinesForPrompt,
  formatBreakthroughMandate,
  plotlinesConfig,
  grantAttentionToIds,
} from './plotlines.js';
import { formatChroniclePromptBlock, refreshChronicleDigest } from './memory.js';
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


function ensureState(domain) {
  if (!domain.state) domain.state = { events: [], modifiers: [], pendingActions: [] };
  if (!Array.isArray(domain.state.modifiers)) domain.state.modifiers = [];
  if (!Array.isArray(domain.state.events)) domain.state.events = [];
  if (!Array.isArray(domain.state.pendingActions)) domain.state.pendingActions = [];
  normalizePlotlines(domain);
}

function domainBriefBlock(domain, config) {
  ensureState(domain);
  normalizeDomainProcesses(domain);
  const pending = activeProcesses(domain);
  const pendingLines = pending.length
    ? pending.map((a) => `  ${formatProcessLine(a)}`).join('\n')
    : '  (нет active процессов)';

  const desc = String(domain.description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);

  const mods = (domain.state.modifiers || [])
    .slice(-8)
    .map((m) => `  - ${m.text}`)
    .join('\n') || '  (нет)';
  const events = (domain.state.events || [])
    .slice(-6)
    .map((e) => `  - ${e.text}`)
    .join('\n') || '  (нет)';

  return [
    `=== DOMAIN ${domain.id} «${domain.name}» ===`,
    `Правитель: ${domain.characters?.[0]?.name || '?'} (${domain.characters?.[0]?.title || ''})`,
    `Население: ${domain.population}`,
    'Статы:',
    formatStatsForPrompt(domain.stats || {}, config),
    `Описание (кратко): ${desc || '(нет)'}`,
    'Modifiers:',
    mods,
    'Events:',
    events,
    'Процессы:',
    pendingLines,
    'Плотлайны:',
    formatPlotlinesForPrompt(domain),
    formatChroniclePromptBlock(domain, config),
  ].join('\n');
}

function sharedLoreTail(conflux, limit = 8) {
  const list = (conflux.sharedLore || []).slice(-limit);
  if (!list.length) return '(shared lore пока пуст)';
  return list
    .map((f) => `- (${f.gameDateLabel || '?'}) ${formatChronicleScope(f)}${f.text}`)
    .join('\n');
}

function resolveConcerns(domains, concernsDomainIds, relatedDomainId) {
  let ids = Array.isArray(concernsDomainIds)
    ? concernsDomainIds.map(String).filter(Boolean)
    : [];
  if (!ids.length && relatedDomainId) ids = [String(relatedDomainId)];
  ids = [...new Set(ids)];
  if (!ids.length) {
    return toolFail(
      'concerns_required',
      'Нужен concernsDomainIds: 1–2 id городов пары, которых касается событие. Повтори add_chronicle.',
    );
  }
  if (ids.length > 2) {
    return toolFail(
      'concerns_too_many',
      'concernsDomainIds: максимум 2 города этой пары. Убери лишние id.',
    );
  }
  for (const id of ids) {
    if (!domains[id]) {
      const known = Object.keys(domains).join(', ');
      return toolFail(
        'unknown_domain',
        `concernsDomainIds: неизвестный домен «${id}». Допустимые: ${known}.`,
      );
    }
  }
  return {
    ok: true,
    ids,
    names: ids.map((id) => domains[id].name),
  };
}

/**
 * Полный резолв пары в фазе docked.
 */
export async function resolveConfluxTick({
  config,
  runtime,
  storage,
  conflux,
  world,
  preludeAddsByDomain = {},
  breakthroughsByDomain = {},
}) {
  const log = getLogger().child({ scope: 'conflux.resolver', confluxId: conflux.id });
  const ids = [...(conflux.domainIds || [])];
  if (ids.length !== 2) throw new Error(`Conflux ${conflux.id}: need exactly 2 domains`);

  const domains = {};
  for (const id of ids) {
    const d = await storage.getDomain(id);
    if (!d) throw new Error(`Conflux ${conflux.id}: missing domain ${id}`);
    ensureState(d);
    if (typeof d.population !== 'number') d.population = config.genesis.population.min;
    domains[id] = d;
  }

  const allBreakthroughs = [];
  for (const id of ids) {
    const list = breakthroughsByDomain[id] || domains[id].plotlines.filter((p) => p.breakthroughThisTick);
    for (const p of list) {
      allBreakthroughs.push({ ...p, domainId: id, domainName: domains[id].name });
    }
  }

  const order = Math.random() < 0.5 ? [ids[0], ids[1]] : [ids[1], ids[0]];
  const deltaTypical = typicalStatDelta(config);
  const eventTarget = pickEventCount(config);
  const chronicleAddsByDomain = {
    [ids[0]]: [...(preludeAddsByDomain[ids[0]] || [])],
    [ids[1]]: [...(preludeAddsByDomain[ids[1]] || [])],
  };
  const advancedIds = new Set(); // `${domainId}:${actionId}`

  const processRollsByDomain = {};
  const allPending = [];
  for (const id of order) {
    normalizeDomainProcesses(domains[id], config);
    processRollsByDomain[id] = rollAllProcessAdvances(domains[id], config);
    for (const a of activeProcesses(domains[id], config)) {
      allPending.push({ domainId: id, action: a });
    }
  }
  const processRollByKey = {};
  for (const id of order) {
    for (const r of processRollsByDomain[id]) {
      processRollByKey[`${id}:${r.processId}`] = r;
    }
  }

  const requireDomain = (domainId) => {
    const d = domains[domainId];
    if (!d) {
      const known = Object.keys(domains).join(', ');
      return toolFail(
        'unknown_domain',
        `Неизвестный domainId «${domainId}». Допустимые в стыке: ${known}.`,
      );
    }
    return { ok: true, domain: d };
  };

  const breakthroughMandate = allBreakthroughs.length
    ? [
        formatBreakthroughMandate(allBreakthroughs, ids.map((id) => domains[id])),
        ...allBreakthroughs.map(
          (p) => `  (город «${p.domainName}» / ${p.domainId})`,
        ),
      ].join('\n')
    : '';

  const tools = [
    {
      name: 'read_pair_context',
      description: 'Общий контекст стыка и симметричные брифы обоих доменов',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        cosmology: config.world.cosmology,
        gameDate: world.gameDate,
        confluxId: conflux.id,
        contact: conflux.contact,
        sharedLoreRecent: sharedLoreTail(conflux, 8),
        domainsInPromptOrder: order,
        briefs: order.map((id) => domainBriefBlock(domains[id], config)),
        processRollsByDomain,
        pendingChecklist: allPending.map(({ domainId, action: a }) => {
          normalizeProcess(a, config);
          const stats = (a.linkedStats || []).join('+') || 'все';
          return `- domain=${domainId} [${a.id}] ${a.summary} (ещё ~${a.monthsLeft} мес., статы: ${stats})`;
        }),
        breakthroughsThisTick: allBreakthroughs.map((p) => ({
          id: p.id,
          title: p.title,
          summary: p.summary,
          domainId: p.domainId,
          domainName: p.domainName,
          relatedPendingIds: p.relatedPendingIds || [],
        })),
        rules: {
          typicalStatDelta: deltaTypical,
          equalWeight:
            'Оба домена равноправны. Не привилегируй блок ближе к концу промпта.',
          secret:
            'secret=true только при явной тайной операции; иначе публично (оба города).',
          scope:
            'У каждой записи обязательны location (где) и concernsDomainIds (кого касается). Внутренний сюжет одного города — не secret, но location+concerns указывают его город.',
          note:
            'Процессы: chronicle + advance/cancel. Если хроника «готово» — complete в том же тике. ' +
            'ПРОРЫВЫ — первыми; связанные процессы затронь. ' +
            'Смело, но не одноцветно: у месяца бывают выигрыш, цена и двойственный итог.',
        },
      }),
    },
    {
      name: 'add_chronicle',
      description:
        'Хроника стыка/месяца. location + concernsDomainIds обязательны. ' +
        `statDeltas: обычно ±1…${deltaTypical}, при катастрофе без потолка (итог 0–100). ` +
        'Положительные дельты — такой же нормальный исход, как отрицательные.',
      parameters: {
        type: 'object',
        required: ['text', 'importance', 'location', 'concernsDomainIds'],
        properties: {
          text: {
            type: 'string',
            description:
              'Событие. Город/место должны быть ясны: не пиши так, будто чужой мастер — житель любого читающего города.',
          },
          importance: { type: 'string', enum: ['minor', 'major', 'critical'] },
          location: {
            type: 'string',
            description:
              'Где произошло: город, квартал, мостик, храм… — по именам из контекста пары, без выдуманных третьих островов.',
          },
          concernsDomainIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 2,
            description:
              'Id городов пары, которых касается событие (1 — локальный сюжет; оба — общий инцидент на стыке).',
          },
          secret: { type: 'boolean' },
          secretForDomainId: {
            type: 'string',
            description: 'Обязателен если secret=true — id домена, которому видна запись',
          },
          relatedPendingId: { type: 'string' },
          relatedPlotlineIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Опционально: id плотлайнов, которые событие явно продолжает (не на каждую запись)',
          },
          relatedDomainId: {
            type: 'string',
            description: 'Домен pending/статов, если запись про один город',
          },
          statDeltas: {
            type: 'object',
            additionalProperties: { type: 'number' },
          },
          statDomainId: {
            type: 'string',
            description: 'К какому домену применить statDeltas (обязателен если есть deltas)',
          },
        },
      },
      handler: async ({
        text,
        importance,
        location,
        concernsDomainIds,
        secret = false,
        secretForDomainId = null,
        relatedPendingId,
        relatedPlotlineIds,
        relatedDomainId,
        statDeltas,
        statDomainId,
      }) => {
        const place = String(location || '').trim();
        if (place.length < 3) {
          return toolFail(
            'location_required',
            'location обязателен: где произошло (≥3 символа). Добавь место и вызови add_chronicle снова.',
          );
        }
        const concerns = resolveConcerns(domains, concernsDomainIds, relatedDomainId);
        if (!concerns.ok) return concerns;

        const isSecret = Boolean(secret);
        if (isSecret && !secretForDomainId) {
          return toolFail(
            'secret_domain_required',
            'secret=true требует secretForDomainId — id города, для которого тайна. Передай id одного из доменов пары.',
          );
        }
        if (isSecret && !domains[secretForDomainId]) {
          const known = Object.keys(domains).join(', ');
          return toolFail(
            'secret_domain_unknown',
            `secretForDomainId «${secretForDomainId}» не в стыке. Допустимые: ${known}.`,
          );
        }

        let statChanges = null;
        const statsTarget = statDomainId || relatedDomainId || (isSecret ? secretForDomainId : null);
        if (statDeltas && Object.keys(statDeltas).length) {
          if (!statsTarget || !domains[statsTarget]) {
            const known = Object.keys(domains).join(', ');
            return toolFail(
              'stat_domain_required',
              `При statDeltas нужен statDomainId одного из городов пары (${known}).`,
            );
          }
          statChanges = applyStatDeltas(domains[statsTarget].stats, statDeltas);
        }

        const baseTags = ['chronicle', 'conflux', `conflux:${conflux.id}`];
        if (!isSecret) baseTags.push('shared');
        const plotCfg = plotlinesConfig(config);
        const plotIds = relatedPlotlineIds || null;

        const makeFact = () =>
          createLoreFact({
            id: newId('lore'),
            text,
            tags: baseTags,
            gameDateLabel: world.gameDate.label,
            tick: world.tickIndex,
            author: 'conflux-resolver',
            importance: importance || 'minor',
            relatedPendingId: relatedPendingId || null,
            relatedPlotlineIds: plotIds,
            statChanges: statChanges && Object.keys(statChanges).length ? statChanges : null,
            secret: isSecret,
            secretForDomainId: isSecret ? secretForDomainId : null,
            location: place,
            concernsDomainIds: concerns.ids,
            concernsDomainNames: concerns.names,
          });

        const grantPlotAttention = (domainId) =>
          grantAttentionToIds(domains[domainId], plotIds, plotCfg.attention.chronicleLink);

        if (isSecret) {
          const fact = makeFact();
          domains[secretForDomainId].lore.push(fact);
          chronicleAddsByDomain[secretForDomainId].push(fact);
          const attentionGranted = grantPlotAttention(secretForDomainId);
          log.info('conflux.chronicle.secret', {
            domainId: secretForDomainId,
            location: place,
            concerns: concerns.names,
            relatedPlotlineIds: plotIds,
            attentionGranted,
            textPreview: String(text).slice(0, 160),
          });
          return {
            ok: true,
            factId: fact.id,
            secret: true,
            domainId: secretForDomainId,
            attentionGranted,
          };
        }

        const factA = makeFact();
        const factB = makeFact();
        domains[ids[0]].lore.push(factA);
        domains[ids[1]].lore.push(factB);
        chronicleAddsByDomain[ids[0]].push(factA);
        chronicleAddsByDomain[ids[1]].push(factB);
        conflux.sharedLore = conflux.sharedLore || [];
        conflux.sharedLore.push({ ...factA });
        const attentionGranted = [
          ...grantPlotAttention(ids[0]),
          ...grantPlotAttention(ids[1]),
        ];
        log.info('conflux.chronicle.public', {
          location: place,
          concerns: concerns.names,
          relatedPlotlineIds: plotIds,
          attentionGranted,
          textPreview: String(text).slice(0, 160),
        });
        return {
          ok: true,
          factIds: [factA.id, factB.id],
          secret: false,
          location: place,
          concernsDomainIds: concerns.ids,
          concernsDomainNames: concerns.names,
          statChanges,
          attentionGranted,
        };
      },
    },
    {
      name: 'advance_process',
      description: 'Продвинуть процесс домена по броску тика',
      parameters: {
        type: 'object',
        required: ['domainId', 'processId'],
        properties: {
          domainId: { type: 'string' },
          processId: { type: 'string' },
          advance: { type: 'number' },
          complete: { type: 'boolean' },
          failed: { type: 'boolean' },
        },
      },
      handler: async ({ domainId, processId, advance, complete = false, failed = false }) => {
        const got = requireDomain(domainId);
        if (!got.ok) return got;
        const working = got.domain;
        const action = working.state.pendingActions.find(
          (a) => a.id === processId && a.status === 'active',
        );
        if (!action) {
          return toolFail(
            'process_not_found',
            `В домене ${domainId} нет active processId=${processId}. Активные:\n` +
              formatActiveProcessesForAgent(working, config),
          );
        }
        normalizeProcess(action, config);
        const rolled = processRollByKey[`${domainId}:${processId}`];
        const step =
          advance != null
            ? Math.max(0, Math.min(6, Math.round(Number(advance))))
            : rolled
              ? rolled.advance
              : 1;
        const { finished } = applyProcessAdvance(action, step, {
          complete,
          failed,
          tick: world.tickIndex,
        });
        advancedIds.add(`${domainId}:${processId}`);
        return {
          ok: true,
          finished,
          process: {
            id: action.id,
            summary: action.summary,
            monthsLeft: action.monthsLeft,
            status: action.status,
          },
          roll: rolled || null,
        };
      },
    },
    {
      name: 'cancel_process',
      description:
        'Отменить pending домена (сорвано/разрушено/потеряло смысл). Вместе с chronicle о причине. Можно по воле резолвера — напр. чужая стройка уничтожена на стыке.',
      parameters: {
        type: 'object',
        required: ['domainId', 'processId', 'reason'],
        properties: {
          domainId: { type: 'string' },
          processId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ domainId, processId, reason }) => {
        const got = requireDomain(domainId);
        if (!got.ok) return got;
        const working = got.domain;
        const action = working.state.pendingActions.find(
          (a) => a.id === processId && a.status === 'active',
        );
        if (!action) {
          return toolFail(
            'process_not_found',
            `В домене ${domainId} нет active processId=${processId}. Активные:\n` +
              formatActiveProcessesForAgent(working, config),
          );
        }
        action.status = 'cancelled';
        action.cancelReason = String(reason || '').trim() || 'сорвано';
        action.updatedAt = new Date().toISOString();
        action.resolvedTick = world.tickIndex;
        advancedIds.add(`${domainId}:${processId}`);
        log.info('conflux.cancel_process', {
          domainId,
          processId,
          reason: action.cancelReason,
          summary: action.summary,
        });
        return {
          ok: true,
          action: { id: action.id, summary: action.summary, status: action.status },
        };
      },
    },
    {
      name: 'upsert_modifier',
      description: 'Постоянный модификатор state одного домена',
      parameters: {
        type: 'object',
        required: ['domainId', 'text'],
        properties: {
          domainId: { type: 'string' },
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['institution', 'order', 'condition', 'other'] },
        },
      },
      handler: async ({ domainId, id, text, kind }) => {
        const got = requireDomain(domainId);
        if (!got.ok) return got;
        const working = got.domain;
        const body = String(text || '').trim();
        if (!body) {
          return toolFail(
            'text_required',
            'text пуст. Передай формулировку модификатора и вызови upsert_modifier снова.',
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
          return { ok: true, created: true, modifier: mod };
        }
        mod.text = body;
        if (kind) mod.kind = kind;
        mod.updatedTick = world.tickIndex;
        mod.at = new Date().toISOString();
        return { ok: true, created: false, modifier: mod };
      },
    },
    {
      name: 'set_state_events',
      description: 'Временные процессы одного домена',
      parameters: {
        type: 'object',
        required: ['domainId', 'events'],
        properties: {
          domainId: { type: 'string' },
          events: { type: 'array', items: { type: 'string' } },
        },
      },
      handler: async ({ domainId, events }) => {
        const got = requireDomain(domainId);
        if (!got.ok) return got;
        const working = got.domain;
        working.state.events = (events || []).map((t) => ({
          id: newId('ev'),
          text: t,
          tick: world.tickIndex,
          at: new Date().toISOString(),
        }));
        return { ok: true, count: working.state.events.length };
      },
    },
    {
      name: 'adjust_population',
      parameters: {
        type: 'object',
        required: ['domainId', 'population'],
        properties: {
          domainId: { type: 'string' },
          population: { type: 'number' },
        },
      },
      handler: async ({ domainId, population }) => {
        const got = requireDomain(domainId);
        if (!got.ok) return got;
        const working = got.domain;
        const from = working.population;
        working.population = clampPopulation(population, config);
        return { ok: true, from, population: working.population };
      },
    },
  ];

  const pendingBlock = allPending.length
    ? allPending
        .map(({ domainId, action: a }) => {
          normalizeProcess(a, config);
          return `- domain=${domainId} ${formatProcessLine(a, config)}`;
        })
        .join('\n')
    : '(нет active процессов у обоих)';

  const contactLine = conflux.contact
    ? `${conflux.contact.kind || 'other'}: ${conflux.contact.description}`
    : '(contact не задан)';

  const sideMax = sideEventsMax(config);
  const userPrompt = [
    `Conflux-резолв месяца (${world.gameDate.label}). Пара: ${order
      .map((id) => `«${domains[id].name}» (${id})`)
      .join(' + ')}.`,
    `Характер контакта: ${contactLine}`,
    'Сначала read_pair_context. Оба домена РАВНОПРАВНЫ (порядок в промпте случаен).',
    '',
    breakthroughMandate,
    breakthroughMandate ? '' : null,
    'ПРИОРИТЕТ — каждый процесс обоих: add_chronicle + advance_process(из броска) ИЛИ cancel_process.',
    'Если хроника говорит «готово/сорвано» — complete/cancel в том же тике.',
    order.map((id) => `броски «${domains[id].name}»:\n${formatProcessRollsForPrompt(processRollsByDomain[id])}`).join('\n'),
    pendingBlock,
    '',
    `Бюджет: процессы/прорывы + не больше ${sideMax} побочных; всего около ${eventTarget} записей. Большинство — без secret.`,
    'secret только для явно тайных операций; secretForDomainId = id заказчика.',
    'Каждая add_chronicle: location (где) + concernsDomainIds (1–2 id городов пары).',
    'Локальный сюжет одного города — публично ок, но concerns = только его id и location в его городе.',
    'Учитывай contact. Будь смелым: стык должен жить, не статус-кво. Можно ломать чужие процессы.',
    'Смело — не значит «всем хуже»: сделка, находка и договор двигают месяц не меньше беды.',
    'Не выдумывай третьи острова.',
  ]
    .filter((line) => line != null)
    .join('\n');

  await runtime.run({
    agentId: 'confluxResolver',
    userMessages: [{ role: 'user', content: userPrompt }],
    tools,
    maxTurns: 20,
    toolChoice: { type: 'function', function: { name: 'read_pair_context' } },
    log,
    scene: 'conflux_resolve',
    domainId: order.join('+'),
  });

  // Process fallbacks
  for (const { domainId, action } of allPending) {
    const working = domains[domainId];
    const live = working.state.pendingActions.find((a) => a.id === action.id);
    if (!live || live.status !== 'active') continue;
    normalizeProcess(live, config);
    const key = `${domainId}:${action.id}`;
    const rolled = processRollByKey[key] || { advance: 1, kind: 'normal', unusual: false };
    const covered = chronicleAddsByDomain[domainId].some((c) => c.relatedPendingId === action.id);
    if (!covered) {
      const leftAfter = Math.max(0, live.monthsLeft - rolled.advance);
      let body;
      if (rolled.kind === 'stall') {
        body = `По делу «${action.summary}» в «${working.name}»: месяц почти без сдвига.`;
      } else if (rolled.kind === 'surge') {
        body =
          leftAfter > 0
            ? `По делу «${action.summary}» в «${working.name}»: неожиданный рывок (ещё ~${leftAfter} мес.).`
            : `По делу «${action.summary}» в «${working.name}»: рывок почти завершил работу.`;
      } else {
        body =
          leftAfter > 0
            ? `По делу «${action.summary}» в «${working.name}»: обычный ход, ещё ~${leftAfter} мес.`
            : `По делу «${action.summary}» в «${working.name}»: близко к итогу.`;
      }
      const fact = createLoreFact({
        id: newId('lore'),
        text: `${world.gameDate.label}. ${body}`,
        tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared'],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'conflux-process-fallback',
        importance: rolled.unusual ? 'major' : 'minor',
        relatedPendingId: action.id,
        location: working.name,
        concernsDomainIds: [domainId],
        concernsDomainNames: [working.name],
      });
      working.lore.push(fact);
      chronicleAddsByDomain[domainId].push(fact);
      const copy = { ...fact, id: newId('lore') };
      const otherId = ids.find((x) => x !== domainId);
      domains[otherId].lore.push(copy);
      chronicleAddsByDomain[otherId].push(copy);
      conflux.sharedLore.push({ ...fact });
      log.warn('conflux.process_fallback', { domainId, processId: action.id, kind: rolled.kind });
    }
    if (!advancedIds.has(key)) {
      applyProcessAdvance(live, rolled.advance, { tick: world.tickIndex });
      advancedIds.add(key);
    }
  }

  for (const id of ids) {
    refreshChronicleDigest(domains[id], config);
  }

  for (const id of ids) {
    if (!chronicleAddsByDomain[id].length) {
      const fact = createLoreFact({
        id: newId('lore'),
        text: `${world.gameDate.label}. У стыка «${domains[id].name}» месяц прошёл без громких перемен.`,
        tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared'],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'conflux-fallback',
        importance: 'minor',
        location: `стык у «${domains[id].name}»`,
        concernsDomainIds: [id],
        concernsDomainNames: [domains[id].name],
      });
      domains[id].lore.push(fact);
      chronicleAddsByDomain[id].push(fact);
    }
    domains[id].lastTickAt = new Date().toISOString();
    await storage.saveDomain(domains[id]);
  }
  await storage.saveConflux(conflux);

  log.info('conflux.resolver.done', {
    order,
    counts: Object.fromEntries(ids.map((id) => [id, chronicleAddsByDomain[id].length])),
  });

  return {
    conflux,
    domains: ids.map((id) => domains[id]),
    chronicleAddsByDomain,
    /** для новостей правителю */
    newsChronicleByDomain: Object.fromEntries(
      ids.map((id) => [id, filterChronicleForDomain(chronicleAddsByDomain[id], id)]),
    ),
  };
}
