import { newId } from './ids.js';
import { createLoreFact } from './models.js';
import { getLogger } from '../log.js';

/**
 * @param {object} opts
 * @param {string[]} opts.domainIds
 * @param {number} opts.etaMonths
 * @param {object} opts.world
 * @param {string} [opts.type]
 */
export function createConfluxRecord({
  domainIds,
  etaMonths,
  world,
  type = 'docking',
}) {
  const eta = Math.max(1, Math.min(24, Math.round(Number(etaMonths) || 3)));
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
    durationMonths: 3,
    monthsDocked: 0,
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

  const active = await storage.listConfluxes({ status: ['approaching', 'docked'] });
  for (const c of active) {
    const ids = new Set(c.domainIds || []);
    if (ids.has(a.id) || ids.has(b.id)) {
      throw new Error(`Домен уже в активном conflux ${c.id} (${c.status})`);
    }
  }

  const conflux = createConfluxRecord({
    domainIds: [a.id, b.id],
    etaMonths,
    world,
  });
  conflux.durationMonths = Math.max(1, Math.min(12, Math.round(Number(durationMonths) || 3)));

  const remaining = monthsUntilDock(conflux, world);
  const seedText =
    `На горизонте всё яснее виден чужой летающий остров — город «${b.name}» с одной стороны ` +
    `и «${a.name}» с другой сближаются. Стыковка уже неизбежна; по приметам — примерно через ${remaining} мес.`;

  const fa = pushPublicChronicle(a, world, seedText, conflux, ['approaching', 'seed']);
  const fb = pushPublicChronicle(
    b,
    world,
    `На горизонте всё яснее виден чужой летающий остров — город «${a.name}» сближается с «${b.name}». ` +
      `Стыковка уже неизбежна; по приметам — примерно через ${remaining} мес.`,
    conflux,
    ['approaching', 'seed'],
  );
  mirrorToShared(conflux, fa);
  // keep one shared canonical (from A wording is enough)
  void fb;

  await storage.saveDomain(a);
  await storage.saveDomain(b);
  await storage.saveConflux(conflux);

  log.info('conflux.created', {
    id: conflux.id,
    domains: [a.name, b.name],
    etaMonths: conflux.etaMonths,
    dockAtTick: conflux.dockAtTick,
  });

  return { conflux, domains: [a, b] };
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
      domains.push(d);
    }

    const remaining = monthsUntilDock(conflux, world);

    if (remaining > 0) {
      const [a, b] = domains;
      const textA =
        `Остров соседа («${b.name}») ближе: в разрывах тумана уже угадывают край чужой земли. ` +
        `До стыковки по приметам осталось около ${remaining} мес.`;
      const textB =
        `Остров соседа («${a.name}») ближе: в разрывах тумана уже угадывают край чужой земли. ` +
        `До стыковки по приметам осталось около ${remaining} мес.`;
      const fa = pushPublicChronicle(a, world, textA, conflux, ['approaching']);
      const fb = pushPublicChronicle(b, world, textB, conflux, ['approaching']);
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

    const contactText =
      `Стыковка свершилась. ${contact.description} ` +
      `Города «${domains[0].name}» и «${domains[1].name}» теперь связаны этим контактом.`;

    let sharedOnce = false;
    for (const d of domains) {
      const f = pushPublicChronicle(d, world, contactText, conflux, ['docked', 'contact']);
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
      contact: contact.description,
    });
    log.info('conflux.docked', { id: conflux.id, contact: contact.description?.slice(0, 160) });
  }

  return { dockedDomainIds, dockedConfluxes, chronicleAddsByDomain, notes };
}

/**
 * After pair resolve: count docked months and end when duration elapses.
 */
export async function advanceDockedConfluxes({ storage, world }, dockedConfluxes) {
  const log = getLogger().child({ scope: 'conflux.tick' });
  const notes = [];

  for (const stub of dockedConfluxes || []) {
    const conflux = (await storage.getConflux(stub.id)) || stub;
    if (conflux.status !== 'docked') continue;

    conflux.monthsDocked = Number(conflux.monthsDocked || 0) + 1;
    if (conflux.monthsDocked >= Number(conflux.durationMonths || 3)) {
      conflux.status = 'ended';
      conflux.endedTick = world.tickIndex;
      const endText =
        'Стыковка островов ослабла: контакт расходится, чужой остров снова уходит в даль неба.';
      for (const id of conflux.domainIds || []) {
        const d = await storage.getDomain(id);
        if (!d) continue;
        const f = pushPublicChronicle(d, world, endText, conflux, ['ended']);
        mirrorToShared(conflux, f);
        await storage.saveDomain(d);
      }
      notes.push({ confluxId: conflux.id, phase: 'ended', monthsDocked: conflux.monthsDocked });
      log.info('conflux.ended', { id: conflux.id, monthsDocked: conflux.monthsDocked });
    }
    await storage.saveConflux(conflux);
  }

  return { notes };
}

/** Active docked conflux containing this domain, or null. */
export async function findDockedConfluxForDomain(storage, domainId) {
  const list = await storage.listConfluxes({ status: ['docked'] });
  return list.find((c) => (c.domainIds || []).includes(domainId)) || null;
}

async function generateContact({ runtime, conflux, domains, world, log }) {
  const draft = { contact: null };
  const tools = [
    {
      name: 'submit_contact',
      description: 'Опиши характер стыковки двух летающих островов',
      parameters: {
        type: 'object',
        required: ['description', 'kind'],
        properties: {
          kind: {
            type: 'string',
            enum: ['bridge', 'gap_jump', 'chasm', 'landmass', 'other'],
            description:
              'bridge=узкий мостик; gap_jump=щель с прыжком; chasm=провал нужен мост; landmass=сплошной контакт',
          },
          description: {
            type: 'string',
            description: '2–4 предложения по-русски: как выглядит контакт, что можно/нельзя',
          },
        },
      },
      handler: async ({ kind, description }) => {
        const text = String(description || '').trim();
        if (text.length < 20) return { ok: false, error: 'description too short' };
        draft.contact = {
          kind: kind || 'other',
          description: text,
          atTick: world.tickIndex,
        };
        return { ok: true };
      },
    },
  ];

  try {
    await runtime.run({
      agentId: 'genesis',
      tools,
      maxTurns: 4,
      toolChoice: { type: 'function', function: { name: 'submit_contact' } },
      log,
      userMessages: [
        {
          role: 'user',
          content: [
            `Два летающих острова стыкуются: «${domains[0].name}» и «${domains[1].name}».`,
            'Дата:',
            world.gameDate?.label,
            '',
            'Вызови submit_contact. Характер контакта — ВАЖНОЕ свойство: узкий каменный мостик,',
            'щель с прыжком, провал (нужен мост), или сплошной земляной контакт.',
            'Конкретно, без мета; только русский. Не выдумывай третьи острова.',
          ].join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('conflux.contact_llm_failed', { error: err.message });
  }

  if (draft.contact) return draft.contact;

  return {
    kind: 'bridge',
    description:
      `Между краями островов «${domains[0].name}» и «${domains[1].name}» легла узкая каменная перемычка: ` +
      'по ней можно пройти цепочкой, но обозы и тяжёлые грузы не пройдут, пока не укрепят стык.',
    atTick: world.tickIndex,
    fallback: true,
  };
}
