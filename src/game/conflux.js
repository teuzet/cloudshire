import { newId } from './ids.js';
import { createLoreFact } from './models.js';
import { getLogger } from '../log.js';

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

    // Внеочередное идентичное событие стыка в хронику обоих (один и тот же текст)
    const contactText = contact.description;

    let sharedOnce = false;
    for (const d of domains) {
      const f = createLoreFact({
        id: newId('lore'),
        text: contactText,
        tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'shared', 'docked', 'contact'],
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
      contact: contact.description,
    });
    log.info('conflux.docked', { id: conflux.id, contact: contact.description?.slice(0, 160) });
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
        if (body.length < 40) return { ok: false, error: 'too short' };
        if (!body.includes(nameA) || !body.includes(nameB)) {
          return {
            ok: false,
            error: `Нужны оба названия: «${nameA}» и «${nameB}»`,
          };
        }
        if (!looksLikeIslandsParted(body)) {
          return {
            ok: false,
            error:
              'Нужен разлёт ОСТРОВОВ в небе (не только обвал моста). Перепиши: острова разошлись, пути нет.',
          };
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

async function generateContact({ runtime, conflux, domains, world, log }) {
  const nameA = domains[0].name;
  const nameB = domains[1].name;
  const draft = { contact: null };
  const tools = [
    {
      name: 'submit_contact',
      description:
        'Внеочередное событие стыка: как устроен переход между двумя городами (пойдёт в хронику обоих дословно)',
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
            description:
              `2–4 предложения по-русски. ОБЯЗАТЕЛЬНО назови оба города «${nameA}» и «${nameB}». ` +
              'Опиши, как именно устроен переход между ними и что можно/нельзя.',
          },
        },
      },
      handler: async ({ kind, description }) => {
        const text = String(description || '').trim();
        if (text.length < 40) return { ok: false, error: 'description too short' };
        if (!text.includes(nameA) || !text.includes(nameB)) {
          return {
            ok: false,
            error: `В description должны быть названия обоих городов: «${nameA}» и «${nameB}»`,
          };
        }
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
      agentId: 'confluxResolver',
      tools,
      maxTurns: 5,
      toolChoice: { type: 'function', function: { name: 'submit_contact' } },
      log,
      userMessages: [
        {
          role: 'user',
          content: [
            `Внеочередное событие стыка. Дата: ${world.gameDate?.label || ''}.`,
            `Острова городов «${nameA}» и «${nameB}» сошлись.`,
            '',
            'Вызови submit_contact.',
            'description — канон перехода: как выглядит контакт, как ходят между городами, ограничения.',
            `В тексте ОБЯЗАТЕЛЬНО оба имени: «${nameA}» и «${nameB}».`,
            'Варианты: узкий каменный мостик / щель с прыжком / провал (нужен мост) / сплошной земляной контакт.',
            'Конкретно, по-русски. Не выдумывай третий остров. Это одна запись на оба города.',
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
      `Между краями островов «${nameA}» и «${nameB}» легла узкая каменная перемычка: ` +
      `по ней можно пройти цепочкой из одного города в другой, но обозы и тяжёлые грузы не пройдут, ` +
      'пока не укрепят стык.',
    atTick: world.tickIndex,
    fallback: true,
  };
}
