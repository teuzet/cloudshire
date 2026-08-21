import { newId } from './ids.js';
import {
  createLoreFact,
  filterChronicleForDomain,
  chronicleEntries,
  formatChronicleScope,
} from './models.js';
import { formatStatsForPrompt, statDeltaLimits, applyStatDeltas } from './stats.js';
import {
  normalizePlotlines,
  formatPlotlinesForPrompt,
  formatBreakthroughMandate,
} from './plotlines.js';
import { getLogger } from '../log.js';

function clampPopulation(n, config) {
  const min = 1000;
  const max = Math.max(config.genesis?.population?.max || 100000, 500000);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pickEventCount(config, rng = Math.random) {
  const { min = 3, max = 6 } = config.tick?.chronicleEvents || {};
  return Math.max(min, Math.min(max + 2, min + Math.floor(rng() * (max - min + 3))));
}

function typicalStatDelta(config) {
  return statDeltaLimits(config).typicalMax;
}

function normalizePending(action) {
  if (action.durationMonths == null) {
    const text = `${action.summary || ''} ${action.detail || ''}`.toLowerCase();
    let guess = 1;
    if (/винодел|строи|храм|крепос|акаде|канал|верф|дворец|мануфакт|стык|мост/.test(text)) {
      guess = 4;
    } else if (/обучен|набор|кампан|жертв|праздн|шпион|диверс|подкуп/.test(text)) {
      guess = 2;
    }
    action.durationMonths = guess;
  }
  action.durationMonths = Math.max(1, Math.min(12, Math.round(Number(action.durationMonths) || 1)));
  if (action.monthsDone == null) action.monthsDone = 0;
  return action;
}

function ensureState(domain) {
  if (!domain.state) domain.state = { events: [], modifiers: [], pendingActions: [] };
  if (!Array.isArray(domain.state.modifiers)) domain.state.modifiers = [];
  if (!Array.isArray(domain.state.events)) domain.state.events = [];
  if (!Array.isArray(domain.state.pendingActions)) domain.state.pendingActions = [];
  normalizePlotlines(domain);
}

function recentChronicleForPair(domain, viewerDomainId, limit = 10) {
  const chron = chronicleEntries(domain.lore || [])
    .filter((e) => {
      if (!e.secret) return true;
      return String(e.secretForDomainId || '') === String(viewerDomainId);
    })
    .slice(-limit);
  if (!chron.length) return '(хроники мало)';
  return chron
    .map((f) => {
      const sec = f.secret ? ' [secret]' : '';
      return `- (${f.gameDateLabel || '?'})${sec} ${f.text}`;
    })
    .join('\n');
}

function domainBriefBlock(domain, config, { chronicleLimit = 10 } = {}) {
  ensureState(domain);
  const pending = (domain.state.pendingActions || [])
    .filter((a) => a.status === 'active')
    .map(normalizePending);
  const pendingLines = pending.length
    ? pending
        .map((a) => {
          const rem = Math.max(0, (a.durationMonths || 1) - (a.monthsDone || 0));
          return `  - [${a.id}] ${a.summary}: ${a.detail || ''} | ${a.monthsDone || 0}/${a.durationMonths} (осталось ~${rem})`;
        })
        .join('\n')
    : '  (нет active pending)';

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
    'Pending:',
    pendingLines,
    'Плотлайны:',
    formatPlotlinesForPrompt(domain),
    'Недавняя хроника (видимая этому домену):',
    recentChronicleForPair(domain, domain.id, chronicleLimit),
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
    return { ok: false, error: 'concernsDomainIds required (1–2 id городов, которых касается событие)' };
  }
  if (ids.length > 2) {
    return { ok: false, error: 'concernsDomainIds: максимум 2 города пары' };
  }
  for (const id of ids) {
    if (!domains[id]) {
      return { ok: false, error: `concernsDomainIds: неизвестный домен ${id}` };
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

  const allPending = [];
  for (const id of order) {
    for (const a of (domains[id].state.pendingActions || []).filter((x) => x.status === 'active')) {
      normalizePending(a);
      allPending.push({ domainId: id, action: a });
    }
  }

  const getDomain = (domainId) => {
    const d = domains[domainId];
    if (!d) throw new Error(`unknown domain ${domainId}`);
    return d;
  };

  const breakthroughMandate = allBreakthroughs.length
    ? [
        formatBreakthroughMandate(allBreakthroughs),
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
        pendingChecklist: allPending.map(
          ({ domainId, action: a }) =>
            `- domain=${domainId} [${a.id}] ${a.summary} (${a.monthsDone}/${a.durationMonths})`,
        ),
        breakthroughsThisTick: allBreakthroughs.map((p) => ({
          id: p.id,
          title: p.title,
          summary: p.summary,
          domainId: p.domainId,
          domainName: p.domainName,
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
            `Статы через statDeltas + domainId: обычно ±1…${deltaTypical}; при катастрофе — любая величина (разорение → prosperity ≈0). Итог 0–100. ` +
            'Pending: chronicle + advance/cancel. ПРОРЫВЫ — сильный сдвиг первыми. Смело, не статус-кво.',
        },
      }),
    },
    {
      name: 'add_chronicle',
      description:
        `Хроника стыка/месяца. location + concernsDomainIds обязательны. statDeltas обычно ≤±${deltaTypical}; при катастрофе — без потолка.`,
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
              'Где произошло: город, квартал, мостик, храм… Напр. «Ровенна, мастерская у старых выработок» или «мостик между Этеменау и Ровенной».',
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
        relatedDomainId,
        statDeltas,
        statDomainId,
      }) => {
        const place = String(location || '').trim();
        if (place.length < 3) {
          return { ok: false, error: 'location required (где произошло, ≥3 символа)' };
        }
        const concerns = resolveConcerns(domains, concernsDomainIds, relatedDomainId);
        if (!concerns.ok) return concerns;

        const isSecret = Boolean(secret);
        if (isSecret && !secretForDomainId) {
          return { ok: false, error: 'secretForDomainId required when secret=true' };
        }
        if (isSecret && !domains[secretForDomainId]) {
          return { ok: false, error: 'secretForDomainId not in conflux' };
        }

        let statChanges = null;
        const statsTarget = statDomainId || relatedDomainId || (isSecret ? secretForDomainId : null);
        if (statDeltas && Object.keys(statDeltas).length) {
          if (!statsTarget || !domains[statsTarget]) {
            return { ok: false, error: 'statDomainId required for statDeltas' };
          }
          statChanges = applyStatDeltas(domains[statsTarget].stats, statDeltas);
        }

        const baseTags = ['chronicle', 'conflux', `conflux:${conflux.id}`];
        if (!isSecret) baseTags.push('shared');

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
            statChanges: statChanges && Object.keys(statChanges).length ? statChanges : null,
            secret: isSecret,
            secretForDomainId: isSecret ? secretForDomainId : null,
            location: place,
            concernsDomainIds: concerns.ids,
            concernsDomainNames: concerns.names,
          });

        if (isSecret) {
          const fact = makeFact();
          domains[secretForDomainId].lore.push(fact);
          chronicleAddsByDomain[secretForDomainId].push(fact);
          log.info('conflux.chronicle.secret', {
            domainId: secretForDomainId,
            location: place,
            concerns: concerns.names,
            textPreview: String(text).slice(0, 160),
          });
          return { ok: true, factId: fact.id, secret: true, domainId: secretForDomainId };
        }

        const factA = makeFact();
        const factB = makeFact();
        domains[ids[0]].lore.push(factA);
        domains[ids[1]].lore.push(factB);
        chronicleAddsByDomain[ids[0]].push(factA);
        chronicleAddsByDomain[ids[1]].push(factB);
        conflux.sharedLore = conflux.sharedLore || [];
        conflux.sharedLore.push({ ...factA });
        log.info('conflux.chronicle.public', {
          location: place,
          concerns: concerns.names,
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
        };
      },
    },
    {
      name: 'advance_pending',
      description: 'Продвинуть pending указанного домена',
      parameters: {
        type: 'object',
        required: ['domainId', 'actionId'],
        properties: {
          domainId: { type: 'string' },
          actionId: { type: 'string' },
          monthsAdvance: { type: 'number', default: 1 },
          complete: { type: 'boolean' },
          failed: { type: 'boolean' },
        },
      },
      handler: async ({
        domainId,
        actionId,
        monthsAdvance = 1,
        complete = false,
        failed = false,
      }) => {
        const working = getDomain(domainId);
        const action = working.state.pendingActions.find(
          (a) => a.id === actionId && a.status === 'active',
        );
        if (!action) return { ok: false, error: 'pending не найден' };
        normalizePending(action);
        const step = Math.max(0, Math.min(6, Math.round(Number(monthsAdvance) || 1)));
        action.monthsDone = Math.min(action.durationMonths, (action.monthsDone || 0) + step);
        action.updatedAt = new Date().toISOString();
        const finished =
          Boolean(failed) || Boolean(complete) || action.monthsDone >= action.durationMonths;
        if (finished) {
          action.status = failed ? 'failed' : 'resolved';
          action.resolvedTick = world.tickIndex;
        }
        advancedIds.add(`${domainId}:${actionId}`);
        return {
          ok: true,
          finished,
          action: {
            id: action.id,
            summary: action.summary,
            monthsDone: action.monthsDone,
            durationMonths: action.durationMonths,
            status: action.status,
          },
        };
      },
    },
    {
      name: 'cancel_pending',
      description:
        'Отменить pending домена (сорвано/разрушено/потеряло смысл). Вместе с chronicle о причине. Можно по воле резолвера — напр. чужая стройка уничтожена на стыке.',
      parameters: {
        type: 'object',
        required: ['domainId', 'actionId', 'reason'],
        properties: {
          domainId: { type: 'string' },
          actionId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ domainId, actionId, reason }) => {
        const working = getDomain(domainId);
        const action = working.state.pendingActions.find(
          (a) => a.id === actionId && a.status === 'active',
        );
        if (!action) return { ok: false, error: 'pending не найден' };
        action.status = 'cancelled';
        action.cancelReason = String(reason || '').trim() || 'сорвано';
        action.updatedAt = new Date().toISOString();
        action.resolvedTick = world.tickIndex;
        advancedIds.add(`${domainId}:${actionId}`);
        log.info('conflux.cancel_pending', {
          domainId,
          actionId,
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
        const working = getDomain(domainId);
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
        const working = getDomain(domainId);
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
        const working = getDomain(domainId);
        const from = working.population;
        working.population = clampPopulation(population, config);
        return { ok: true, from, population: working.population };
      },
    },
  ];

  const pendingBlock = allPending.length
    ? allPending
        .map(
          ({ domainId, action: a }) =>
            `- domain=${domainId} [${a.id}] ${a.summary}: ${a.detail} | ${a.monthsDone}/${a.durationMonths}`,
        )
        .join('\n')
    : '(нет active pending у обоих)';

  const contactLine = conflux.contact
    ? `${conflux.contact.kind || 'other'}: ${conflux.contact.description}`
    : '(contact не задан)';

  const userPrompt = [
    `Conflux-резолв месяца (${world.gameDate.label}). Пара: ${order
      .map((id) => `«${domains[id].name}» (${id})`)
      .join(' + ')}.`,
    `Характер контакта: ${contactLine}`,
    'Сначала read_pair_context. Оба домена РАВНОПРАВНЫ (порядок в промпте случаен).',
    '',
    breakthroughMandate,
    breakthroughMandate ? '' : null,
    'ПРИОРИТЕТ — каждый pending обоих: add_chronicle + advance_pending ИЛИ cancel_pending (если сорвано).',
    pendingBlock,
    '',
    `Всего записей хроники около ${eventTarget} (включая pending). Большинство — без secret.`,
    'secret только для явно тайных операций; secretForDomainId = id заказчика.',
    'Каждая add_chronicle: location (где) + concernsDomainIds (1–2 id городов пары).',
    'Локальный сюжет одного города — публично ок, но concerns = только его id и location в его городе.',
    'Учитывай contact. Будь смелым: стык должен жить, не статус-кво. Можно ломать чужие pending.',
    `Статы: обычно ≤±${deltaTypical}; при катастрофе — обвал/взлёт без потолка (итог 0–100).`,
    'Не выдумывай третьи острова. Текст: OK.',
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
  });

  // Pending fallbacks
  for (const { domainId, action } of allPending) {
    const working = domains[domainId];
    const live = working.state.pendingActions.find((a) => a.id === action.id);
    if (!live || live.status !== 'active') continue;
    normalizePending(live);
    const key = `${domainId}:${action.id}`;
    const covered = chronicleAddsByDomain[domainId].some((c) => c.relatedPendingId === action.id);
    if (!covered) {
      const rem = Math.max(0, live.durationMonths - (live.monthsDone || 0) - 1);
      const fact = createLoreFact({
        id: newId('lore'),
        text:
          rem > 0
            ? `${world.gameDate.label}. По намерению «${action.summary}» в «${working.name}»: сдвиг есть, до конца ещё ~${rem} мес.`
            : `${world.gameDate.label}. По намерению «${action.summary}» в «${working.name}»: близко к итогу.`,
        tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared'],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'conflux-pending-fallback',
        importance: 'major',
        relatedPendingId: action.id,
        location: working.name,
        concernsDomainIds: [domainId],
        concernsDomainNames: [working.name],
      });
      working.lore.push(fact);
      chronicleAddsByDomain[domainId].push(fact);
      // mirror public fallback to partner + shared
      const copy = { ...fact, id: newId('lore') };
      const otherId = ids.find((x) => x !== domainId);
      domains[otherId].lore.push(copy);
      chronicleAddsByDomain[otherId].push(copy);
      conflux.sharedLore.push({ ...fact });
      log.warn('conflux.pending_fallback', { domainId, actionId: action.id });
    }
    if (!advancedIds.has(key)) {
      live.monthsDone = Math.min(live.durationMonths, (live.monthsDone || 0) + 1);
      live.updatedAt = new Date().toISOString();
      if (live.monthsDone >= live.durationMonths) {
        live.status = 'resolved';
        live.resolvedTick = world.tickIndex;
      }
      advancedIds.add(key);
      log.warn('conflux.advance_fallback', { domainId, actionId: action.id });
    }
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
