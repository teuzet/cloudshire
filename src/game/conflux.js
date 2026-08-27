import { newId } from './ids.js';
import { createLoreFact, normalizeDomain } from './models.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import {
  normalizeConfluxBoard,
  takeDomainBoardIntoConflux,
  createMainConfluxPlot,
  pushInternalChronicle,
  approachingAnnounceText,
  approachMonthText,
  returnBoardsOnUndock,
} from './confluxBoard.js';
import { decideUndockContinuation } from './undockContinuation.js';

/** Ширина прохода: ГСЧ выбирает kind; LLM только описывает. control — можно ли закрыть. */
export const CONTACT_KINDS = {
  hairline: {
    label: 'волосок',
    hint:
      'Очень узкий проход: один человек боком, почти нет места; обозы и группы невозможны.',
    control:
      'Концы волоска можно держать: стража не пускает или пропускает по одному. ' +
      'Запереть как дверь нечем, но перегородить и отказать в проходе легко.',
  },
  bridge: {
    label: 'мостик',
    hint: 'Узкий мостик или каменная перемычка: пешком цепочкой, тяжёлые грузы — с трудом.',
    control:
      'Концы мостика можно держать и запереть. Створы, цепи, стража у края — один берег может не пустить на мост.',
  },
  gap_jump: {
    label: 'щель',
    hint: 'Между краями — щель; переходят прыжком или по шатким доскам, не всем и не с грузом.',
    control:
      'Запереть нечем: двери и створов нет. Можно снять доски, стеречь прыжок, отказать в переправе — но не закрыть проход засовом.',
  },
  gorge: {
    label: 'ущелье',
    hint: 'Между краями — узкое ущелье или расселина: спуск и подъём цепочкой, обозы не пройдут.',
    control:
      'Ущелье не запирают. Можно сторожить спуск, откатить лестницы, отказать в проходе — но створов и ворот здесь нет.',
  },
  wagon_pass: {
    label: 'обозный разъезд',
    hint:
      'Проход шириной примерно в два обоза: телеги разъедутся, если одна посторонится; ' +
      'пешие идут свободно, войско строем уже тесно.',
    control:
      'Разъезд можно перегородить повозкой, цепью или баррикадой — с усилием, не одним щелчком засова. ' +
      'Поток остановить можно, запереть как ворота — нет.',
  },
  causeway: {
    label: 'широкий проход',
    hint:
      'Проход, через который пройдёт много людей: от роты до целой армии. ' +
      'Выбери конкретную ширину в этом диапазоне и держись её. Обозы идут колонной.',
    control:
      'Слишком широко, чтобы закрыть. Стража может считать проходящих и держать посты, ' +
      'но не запереть ворота на толпу и не отрезать один берег от другого.',
  },
  landmass: {
    label: 'берег в берег',
    hint:
      'Острова сошлись берег в берег: края лежат вплотную, как одна земля, без моста и щели. ' +
      'Ходят толпами, где хотят.',
    control:
      'Прохода как двери нет: края лежат вплотную. Закрыть, запереть, опустить створы нельзя. ' +
      'Стража видит людей на сопряжении, но не отрезает берег от берега.',
  },
};

export const RELIEF_KINDS = {
  level: {
    label: 'ровная земля',
    hint:
      'Края почти на одной высоте: ступают без спуска. Не делай лестниц в пропасть между берегами.',
  },
  drop: {
    label: 'перепад высот',
    hint:
      'Один край заметно выше другого: спуск и подъём, лестницы, осыпь или уступ. Не делай ровную площадь вровень.',
  },
};

function rollRelief(rng = Math.random) {
  return rng() < 0.55 ? 'level' : 'drop';
}

/** Можно ли закрыть этот проход — из сохранённого сопряжения или из вида. */
export function contactControlRule(contact) {
  if (!contact) return '';
  const stored = String(contact.control || '').trim();
  if (stored) return stored;
  return String(CONTACT_KINDS[contact.kind]?.control || '').trim();
}

/**
 * Геометрия + контроль прохода для агентов.
 * control подставляется по kind, даже если в сохранённом стыке его ещё нет.
 */
export function formatContactForPrompt(contact) {
  if (!contact) return '';
  const kind = contact.kind || '';
  const label = CONTACT_KINDS[kind]?.label || '';
  const desc = String(contact.description || '').trim();
  const control = contactControlRule(contact);
  const named = [kind, label && label !== kind ? `«${label}»` : ''].filter(Boolean).join(' ');
  const relief = RELIEF_KINDS[contact.relief];
  const reliefBit = relief ? `Рельеф: ${relief.label}.` : '';
  const head = named
    ? `Как острова сошлись в сопряжении: ${named}${desc ? ` — ${desc}` : '.'}`
    : desc;
  const bits = [head, reliefBit, control && !desc.includes(control) ? `Контроль прохода: ${control}` : '']
    .filter(Boolean);
  return bits.join('\n');
}

function withCanonicalControl(kind, description) {
  const control = String(CONTACT_KINDS[kind]?.control || '').trim();
  const text = String(description || '').trim();
  if (!control) return text;
  if (text.includes(control)) return text;
  return `${text} ${control}`.trim();
}

function hydrateContact(contact) {
  if (!contact) return contact;
  const control = contactControlRule(contact);
  if (!control || contact.control === control) return contact;
  return { ...contact, control };
}

/**
 * Текст явно про разлёт/уход островов в небе, а не только «мостик обвалился».
 * @param {string} body
 */
export function assertsIslandsParted(body) {
  const t = String(body || '');
  const parting =
    /(разошл|разъедин|разъехал).{0,50}остров/i.test(t) ||
    /остров.{0,50}(разошл|разъедин|разъехал|улетел|ушёл|ушла|ушли)/i.test(t) ||
    /(разошл|разъедин|разъехал).{0,40}(в\s+небе|в\s+дал|над\s+бездн)/i.test(t) ||
    /чужой\s+(край|остров).{0,40}(уш[её]л|ушла|улетел|тает|растворился)/i.test(t) ||
    /(край|силуэт).{0,30}(тает|растворился|уш[её]л|ушла).{0,40}(неб|облак|дал|бездн)/i.test(t) ||
    /между.{0,20}(город|остров).{0,40}(нет|больше нет).{0,20}(путь|пути)/i.test(t) ||
    /(улетел|ушёл|ушла|ушли).{0,30}(в\s+неб|в\s+дал|в\s+облак)/i.test(t);
  const bridgeOnly =
    /мост.{0,30}(рухн|обвал|разруш|облом|рухнул)/i.test(t) && !parting;
  return Boolean(parting) && !bridgeOnly;
}

function confluxCfg(config) {
  return config?.tick?.conflux || {};
}

function randIntInclusive(min, max, rng = Math.random) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.floor(rng() * (b - a + 1));
}

/** Взвешенный выбор kind контакта (системный ГСЧ). */
export function rollContactKind(weights, rng = Math.random) {
  const entries = Object.entries(weights || {}).filter(
    ([k, w]) => CONTACT_KINDS[k] && Number(w) > 0,
  );
  if (!entries.length) return 'causeway';
  const total = entries.reduce((s, [, w]) => s + Number(w), 0);
  let r = rng() * total;
  for (const [kind, w] of entries) {
    r -= Number(w);
    if (r <= 0) return kind;
  }
  return entries[entries.length - 1][0];
}

function dockedFraction(domain) {
  const d = Number(domain.confluxMonthsDocked || 0);
  const s = Number(domain.confluxMonthsSolo || 0);
  const t = d + s;
  if (t <= 0) return 0;
  return d / t;
}

function timesMet(domainA, domainB) {
  const fromA = Number(domainA?.confluxPartners?.[domainB.id] || 0);
  const fromB = Number(domainB?.confluxPartners?.[domainA.id] || 0);
  return Math.max(fromA, fromB);
}

/** Подтянуть confluxPartners из истории docked/ended (старые миры без счётчика). */
async function hydratePartnersFromHistory(storage, domains) {
  const byId = new Map(domains.map((d) => [d.id, d]));
  const list = await storage.listConfluxes();
  /** @type {Map<string, number>} */
  const counts = new Map();
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const c of list) {
    if (c.status !== 'ended' && c.status !== 'docked') continue;
    const ids = (c.domainIds || []).filter((id) => byId.has(id));
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKey(ids[i], ids[j]);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }

  for (const [key, n] of counts) {
    const [idA, idB] = key.split('|');
    const a = byId.get(idA);
    const b = byId.get(idB);
    if (!a || !b) continue;
    a.confluxPartners = a.confluxPartners || {};
    b.confluxPartners = b.confluxPartners || {};
    a.confluxPartners[b.id] = Math.max(Number(a.confluxPartners[b.id] || 0), n);
    b.confluxPartners[a.id] = Math.max(Number(b.confluxPartners[a.id] || 0), n);
  }
}

function recordPartnerDock(a, b) {
  a.confluxPartners = a.confluxPartners || {};
  b.confluxPartners = b.confluxPartners || {};
  a.confluxPartners[b.id] = Number(a.confluxPartners[b.id] || 0) + 1;
  b.confluxPartners[a.id] = Number(b.confluxPartners[a.id] || 0) + 1;
}

/**
 * @param {object} opts
 * @param {string[]} opts.domainIds
 * @param {number} opts.etaMonths
 * @param {object} opts.world
 * @param {string} [opts.type]
 * @param {number} [opts.durationMonths]
 * @param {boolean} [opts.rematch]
 */
export function createConfluxRecord({
  domainIds,
  etaMonths,
  world,
  type = 'docking',
  durationMonths = 3,
  rematch = false,
}) {
  const eta = Math.max(1, Math.min(24, Math.round(Number(etaMonths) || 3)));
  const dur = Math.max(1, Math.min(12, Math.round(Number(durationMonths) || 3)));
  const tick = world.tickIndex || 0;
  return {
    id: newId('conflux'),
    worldId: world.id,
    domainIds: domainIds.map(String),
    type,
    status: 'approaching',
    createdTick: tick,
    etaMonths: eta,
    dockAtTick: tick + eta,
    durationMonths: dur,
    monthsDocked: 0,
    rematch: Boolean(rematch),
    contact: null,
    sharedLore: [],
    sharedState: { events: [] },
    awareness: Object.fromEntries(domainIds.map((id) => [String(id), 0])),
    knownLoreIds: Object.fromEntries(domainIds.map((id) => [String(id), []])),
    plotlines: [],
    closedPlotlines: [],
    processes: [],
    lore: [],
    mainPlotId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function monthsUntilDock(conflux, world) {
  const at = conflux.dockAtTick ?? (conflux.createdTick || 0) + (conflux.etaMonths || 1);
  return Math.max(0, at - (world.tickIndex || 0));
}

/** Забрать нити (кроме указов), завести главную нить стыка, записать канон сближения. */
export function beginConfluxOwnership({ a, b, conflux, world, config }) {
  normalizeConfluxBoard(conflux);
  takeDomainBoardIntoConflux(a, conflux);
  takeDomainBoardIntoConflux(b, conflux);
  const main = createMainConfluxPlot({ a, b, conflux, world, config });
  conflux.plotlines.push(main);
  conflux.mainPlotId = main.id;

  const remaining = monthsUntilDock(conflux, world);
  const textA = approachingAnnounceText(a, b, remaining, conflux.rematch);
  const textB = approachingAnnounceText(b, a, remaining, conflux.rematch);
  const tags = conflux.rematch
    ? ['approaching', 'seed', 'rematch']
    : ['approaching', 'seed'];
  const fa = pushPublicChronicle(a, world, textA, conflux, tags);
  const fb = pushPublicChronicle(b, world, textB, conflux, tags);
  mirrorToShared(conflux, fa);
  void fb;
  pushInternalChronicle(conflux, {
    text: textA,
    world,
    plotIds: [main.id],
    tags,
    author: 'conflux',
  });
  return { main, textA, textB };
}

function pushPublicChronicle(domain, world, text, conflux, extraTags = []) {
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared', ...extraTags],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author: 'conflux',
    // Сближение чужого острова — важнейшее событие для города, не фон.
    importance: 'critical',
  });
  domain.lore = domain.lore || [];
  domain.lore.push(fact);
  return fact;
}

function mirrorToShared(conflux, fact) {
  conflux.sharedLore = conflux.sharedLore || [];
  conflux.sharedLore.push({ ...fact });
}

function approachingSeedTexts(a, b, remaining, rematch) {
  const rematchNote = rematch
    ? ' Это повторный конфлюкс: острова уже сходились раньше.'
    : '';
  return {
    textA:
      `На горизонте всё яснее виден чужой летающий остров — город «${b.name}» с одной стороны ` +
      `и «${a.name}» с другой сближаются. Стыковка уже неизбежна; по приметам — примерно через ${remaining} мес.` +
      rematchNote,
    textB:
      `На горизонте всё яснее виден чужой летающий остров — город «${a.name}» сближается с «${b.name}». ` +
      `Стыковка уже неизбежна; по приметам — примерно через ${remaining} мес.` +
      rematchNote,
  };
}

/**
 * Force-create conflux between two domains; seed approaching chronicle.
 */
export async function forceCreateConflux({
  storage,
  domainIdA,
  domainIdB,
  etaMonths = 3,
  durationMonths = 3,
  config = null,
}) {
  const log = getLogger().child({ scope: 'conflux' });
  const world = await storage.getWorld();
  const a = await storage.getDomain(domainIdA);
  const b = await storage.getDomain(domainIdB);
  if (!a || !b) {
    throw new Error('Оба домена должны существовать');
  }
  if (a.id === b.id) {
    throw new Error('Нужны два разных домена');
  }
  if (a.worldId !== world.id || b.worldId !== world.id) {
    throw new Error('Домены должны быть в текущем мире');
  }
  normalizeDomain(a);
  normalizeDomain(b);
  await hydratePartnersFromHistory(storage, [a, b]);

  const active = await storage.listConfluxes({ status: ['approaching', 'docked'] });
  for (const c of active) {
    const ids = new Set(c.domainIds || []);
    if (ids.has(a.id) || ids.has(b.id)) {
      throw new Error(`Домен уже в активном conflux ${c.id} (${c.status})`);
    }
  }

  const rematch = timesMet(a, b) > 0;
  const conflux = createConfluxRecord({
    domainIds: [a.id, b.id],
    etaMonths,
    durationMonths,
    world,
    rematch,
  });

  const { textA, textB } = beginConfluxOwnership({
    a,
    b,
    conflux,
    world,
    config: config || storage.config,
  });

  await storage.saveDomain(a);
  await storage.saveDomain(b);
  await storage.saveConflux(conflux);

  log.info('conflux.created', {
    id: conflux.id,
    domains: [a.name, b.name],
    etaMonths: conflux.etaMonths,
    dockAtTick: conflux.dockAtTick,
    rematch,
  });

  return {
    conflux,
    domains: [a, b],
    announce: { [a.id]: textA, [b.id]: textB },
  };
}

/**
 * Счётчики жизни: docked = конфлюкс; approaching и соло = соло.
 * Цель ~50/50 по доле docked / (docked+solo).
 */
export async function advanceConfluxLifetimeCounters({ storage, world }) {
  const active = await storage.listConfluxes({ status: ['approaching', 'docked'] });
  const dockedIds = new Set();
  for (const c of active) {
    if (c.status !== 'docked') continue;
    for (const id of c.domainIds || []) dockedIds.add(id);
  }

  const domains = await storage.listDomains();
  for (const domain of domains) {
    if (domain.status && domain.status !== 'playing') continue;
    if (domain.worldId && world?.id && domain.worldId !== world.id) continue;
    normalizeDomain(domain);
    if (dockedIds.has(domain.id)) {
      domain.confluxMonthsDocked = Number(domain.confluxMonthsDocked || 0) + 1;
    } else {
      domain.confluxMonthsSolo = Number(domain.confluxMonthsSolo || 0) + 1;
    }
    await storage.saveDomain(domain);
  }
}

/**
 * Авто-матчмейкинг: не трогает домены младше minDomainAgeMonths;
 * предпочитает недобранных по docked-доле и пары, которые ещё не встречались.
 */
export async function maybeMatchmakeConfluxes({ config, storage, world, rng = Math.random }) {
  const cfg = confluxCfg(config);
  const log = getLogger().child({ scope: 'conflux.match' });
  const notes = [];
  if (cfg.enabled === false) return { notes, created: [] };

  const target = Number(cfg.targetDockedFraction ?? 0.5);
  const minAge = Math.max(0, Math.round(Number(cfg.minDomainAgeMonths ?? 6)));
  const maxPairs = Math.max(0, Math.round(Number(cfg.maxNewPairsPerTick ?? 2)));
  const preferNeverMet = cfg.preferNeverMet !== false;
  const tick = world.tickIndex || 0;

  if (maxPairs <= 0) return { notes, created: [] };

  const active = await storage.listConfluxes({ status: ['approaching', 'docked'] });
  const busy = new Set();
  for (const c of active) {
    for (const id of c.domainIds || []) busy.add(id);
  }

  const domains = (await storage.listDomains())
    .filter((d) => (!d.status || d.status === 'playing') && (!world?.id || d.worldId === world.id))
    .map((d) => {
      normalizeDomain(d);
      return d;
    });
  await hydratePartnersFromHistory(storage, domains);

  const eligible = domains.filter((d) => {
    if (busy.has(d.id)) return false;
    const age = tick - Number(d.createdTick || 0);
    return age >= minAge;
  });

  /** Кто сильнее «должен» в docked: дефицит относительно target. */
  function needScore(d) {
    const frac = dockedFraction(d);
    return target - frac;
  }

  const needy = eligible.filter((d) => needScore(d) > 0.02);
  const pool = needy.length >= 2 ? needy : eligible;
  if (pool.length < 2) return { notes, created: [] };

  const etaMin = Number(cfg.etaMonths?.min ?? 2);
  const etaMax = Number(cfg.etaMonths?.max ?? 4);
  const durMin = Number(cfg.durationMonths?.min ?? 2);
  const durMax = Number(cfg.durationMonths?.max ?? 4);

  const created = [];
  const used = new Set();

  for (let n = 0; n < maxPairs; n++) {
    const free = pool.filter((d) => !used.has(d.id) && !busy.has(d.id));
    if (free.length < 2) break;

    /** @type {{ a: object, b: object, score: number, met: number }[]} */
    const candidates = [];
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i];
        const b = free[j];
        const met = timesMet(a, b);
        let score = needScore(a) + needScore(b) + rng() * 0.15;
        if (preferNeverMet) {
          if (met === 0) score += 2;
          else score -= 1 + Math.min(3, met) * 0.5;
        }
        candidates.push({ a, b, score, met });
      }
    }
    if (!candidates.length) break;
    candidates.sort((x, y) => y.score - x.score);
    const pick = candidates[0];
    const rematch = pick.met > 0;
    const etaMonths = randIntInclusive(etaMin, etaMax, rng);
    const durationMonths = randIntInclusive(durMin, durMax, rng);

    const conflux = createConfluxRecord({
      domainIds: [pick.a.id, pick.b.id],
      etaMonths,
      durationMonths,
      world,
      rematch,
    });
    const { textA, textB } = beginConfluxOwnership({
      a: pick.a,
      b: pick.b,
      conflux,
      world,
      config,
    });

    await storage.saveDomain(pick.a);
    await storage.saveDomain(pick.b);
    await storage.saveConflux(conflux);

    used.add(pick.a.id);
    used.add(pick.b.id);
    busy.add(pick.a.id);
    busy.add(pick.b.id);
    created.push(conflux);
    notes.push({
      confluxId: conflux.id,
      phase: 'matchmake',
      domains: [pick.a.name, pick.b.name],
      rematch,
      etaMonths,
      durationMonths,
      announce: {
        [pick.a.id]: textA,
        [pick.b.id]: textB,
      },
    });
    log.info('conflux.matchmake', {
      id: conflux.id,
      domains: [pick.a.name, pick.b.name],
      rematch,
      etaMonths,
      durationMonths,
      scores: { a: needScore(pick.a), b: needScore(pick.b) },
    });
  }

  return { notes, created };
}

export function confluxSummary(c, world, domainsById = {}) {
  const names = (c.domainIds || []).map((id) => domainsById[id]?.name || id);
  return {
    id: c.id,
    status: c.status,
    type: c.type,
    domainIds: c.domainIds,
    domainNames: names,
    etaMonths: c.etaMonths,
    dockAtTick: c.dockAtTick,
    monthsUntilDock: world ? monthsUntilDock(c, world) : null,
    durationMonths: c.durationMonths,
    monthsDocked: c.monthsDocked || 0,
    rematch: Boolean(c.rematch),
    contact: hydrateContact(c.contact),
  };
}

function trackChronicleAdd(map, domainId, fact) {
  if (!map.has(domainId)) map.set(domainId, []);
  map.get(domainId).push(fact);
}

/**
 * Before resolves: approaching prelude / dock transition.
 * Does NOT advance monthsDocked / end — call `advanceDockedConfluxes` after pair resolve.
 *
 * @returns {{
 *   dockedDomainIds: Set<string>,
 *   dockedConfluxes: object[],
 *   chronicleAddsByDomain: Map<string, object[]>,
 *   notes: object[],
 * }}
 */
export async function processConfluxApproachingPhase({
  config,
  runtime,
  storage,
  world,
}) {
  const log = getLogger().child({ scope: 'conflux.tick' });
  const list = await storage.listConfluxes({ status: ['approaching', 'docked'] });
  const dockedDomainIds = new Set();
  const dockedConfluxes = [];
  const chronicleAddsByDomain = new Map();
  const notes = [];

  for (const conflux of list) {
    if (conflux.status === 'docked') {
      for (const id of conflux.domainIds || []) dockedDomainIds.add(id);
      dockedConfluxes.push(conflux);
      continue;
    }
    if (conflux.status !== 'approaching') continue;

    const domains = [];
    for (const id of conflux.domainIds || []) {
      const d = await storage.getDomain(id);
      if (!d) throw new Error(`Conflux ${conflux.id}: domain ${id} missing`);
      normalizeDomain(d);
      domains.push(d);
    }

    const remaining = monthsUntilDock(conflux, world);

    if (remaining > 0) {
      // Seed already written on create (matchmake / force) — skip duplicate same tick.
      if (Number(conflux.createdTick) === Number(world.tickIndex)) {
        notes.push({
          confluxId: conflux.id,
          phase: 'approaching',
          monthsUntilDock: remaining,
          seededThisTick: true,
        });
        continue;
      }
      const [a, b] = domains;
      const textA = approachMonthText(b.name, remaining, conflux.rematch);
      const textB = approachMonthText(a.name, remaining, conflux.rematch);
      const fa = pushPublicChronicle(a, world, textA, conflux, [
        'approaching',
        ...(conflux.rematch ? ['rematch'] : []),
      ]);
      const fb = pushPublicChronicle(b, world, textB, conflux, [
        'approaching',
        ...(conflux.rematch ? ['rematch'] : []),
      ]);
      mirrorToShared(conflux, fa);
      trackChronicleAdd(chronicleAddsByDomain, a.id, fa);
      trackChronicleAdd(chronicleAddsByDomain, b.id, fb);
      if (conflux.mainPlotId) {
        pushInternalChronicle(conflux, {
          text: textA,
          world,
          plotIds: [conflux.mainPlotId],
          tags: ['approaching'],
        });
      }
      await storage.saveDomain(a);
      await storage.saveDomain(b);
      await storage.saveConflux(conflux);
      notes.push({
        confluxId: conflux.id,
        phase: 'approaching',
        monthsUntilDock: remaining,
        photoSoon: remaining === 1,
      });
      log.info('conflux.prelude', { id: conflux.id, remaining, photoSoon: remaining === 1 });
      continue;
    }

    // Dock now — pair resolve runs this same tick
    const contact = await generateContact({ config, runtime, conflux, domains, world, log });
    conflux.status = 'docked';
    conflux.contact = contact;
    conflux.monthsDocked = 0;
    conflux.dockedTick = world.tickIndex;

    if (domains.length >= 2) {
      recordPartnerDock(domains[0], domains[1]);
    }

    let contactText = contact.description;
    if (conflux.rematch && !/повторн/i.test(contactText)) {
      contactText =
        `${contactText} Это повторный конфлюкс: острова «${domains[0].name}» и «${domains[1].name}» уже сходились раньше.`;
    }

    let sharedOnce = false;
    for (const d of domains) {
      const f = createLoreFact({
        id: newId('lore'),
        text: contactText,
        tags: [
          'chronicle',
          'conflux',
          `conflux:${conflux.id}`,
          'shared',
          'docked',
          'contact',
          ...(conflux.rematch ? ['rematch'] : []),
        ],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'conflux-resolver',
        importance: 'critical',
      });
      d.lore = d.lore || [];
      d.lore.push(f);
      if (!sharedOnce) {
        mirrorToShared(conflux, f);
        sharedOnce = true;
      }
      trackChronicleAdd(chronicleAddsByDomain, d.id, f);
      dockedDomainIds.add(d.id);
      await storage.saveDomain(d);
    }
    if (conflux.mainPlotId) {
      pushInternalChronicle(conflux, {
        text: contactText,
        world,
        plotIds: [conflux.mainPlotId],
        tags: ['docked', 'contact'],
        author: 'conflux-resolver',
      });
    }
    await storage.saveConflux(conflux);
    dockedConfluxes.push(conflux);
    notes.push({
      confluxId: conflux.id,
      phase: 'docked',
      contact: contactText,
      rematch: Boolean(conflux.rematch),
      contactKind: contact.kind,
    });
    log.info('conflux.docked', {
      id: conflux.id,
      kind: contact.kind,
      rematch: Boolean(conflux.rematch),
      contact: contactText?.slice(0, 160),
    });
  }

  return { dockedDomainIds, dockedConfluxes, chronicleAddsByDomain, notes };
}

/**
 * After pair resolve: count docked months and end when duration elapses.
 * Undock chronicle is returned so tick news can include it the same month.
 *
 * @returns {{ notes: object[], undockAddsByDomain: Map<string, object[]> }}
 */
export async function advanceDockedConfluxes({ storage, runtime, world }, dockedConfluxes) {
  const log = getLogger().child({ scope: 'conflux.tick' });
  const notes = [];
  const undockAddsByDomain = new Map();

  for (const stub of dockedConfluxes || []) {
    const conflux = (await storage.getConflux(stub.id)) || stub;
    if (conflux.status !== 'docked') continue;

    conflux.monthsDocked = Number(conflux.monthsDocked || 0) + 1;
    if (conflux.monthsDocked >= Number(conflux.durationMonths || 3)) {
      conflux.status = 'ended';
      conflux.endedTick = world.tickIndex;

      const domains = [];
      for (const id of conflux.domainIds || []) {
        const d = await storage.getDomain(id);
        if (d) domains.push(d);
      }
      const endText =
        domains.length >= 2
          ? await generateUndockChronicle({ runtime, conflux, domains, world, log })
          : 'Острова разошлись в небе; пути между ними больше нет.';

      let sharedOnce = false;
      for (const d of domains) {
        const f = createLoreFact({
          id: newId('lore'),
          text: endText,
          tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared', 'ended', 'undock'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: 'conflux-resolver',
          importance: 'critical',
        });
        d.lore = d.lore || [];
        d.lore.push(f);
        if (!sharedOnce) {
          mirrorToShared(conflux, f);
          sharedOnce = true;
        }
        if (!undockAddsByDomain.has(d.id)) undockAddsByDomain.set(d.id, []);
        undockAddsByDomain.get(d.id).push(f);
      }
      if (conflux.mainPlotId) {
        pushInternalChronicle(conflux, {
          text: endText,
          world,
          plotIds: [conflux.mainPlotId],
          tags: ['ended', 'undock'],
          author: 'conflux-resolver',
        });
      }
      const byId = new Map(domains.map((d) => [d.id, d]));
      await returnBoardsOnUndock(conflux, byId, {
        decideContinuation: async ({ plot, domainId, domain }) =>
          decideUndockContinuation({
            runtime,
            plot,
            domain,
            partner: domains.find((x) => x.id !== domainId) || null,
            world,
            log,
          }),
      });
      for (const d of byId.values()) {
        await storage.saveDomain(d);
      }
      notes.push({
        confluxId: conflux.id,
        phase: 'ended',
        monthsDocked: conflux.monthsDocked,
        text: endText,
      });
      log.info('conflux.ended', {
        id: conflux.id,
        monthsDocked: conflux.monthsDocked,
        textPreview: endText.slice(0, 160),
      });
    }
    await storage.saveConflux(conflux);
  }

  return { notes, undockAddsByDomain };
}

/** Active docked conflux containing this domain, or null. */
export async function findDockedConfluxForDomain(storage, domainId) {
  const list = await storage.listConfluxes({ status: ['docked'] });
  return list.find((c) => (c.domainIds || []).includes(domainId)) || null;
}

/** Approaching или docked conflux домена — оба являются каноном для агентов. */
export async function findActiveConfluxForDomain(storage, domainId) {
  const list = await storage.listConfluxes({ status: ['approaching', 'docked'] });
  return list.find((c) => (c.domainIds || []).includes(domainId)) || null;
}

async function generateUndockChronicle({ runtime, conflux, domains, world, log }) {
  const nameA = domains[0].name;
  const nameB = domains[1].name;
  const draft = { text: null };

  const looksLikeIslandsParted = (body) => assertsIslandsParted(body);

  const tools = [
    {
      name: 'submit_undock',
      description:
        'Канон расстыковки: ОСТРОВА разошлись в небе. Не «мостик сломался» — именно разлёт островов.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description:
              `2–4 предложения. ОБЯЗАТЕЛЬНО «${nameA}» и «${nameB}». ` +
              'Главное: два летающих острова разошлись в небе; пути между ними больше нет. ' +
              'НЕ своди к обвалу моста — мост/переход исчезает потому, что острова ушли.',
          },
        },
      },
      handler: async ({ text }) => {
        const body = String(text || '').trim();
        if (body.length < 40) {
          return toolFail(
            'too_short',
            'Текст слишком короткий (<40 символов). Напиши 2–4 предложения про разлёт островов с именами обоих городов.',
          );
        }
        if (!body.includes(nameA) || !body.includes(nameB)) {
          return toolFail(
            'names_required',
            `Нужны оба названия в тексте: «${nameA}» и «${nameB}». Перепиши submit_undock.`,
          );
        }
        if (!looksLikeIslandsParted(body)) {
          return toolFail(
            'islands_not_parted',
            'Нужен разлёт ОСТРОВОВ в небе (не только обвал моста). Перепиши: острова разошлись, пути нет.',
          );
        }
        draft.text = body;
        return { ok: true };
      },
    },
  ];

  const contactHint = conflux.contact
    ? `Бывший контакт: ${formatContactForPrompt(conflux.contact)}`
    : '';

  try {
    await runtime.run({
      agentId: 'confluxResolver',
      tools,
      maxTurns: 5,
      toolChoice: { type: 'function', function: { name: 'submit_undock' } },
      log,
      scene: 'conflux_undock',
      domainId: `${domains[0].id}+${domains[1].id}`,
      userMessages: [
        {
          role: 'user',
          content: [
            `Расстыковка. Дата: ${world.gameDate?.label || ''}.`,
            `Летающие острова городов «${nameA}» и «${nameB}» расходятся.`,
            contactHint,
            '',
            'Вызови submit_undock. Одна каноническая запись для хроники обоих.',
            `Обязательный смысл: «${nameA} и ${nameB} разошлись в небе — между ними снова нет никакого пути».`,
            'ЗАПРЕЩЕНО сводить событие к «мостик обвалился». Мост/переход кончается потому, что острова ушли.',
            'Глорифицируй: ветер, бездна, силуэт чужого края тает вдали. Без третьего острова.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('conflux.undock_llm_failed', { error: err.message });
  }

  if (draft.text) return draft.text;

  return (
    `«${nameA}» и «${nameB}» разошлись в небе: чужой край ушёл в даль облаков, ` +
    'и между городами снова нет никакого пути — ни моста, ни щели, лишь ветер над бездной.'
  );
}

function fallbackContactDescription(kind, nameA, nameB) {
  let geo;
  switch (kind) {
    case 'hairline':
      geo =
        `Между краями «${nameA}» и «${nameB}» остался лишь волосок камня: ` +
        'пройти можно по одному, боком, цепляясь за выступы; обозы и толпы здесь невозможны.';
      break;
    case 'gap_jump':
      geo =
        `Между «${nameA}» и «${nameB}» — узкая щель над бездной: ` +
        'переходят прыжком или по шатким доскам; с грузом почти никто не рискнёт.';
      break;
    case 'gorge':
      geo =
        `Между краями «${nameA}» и «${nameB}» легло узкое ущелье: ` +
        'спускаются и поднимаются цепочкой, цепляясь за камень; обозы здесь не пройдут.';
      break;
    case 'wagon_pass':
      geo =
        `Между «${nameA}» и «${nameB}» легла тесная дорога: ` +
        'два обоза разъедутся, только если один посторонится; пешие идут свободно, войско строем уже жмётся к краю.';
      break;
    case 'causeway':
      geo =
        `Края «${nameA}» и «${nameB}» сошлись широким проходом: ` +
        'рота проходит свободно, при нужде пройдёт и целое войско колонной, обозы идут следом.';
      break;
    case 'landmass':
      geo =
        `Острова «${nameA}» и «${nameB}» сошлись берег в берег: ` +
        'края лежат вплотную, как одна земля, — ходят толпами, где хотят, без мостов и щелей.';
      break;
    case 'bridge':
    default:
      geo =
        `Между краями островов «${nameA}» и «${nameB}» легла узкая каменная перемычка: ` +
        'по ней можно пройти цепочкой из одного города в другой, но обозы и тяжёлые грузы не пройдут, ' +
        'пока не укрепят перемычку.';
      break;
  }
  return withCanonicalControl(kind, geo);
}

async function generateContact({ config, runtime, conflux, domains, world, log }) {
  const nameA = domains[0].name;
  const nameB = domains[1].name;
  const cfg = confluxCfg(config);
  const kind = rollContactKind(cfg.contactWeights, Math.random);
  const meta = CONTACT_KINDS[kind] || CONTACT_KINDS.bridge;
  const reliefId = rollRelief(Math.random);
  const relief = RELIEF_KINDS[reliefId];
  const rematchLine = conflux.rematch
    ? 'Это повторное сопряжение — острова уже сходились; упомяни это коротко, если уместно.'
    : '';
  const draft = { contact: null };

  const tools = [
    {
      name: 'submit_contact',
      description:
        'Опиши переход ЗАДАННОЙ ширины и рельефа (пойдёт в хронику обоих дословно). Kind и рельеф уже выбраны системой.',
      parameters: {
        type: 'object',
        required: ['description'],
        properties: {
          description: {
            type: 'string',
            description:
              `2–4 предложения по-русски. ОБЯЗАТЕЛЬНО назови оба города «${nameA}» и «${nameB}». ` +
              `Геометрия уже задана (${kind} — ${meta.label}): ${meta.hint} ` +
              `Рельеф: ${relief.label} — ${relief.hint} ` +
              `Можно ли закрыть проход: ${meta.control} Впиши это в описание, не противореча. ` +
              `Встречу называй сопряжением, не стыком.`,
          },
        },
      },
      handler: async ({ description }) => {
        const text = String(description || '').trim();
        if (text.length < 40) {
          return toolFail(
            'too_short',
            'description слишком короткий (<40 символов). Напиши 2–4 предложения с именами обоих городов.',
          );
        }
        if (!text.includes(nameA) || !text.includes(nameB)) {
          return toolFail(
            'names_required',
            `В description должны быть названия обоих городов: «${nameA}» и «${nameB}». Перепиши submit_contact.`,
          );
        }
        draft.contact = {
          kind,
          relief: reliefId,
          description: withCanonicalControl(kind, text),
          control: meta.control,
          atTick: world.tickIndex,
          rolled: true,
        };
        return { ok: true };
      },
    },
  ];

  try {
    await runtime.run({
      agentId: 'confluxResolver',
      tools,
      maxTurns: 5,
      toolChoice: { type: 'function', function: { name: 'submit_contact' } },
      log,
      scene: 'conflux_contact',
      domainId: `${domains[0].id}+${domains[1].id}`,
      userMessages: [
        {
          role: 'user',
          content: [
            `Внеочередное событие сопряжения. Дата: ${world.gameDate?.label || ''}.`,
            `Острова городов «${nameA}» и «${nameB}» сошлись краями.`,
            '',
            `Ширина прохода УЖЕ ВЫБРАНА системой: kind=${kind} («${meta.label}»).`,
            `Опиши именно это: ${meta.hint}`,
            `Рельеф УЖЕ ВЫБРАН: ${relief.label} — ${relief.hint}`,
            `Можно ли закрыть или перекрыть этот проход: ${meta.control}`,
            'Это правда геометрии — впиши в описание своими словами и не противоречь. Не выдумывай ворота, створы и засовы, если их здесь быть не может.',
            'НЕ меняй ширину и рельеф на другие. Встречу называй сопряжением, не стыком.',
            rematchLine,
            '',
            'Вызови submit_contact только с description.',
            `В тексте ОБЯЗАТЕЛЬНО оба имени: «${nameA}» и «${nameB}».`,
            'Конкретно, по-русски. Не выдумывай третий остров. Это одна запись на оба города.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('conflux.contact_llm_failed', { error: err.message, kind });
  }

  if (draft.contact) return draft.contact;

  return {
    kind,
    relief: reliefId,
    description: fallbackContactDescription(kind, nameA, nameB),
    control: meta.control,
    atTick: world.tickIndex,
    fallback: true,
    rolled: true,
  };
}
