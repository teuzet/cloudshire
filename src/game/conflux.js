import { newId } from './ids.js';
import { createLoreFact, normalizeDomain } from './models.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { gameDateFromDay, worldDateLabel } from './gameClock.js';
import { scheduleJob, cancelJobs, cancelJobsForPlot, commitWorldChanges } from './scheduler.js';
import {
  confluxConfig,
  hoursToGameDays,
  daysUntilDock,
  pairPrimaryId,
  pickPrepDelayHours,
  confluxDue,
  stampNextConflux,
  domainActivityForSchedule,
  rollConfluxSpan,
} from './confluxTime.js';
import { notifySettings } from './notify.js';
import {
  normalizeConfluxBoard,
  takeDomainBoardIntoConflux,
  createEmptyContainer,
  seedPartingClock,
  seedDockMeet,
  PARTING_ENDING_ID,
  approachingAnnounceText,
  returnBoardsOnUndock,
} from './confluxBoard.js';
import { fireThreat } from './threats.js';
import { resyncThreatJobs } from './worldLoop.js';
import { maybeNudgeProxy } from './proxyJudge.js';
import { decideUndockContinuation } from './undockContinuation.js';
import { publishPairCanon, PLACE_PAIR } from './confluxCanon.js';
import { releaseOfficerProcess } from './officers.js';
import { ensurePassage } from './passage.js';
import { applyUndockTrace } from './confluxTrace.js';
import { enqueueSeedRequest } from './seedSchedule.js';

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
  return confluxConfig(config);
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
  world,
  type = 'docking',
  rematch = false,
  prepStartDay = 0,
  dockStartDay = 0,
  dockEndDay = 0,
  etaMonths = null,
  durationMonths = null,
}) {
  const tick = world.tickIndex || 0;
  const prep = Math.max(0, Math.round(Number(prepStartDay) || 0));
  const dock = Math.max(prep, Math.round(Number(dockStartDay) || prep));
  const end = Math.max(dock + 1, Math.round(Number(dockEndDay) || dock + 1));
  return {
    id: newId('conflux'),
    worldId: world.id,
    domainIds: domainIds.map(String),
    type,
    status: 'approaching',
    createdTick: tick,
    createdDay: prep,
    prepStartDay: prep,
    dockStartDay: dock,
    dockEndDay: end,
    etaMonths: etaMonths != null ? Math.round(Number(etaMonths)) : Math.max(1, Math.round((dock - prep) / 30)),
    dockAtTick: tick + Math.max(1, Math.round((dock - prep) / 30)),
    durationMonths: durationMonths != null ? Math.round(Number(durationMonths)) : Math.max(1, Math.round((end - dock) / 30)),
    monthsDocked: 0,
    rematch: Boolean(rematch),
    contact: null,
    passage: { text: '', state: 'open', contact: null, relief: null },
    container: null,
    containerPlotId: null,
    plotRefs: [],
    sharedLore: [],
    sharedState: { events: [] },
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
  if (conflux?.dockStartDay != null && world?.dayIndex != null) {
    return Math.max(0, Math.ceil(daysUntilDock(conflux, world.dayIndex) / 30));
  }
  const at = conflux.dockAtTick ?? (conflux.createdTick || 0) + (conflux.etaMonths || 1);
  return Math.max(0, at - (world.tickIndex || 0));
}

export function schedulePairJobs(world, conflux, { contactAtFraction = 0.05, quietSilenceDays = 21 } = {}) {
  if (!world || !conflux) return [];
  const primary = pairPrimaryId(conflux);
  const payload = { confluxId: conflux.id };
  cancelJobs(world, (j) => String(j.payload?.confluxId || '') === String(conflux.id));
  const jobs = [
    scheduleJob(world, { domainId: primary, kind: 'conflux_dock', dueDay: conflux.dockStartDay, payload }),
    scheduleJob(world, { domainId: primary, kind: 'conflux_undock', dueDay: conflux.dockEndDay, payload }),
  ];
  void contactAtFraction;
  const silence = Math.max(1, Math.round(Number(quietSilenceDays) || 21));
  const contactDay = Number(conflux.dockStartDay) + silence;
  jobs.push(
    scheduleJob(world, { domainId: primary, kind: 'conflux_contact', dueDay: contactDay, payload }),
  );
  return jobs;
}

/** Нити остаются у хозяина. Контейнер и часы разъезда — уже при сближении. */
export function beginConfluxOwnership({ a, b, conflux, world, config }) {
  normalizeConfluxBoard(conflux);
  takeDomainBoardIntoConflux(a, conflux);
  takeDomainBoardIntoConflux(b, conflux);

  if (!conflux.container) {
    const container = createEmptyContainer({ a, b, conflux, world, config });
    seedPartingClock(container, {
      day: world?.dayIndex ?? conflux.prepStartDay,
      dockEndDay: conflux.dockEndDay,
    });
    conflux.container = container;
    conflux.containerPlotId = container.id;
    conflux.mainPlotId = container.id;
  }
  if (world) {
    const primary = a.id === pairPrimaryId(conflux) ? a : b;
    resyncThreatJobs(world, primary, conflux.container);
  }

  const months = monthsUntilDock(conflux, world);
  const textA = approachingAnnounceText(a, b, months, conflux.rematch);
  const textB = approachingAnnounceText(b, a, months, conflux.rematch);
  const tags = conflux.rematch ? ['approaching', 'seed', 'rematch'] : ['approaching', 'seed'];
  pushPublicChronicle(a, world, textA, conflux, tags);
  pushPublicChronicle(b, world, textB, conflux, tags);
  return { main: conflux.container, textA, textB };
}

function pushPublicChronicle(domain, world, text, conflux, extraTags = []) {
  const day = Number.isFinite(Number(world?.dayIndex)) ? Math.round(Number(world.dayIndex)) : null;
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared', ...extraTags],
    gameDateLabel: day != null ? gameDateFromDay(day).label : worldDateLabel(world) || world?.gameDate?.label,
    tick: world.tickIndex,
    day,
    author: 'conflux',
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

function pairWindow({
  a,
  b,
  world,
  config,
  now = Date.now(),
  prepDays = null,
  dockDays = null,
  rng = Math.random,
}) {
  const cfg = confluxConfig(config);
  const day = Math.max(0, Math.round(Number(world?.dayIndex) || 0));
  const delayHours = pickPrepDelayHours({
    activityA: domainActivityForSchedule(a),
    activityB: domainActivityForSchedule(b),
    quietA: notifySettings(a).quiet,
    quietB: notifySettings(b).quiet,
    prepHours: 0,
    dockHours: 1,
    slackHours: cfg.scheduleSlackHours,
    samplesMin: cfg.activitySamplesMin,
  });
  const span =
    prepDays != null && dockDays != null
      ? { prepDays: Math.max(1, Math.round(Number(prepDays))), dockDays: Math.max(1, Math.round(Number(dockDays))) }
      : {
          ...rollConfluxSpan(config, rng),
          ...(prepDays != null ? { prepDays: Math.max(1, Math.round(Number(prepDays))) } : {}),
          ...(dockDays != null ? { dockDays: Math.max(1, Math.round(Number(dockDays))) } : {}),
        };
  const prepStartDay = day + hoursToGameDays(delayHours, config);
  const dockStartDay = prepStartDay + span.prepDays;
  const dockEndDay = dockStartDay + span.dockDays;
  void now;
  return { prepStartDay, dockStartDay, dockEndDay, prepDays: span.prepDays, dockDays: span.dockDays };
}

function domainAgeDays(domain, day) {
  if (Number.isFinite(Number(domain?.createdDay))) {
    return Math.max(0, Math.round(Number(day) || 0) - Math.round(Number(domain.createdDay)));
  }
  return Math.max(0, Math.round(Number(day) || 0) - Number(domain?.createdTick || 0) * 30);
}

/**
 * Force-create conflux between two domains; seed approaching chronicle.
 */
export async function forceCreateConflux({
  storage,
  domainIdA,
  domainIdB,
  prepDays = null,
  dockDays = null,
  etaMonths = null,
  durationMonths = null,
  config = null,
  runtime = null,
  rng = Math.random,
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

  const cfg = confluxConfig(config || storage.config);
  const rematch = timesMet(a, b) > 0;
  const resolvedPrep = prepDays != null ? prepDays : etaMonths != null ? Number(etaMonths) * 30 : null;
  const resolvedDock = dockDays != null ? dockDays : durationMonths != null ? Number(durationMonths) * 30 : null;
  const window = pairWindow({
    a,
    b,
    world,
    config: config || storage.config,
    prepDays: resolvedPrep,
    dockDays: resolvedDock,
    rng,
  });
  const conflux = createConfluxRecord({
    domainIds: [a.id, b.id],
    world,
    rematch,
    ...window,
  });

  const { textA, textB } = beginConfluxOwnership({
    a,
    b,
    conflux,
    world,
    config: config || storage.config,
  });
  schedulePairJobs(world, conflux, {
    contactAtFraction: cfg.contactSeedAtFraction,
    quietSilenceDays: cfg.quietSilenceDays,
  });
  await maybeNudgeProxy({
    runtime,
    config: config || storage.config,
    world,
    day: world.dayIndex,
    domains: [a, b],
    trigger: 'approaching',
    context: `Начинается сопряжение с соседом. ${textA}`,
  });
  await storage.updateWorld((fresh) => commitWorldChanges(fresh, world));

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
 * Цель — треть жизни в docked / (docked+solo).
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
 * Авто-матчмейкинг: частота cadenceHours, окно в активные часы пары.
 */
export async function maybeMatchmakeConfluxes({
  config,
  runtime = null,
  storage,
  world,
  rng = Math.random,
  now = Date.now(),
}) {
  const cfg = confluxCfg(config);
  const log = getLogger().child({ scope: 'conflux.match' });
  const notes = [];
  if (cfg.enabled === false) return { notes, created: [] };

  const minAge = cfg.minDomainAgeDays;
  const maxPairs = cfg.maxNewPairsPerDay;
  const preferNeverMet = cfg.preferNeverMet !== false;
  const day = Math.round(Number(world.dayIndex) || 0);

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
    if (!confluxDue(d, now)) return false;
    return domainAgeDays(d, day) >= minAge;
  });

  const pool = eligible;
  if (pool.length < 2) return { notes, created: [] };

  const created = [];
  const used = new Set();

  for (let n = 0; n < maxPairs; n++) {
    const free = pool.filter((d) => !used.has(d.id) && !busy.has(d.id));
    if (free.length < 2) break;

    const candidates = [];
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i];
        const b = free[j];
        const met = timesMet(a, b);
        let score = rng() * 0.15;
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
    const window = pairWindow({ a: pick.a, b: pick.b, world, config, now, rng });
    const conflux = createConfluxRecord({
      domainIds: [pick.a.id, pick.b.id],
      world,
      rematch,
      ...window,
    });
    const { textA, textB } = beginConfluxOwnership({
      a: pick.a,
      b: pick.b,
      conflux,
      world,
      config,
    });
    schedulePairJobs(world, conflux, {
    contactAtFraction: cfg.contactSeedAtFraction,
    quietSilenceDays: cfg.quietSilenceDays,
  });
    await maybeNudgeProxy({
      runtime,
      config,
      world,
      day,
      domains: [pick.a, pick.b],
      trigger: 'approaching',
      context: `Начинается сопряжение «${pick.a.name}» и «${pick.b.name}». ${textA}`,
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
      etaMonths: conflux.etaMonths,
      durationMonths: conflux.durationMonths,
      announce: {
        [pick.a.id]: textA,
        [pick.b.id]: textB,
      },
    });
    log.info('conflux.matchmake', {
      id: conflux.id,
      domains: [pick.a.name, pick.b.name],
      rematch,
      prepStartDay: conflux.prepStartDay,
      dockStartDay: conflux.dockStartDay,
      dockEndDay: conflux.dockEndDay,
    });
  }

  if (created.length) await storage.updateWorld((fresh) => commitWorldChanges(fresh, world));
  return { notes, created };
}

export function confluxSummary(c, world, domainsById = {}) {
  const names = (c.domainIds || []).map((id) => domainsById[id]?.name || id);
  const remainingDock = world?.dayIndex != null ? daysUntilDock(c, world.dayIndex) : null;
  return {
    id: c.id,
    status: c.status,
    type: c.type,
    domainIds: c.domainIds,
    domainNames: names,
    prepStartDay: c.prepStartDay ?? null,
    dockStartDay: c.dockStartDay ?? null,
    dockEndDay: c.dockEndDay ?? null,
    remainingDockDays: remainingDock,
    etaMonths: c.etaMonths,
    dockAtTick: c.dockAtTick,
    monthsUntilDock: world ? monthsUntilDock(c, world) : null,
    durationMonths: c.durationMonths,
    monthsDocked: c.monthsDocked || 0,
    rematch: Boolean(c.rematch),
    passage: c.passage || null,
    contact: hydrateContact(c.contact),
  };
}

export function abortCrossIslandDeeds(domain, { day, reason = 'undock' } = {}) {
  const aborted = [];
  for (const p of domain.state?.pendingActions || []) {
    if (!p.crossIsland && !p.targetDomainId && !p.needsPassage) continue;
    if (p.status && p.status !== 'active' && p.status !== 'paused') continue;
    p.status = 'resolved';
    p.finishKind = 'abort';
    p.abortReason = reason;
    p.resolvedDay = Math.round(Number(day) || 0);
    if (!p.abortOutcome) p.abortOutcome = 'вернуться домой с тем, что успели';
    releaseOfficerProcess(domain, p);
    aborted.push(p);
  }
  return aborted;
}

function formatAbortedForPrompt(aborted, domain) {
  if (!aborted?.length) return '';
  const city = domain?.name || 'город';
  return aborted
    .map((p) => {
      const who = p.characterName || p.office || 'сановник';
      const fate = p.abortOutcome ? `; обрыв: ${p.abortOutcome}` : '';
      return `- у «${city}»: «${p.summary || 'дело'}» (${who})${fate}`;
    })
    .join('\n');
}

/** Дела без флага, которым всё же нужен живой проход. */
export async function flagPassageDeeds({ runtime, domain, partner, log } = {}) {
  const candidates = (domain?.state?.pendingActions || []).filter(
    (p) =>
      (!p.status || p.status === 'active' || p.status === 'paused') &&
      !p.crossIsland &&
      !p.targetDomainId &&
      !p.needsPassage,
  );
  if (!candidates.length || !runtime?.run) return [];
  const draft = { ids: [] };
  try {
    await runtime.run({
      agentId: 'undockPassage',
      scene: 'conflux_undock_passage',
      log,
      domainId: domain.id,
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_passage_needs' } },
      tools: [
        {
          name: 'submit_passage_needs',
          description: 'Какие из этих дел теряют смысл без живого прохода к соседу.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['processIds'],
            properties: {
              processIds: { type: 'array', items: { type: 'string' } },
            },
          },
          handler: async (args) => {
            draft.ids = Array.isArray(args?.processIds) ? args.processIds.map(String) : [];
            return { ok: true };
          },
        },
      ],
      extraSystem:
        'Ты решаешь, каким делам нужен живой проход к соседнему острову. ' +
        'needsPassage=true, если дело готовит встречу, оборону к сопряжению, посольство, переход, удар по соседу — даже если цель не названа. ' +
        'Локальные дела своего острова не трогай. Верни submit_passage_needs.',
      userMessages: [
        {
          role: 'user',
          content: [
            `Город «${domain.name}». Сосед «${partner?.name || '?'}» уходит.`,
            'Идущие дела:',
            candidates.map((p) => `- ${p.id}: ${p.summary || ''} ${p.detail ? `— ${p.detail}` : ''}`).join('\n'),
            'Верни id тех дел, которым без прохода нечего делать.',
          ].join('\n'),
        },
      ],
    });
  } catch (err) {
    (log || getLogger()).warn('conflux.passage_flag_failed', { error: err.message });
    return [];
  }
  const wanted = new Set(draft.ids);
  const flagged = [];
  for (const p of candidates) {
    if (!wanted.has(String(p.id))) continue;
    p.needsPassage = true;
    flagged.push(p);
  }
  return flagged;
}

/** Стыковка: проход, пустой контейнер, канон. */
export async function dockConfluxNow({
  config,
  runtime,
  conflux,
  domains,
  world,
  day = 0,
  log: parentLog,
}) {
  const log = parentLog || getLogger().child({ scope: 'conflux.dock' });
  if (!conflux || conflux.status === 'docked') return { conflux, skipped: 'already_docked' };
  const pair = (domains || []).filter(Boolean);
  if (pair.length < 2) return { conflux, skipped: 'no_pair' };

  conflux.status = 'docked';
  conflux.dockedDay = Math.round(Number(day) || 0);
  conflux.dockedTick = world.tickIndex;
  if (!conflux.container) {
    conflux.container = createEmptyContainer({ a: pair[0], b: pair[1], conflux, world, config });
  }
  const meet = seedDockMeet(conflux.container, { day });
  if (meet?.status === 'live') fireThreat(conflux.container, meet, { day, firedBy: 'dock' });
  seedPartingClock(conflux.container, { day, dockEndDay: conflux.dockEndDay });
  conflux.containerPlotId = conflux.container.id;
  conflux.mainPlotId = conflux.container.id;

  const contact = await generateContact({ config, runtime, conflux, domains: pair, world, log });
  conflux.contact = contact;
  conflux.passage = {
    text: String(contact.description || '').trim(),
    state: 'open',
    contact,
    relief: contact.relief || null,
    heldByProcessId: null,
  };
  ensurePassage(conflux);
  if (world) {
    const primary = pair.find((d) => d.id === pairPrimaryId(conflux)) || pair[0];
    resyncThreatJobs(world, primary, conflux.container);
  }
  recordPartnerDock(pair[0], pair[1]);

  await publishPairCanon({
    runtime,
    world,
    conflux,
    domains: pair,
    text: contact.description || `Летающие острова городов «${pair[0].name}» и «${pair[1].name}» сошлись.`,
    place: PLACE_PAIR,
    plot: conflux.container,
    day,
    log,
  });
  return { conflux, contact, container: conflux.container };
}

/** Расстыковка: большая хроника, обрыв дел через проход, посев последствий. */
export async function undockConfluxNow({
  runtime,
  conflux,
  domains,
  world,
  day = 0,
  config = null,
  log: parentLog,
  rng = Math.random,
}) {
  const log = parentLog || getLogger().child({ scope: 'conflux.undock' });
  if (!conflux || conflux.status === 'ended') return { conflux, skipped: 'already_ended' };
  const pair = (domains || []).filter(Boolean);
  conflux.status = 'ended';
  conflux.endedDay = Math.round(Number(day) || 0);
  conflux.endedTick = world?.tickIndex;

  const plot = conflux.container;
  if (plot && !plot.ending) {
    const clock = (plot.threats || []).find((t) => t.endingId === PARTING_ENDING_ID && t.status === 'live');
    if (clock) fireThreat(plot, clock, { day, firedBy: 'undock' });
  }
  if (world && plot) cancelJobsForPlot(world, plot.id);

  const abortedByCity = [];
  for (const d of pair) {
    const partner = pair.find((x) => x.id !== d.id) || null;
    await flagPassageDeeds({ runtime, domain: d, partner, log });
    abortedByCity.push({ domain: d, aborted: abortCrossIslandDeeds(d, { day, reason: 'undock' }) });
  }

  const abortedLines = abortedByCity
    .map(({ domain, aborted }) => formatAbortedForPrompt(aborted, domain))
    .filter(Boolean)
    .join('\n');

  if (pair.length >= 2) {
    const text = await generateUndockChronicle({
      runtime,
      conflux,
      domains: pair,
      world,
      log,
      abortedLines,
    });
    await publishPairCanon({
      runtime,
      world,
      conflux,
      domains: pair,
      text,
      place: PLACE_PAIR,
      plot,
      day,
      log,
    });
    applyUndockTrace({ a: pair[0], b: pair[1], conflux, world, day, rng, contagion: false });
    stampNextConflux(pair[0], { config, rng });
    stampNextConflux(pair[1], { config, rng });
    seedUndockAftermath({ pair, conflux, world, day, rng });
  }

  const byId = new Map(pair.map((d) => [d.id, d]));
  await returnBoardsOnUndock(conflux, byId, {
    decideContinuation: async ({ plot: keepPlot, domainId, domain }) =>
      decideUndockContinuation({
        runtime,
        plot: keepPlot,
        domain,
        partner: pair.find((x) => x.id !== domainId) || null,
        world,
        log,
      }),
  });
  return { conflux };
}

function seedUndockAftermath({ pair, conflux, world, day, rng }) {
  for (const domain of pair) {
    const fact = [...(domain.lore || [])]
      .reverse()
      .find((f) => (f.tags || []).includes('subjective') || (f.tags || []).includes('conflux'));
    if (!fact?.text) continue;
    const request = enqueueSeedRequest(domain, {
      source: 'chronicle',
      seedFactId: fact.id,
      grain: fact.text,
      day,
      delayDays: 1,
      rng,
    });
    if (world) {
      scheduleJob(world, {
        domainId: domain.id,
        kind: 'seed_appear',
        dueDay: request.appearDay,
        payload: { requestId: request.id, source: request.source, confluxId: conflux.id },
      });
    }
  }
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
  void config;
  void runtime;
  void storage;
  void world;
  return { dockedDomainIds: new Set(), dockedConfluxes: [], chronicleAddsByDomain: new Map(), notes: [] };
}

export async function advanceDockedConfluxes() {
  return { notes: [], undockAddsByDomain: new Map() };
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

async function generateUndockChronicle({ runtime, conflux, domains, world, log, abortedLines = '' }) {
  const nameA = domains[0].name;
  const nameB = domains[1].name;
  const draft = { text: null };
  const forecast = conflux.forecast || {};
  const forecastLines = [
    forecast.neutral ? `Нейтральный прогноз, который теперь факт: ${forecast.neutral}` : '',
    ...domains.map((d) => (forecast[d.id] ? `Для «${d.name}»: ${forecast[d.id]}` : '')),
  ]
    .filter(Boolean)
    .join('\n');

  const looksLikeIslandsParted = (body) => assertsIslandsParted(body);

  const tools = [
    {
      name: 'submit_undock',
      description:
        'Большая хроника конца сопряжения: острова разошлись, прогноз стал фактом, оборванные дела получили судьбу.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description:
              `3–6 предложений. ОБЯЗАТЕЛЬНО «${nameA}» и «${nameB}». ` +
              'Главное: два летающих острова разошлись в небе; пути между ними больше нет. ' +
              'Прогноз впиши как случившееся. Судьбы оборванных дел — в эту же запись, не шаблоном. ' +
              'НЕ своди к обвалу моста — мост исчезает потому, что острова ушли.',
          },
        },
      },
      handler: async ({ text }) => {
        const body = String(text || '').trim();
        if (body.length < 40) {
          return toolFail(
            'too_short',
            'Текст слишком короткий (<40 символов). Напиши 3–6 предложений про разлёт островов с именами обоих городов.',
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

  if (runtime?.run) {
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
              `Сопряжение кончается. Дата: ${world?.gameDate?.label || ''}.`,
              `Летающие острова городов «${nameA}» и «${nameB}» расходятся.`,
              contactHint,
              forecastLines,
              abortedLines ? `Оборванные дела (впиши их судьбы в хронику, не копируй шаблон):\n${abortedLines}` : '',
              '',
              'Вызови submit_undock. Одна каноническая запись.',
              `Обязательный смысл: «${nameA} и ${nameB} разошлись в небе — между ними снова нет никакого пути».`,
              'ЗАПРЕЩЕНО сводить событие к «мостик обвалился». Мост/переход кончается потому, что острова ушли.',
              'Не пиши голый номер игрового дня.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });
    } catch (err) {
      log?.warn?.('conflux.undock_llm_failed', { error: err.message });
    }
  }

  if (draft.text) return draft.text;

  return (
    `«${nameA}» и «${nameB}» разошлись в небе: чужой край ушёл в даль облаков, ` +
    'и между городами снова нет никакого пути — ни моста, ни щели, лишь ветер над бездной.' +
    (forecast.neutral ? ` ${forecast.neutral}` : '')
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
              `Встречу называй сопряжением.`,
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

  if (!runtime?.run) {
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
            'НЕ меняй ширину и рельеф на другие. Встречу называй сопряжением.',
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
