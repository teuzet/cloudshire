import { newId } from './ids.js';
import { createLoreFact, normalizeDomain } from './models.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

/** Ширина прохода: ГСЧ выбирает kind; LLM только описывает. */
export const CONTACT_KINDS = {
  hairline: {
    label: 'волосок',
    hint:
      'Очень узкий проход: один человек боком, почти нет места; обозы и группы невозможны.',
  },
  bridge: {
    label: 'мостик',
    hint: 'Узкий мостик или каменная перемычка: пешком цепочкой, тяжёлые грузы — с трудом.',
  },
  gap_jump: {
    label: 'щель с прыжком',
    hint: 'Между краями — щель; переходят прыжком или по шатким доскам, не всем и не с грузом.',
  },
  causeway: {
    label: 'широкая насыпь',
    hint: 'Широкая насыпь / стык значительной частью берега: пешие потоки и лёгкие обозы возможны.',
  },
  landmass: {
    label: 'стыковка берегом',
    hint: 'Края срослись почти всем берегом: как один массив, свободный проход толпами и обозами.',
  },
};

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
  if (!entries.length) return 'bridge';
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function monthsUntilDock(conflux, world) {
  const at = conflux.dockAtTick ?? (conflux.createdTick || 0) + (conflux.etaMonths || 1);
  return Math.max(0, at - (world.tickIndex || 0));
}

function pushPublicChronicle(domain, world, text, conflux, extraTags = []) {
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared', ...extraTags],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author: 'conflux',
    importance: 'major',
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

  const remaining = monthsUntilDock(conflux, world);
  const { textA, textB } = approachingSeedTexts(a, b, remaining, rematch);
  const tags = rematch
    ? ['approaching', 'seed', 'rematch']
    : ['approaching', 'seed'];

  const fa = pushPublicChronicle(a, world, textA, conflux, tags);
  const fb = pushPublicChronicle(b, world, textB, conflux, tags);
  mirrorToShared(conflux, fa);
  void fb;

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

  return { conflux, domains: [a, b] };
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
    const remaining = monthsUntilDock(conflux, world);
    const { textA, textB } = approachingSeedTexts(pick.a, pick.b, remaining, rematch);
    const tags = rematch
      ? ['approaching', 'seed', 'rematch', 'matchmake']
      : ['approaching', 'seed', 'matchmake'];
    const fa = pushPublicChronicle(pick.a, world, textA, conflux, tags);
    const fb = pushPublicChronicle(pick.b, world, textB, conflux, tags);
    mirrorToShared(conflux, fa);
    void fb;

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
    contact: c.contact,
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
      const rematchHint = conflux.rematch
        ? ' (повторный конфлюкс — острова уже сходились.)'
        : '';
      const textA =
        `Остров соседа («${b.name}») ближе: в разрывах тумана уже угадывают край чужой земли. ` +
        `До стыковки по приметам осталось около ${remaining} мес.${rematchHint}`;
      const textB =
        `Остров соседа («${a.name}») ближе: в разрывах тумана уже угадывают край чужой земли. ` +
        `До стыковки по приметам осталось около ${remaining} мес.${rematchHint}`;
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
      await storage.saveDomain(a);
      await storage.saveDomain(b);
      await storage.saveConflux(conflux);
      notes.push({ confluxId: conflux.id, phase: 'approaching', monthsUntilDock: remaining });
      log.info('conflux.prelude', { id: conflux.id, remaining });
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

  const contactHint = conflux.contact?.description
    ? `Бывший контакт: ${conflux.contact.description}`
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
  switch (kind) {
    case 'hairline':
      return (
        `Между краями «${nameA}» и «${nameB}» остался лишь волосок камня: ` +
        'пройти можно по одному, боком, цепляясь за выступы; обозы и толпы здесь невозможны.'
      );
    case 'gap_jump':
      return (
        `Между «${nameA}» и «${nameB}» — узкая щель над бездной: ` +
        'переходят прыжком или по шатким доскам; с грузом почти никто не рискнёт.'
      );
    case 'causeway':
      return (
        `Края «${nameA}» и «${nameB}» сошлись широкой насыпью: ` +
        'пешие потоки и лёгкие обозы идут свободно, хотя стык ещё сырой и не везде надёжен.'
      );
    case 'landmass':
      return (
        `Острова «${nameA}» и «${nameB}» срослись почти всем берегом: ` +
        'между городами — сплошной проход, как по одной земле, без мостов и щелей.'
      );
    case 'bridge':
    default:
      return (
        `Между краями островов «${nameA}» и «${nameB}» легла узкая каменная перемычка: ` +
        'по ней можно пройти цепочкой из одного города в другой, но обозы и тяжёлые грузы не пройдут, ' +
        'пока не укрепят стык.'
      );
  }
}

async function generateContact({ config, runtime, conflux, domains, world, log }) {
  const nameA = domains[0].name;
  const nameB = domains[1].name;
  const cfg = confluxCfg(config);
  const kind = rollContactKind(cfg.contactWeights, Math.random);
  const meta = CONTACT_KINDS[kind] || CONTACT_KINDS.bridge;
  const rematchLine = conflux.rematch
    ? 'Это повторный конфлюкс — острова уже сходились; упомяни это коротко, если уместно.'
    : '';
  const draft = { contact: null };

  const tools = [
    {
      name: 'submit_contact',
      description:
        'Внеочередное событие стыка: опиши переход ЗАДАННОЙ ширины (пойдёт в хронику обоих дословно). Kind уже выбран системой.',
      parameters: {
        type: 'object',
        required: ['description'],
        properties: {
          description: {
            type: 'string',
            description:
              `2–4 предложения по-русски. ОБЯЗАТЕЛЬНО назови оба города «${nameA}» и «${nameB}». ` +
              `Геометрия уже задана (${kind} — ${meta.label}): ${meta.hint}`,
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
          description: text,
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
            `Внеочередное событие стыка. Дата: ${world.gameDate?.label || ''}.`,
            `Острова городов «${nameA}» и «${nameB}» сошлись.`,
            '',
            `Ширина прохода УЖЕ ВЫБРАНА системой: kind=${kind} («${meta.label}»).`,
            `Опиши именно это: ${meta.hint}`,
            'НЕ меняй ширину на другую (не делай из волоска сплошной берег и наоборот).',
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
    description: fallbackContactDescription(kind, nameA, nameB),
    atTick: world.tickIndex,
    fallback: true,
    rolled: true,
  };
}
