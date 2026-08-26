/**
 * Каталог важных сущностей города. Собирает отдельный агент после генезиса.
 * Полный список модели-рассказчику не отдаём: система кладёт в завязку тайны 1 якорь, редко 2.
 */

import { newId } from './ids.js';
import { plotConfig } from './plotlines.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

export const ENTITY_KINDS = [
  'place',
  'institution',
  'resource',
  'craft',
  'infrastructure',
  'custom',
  'tension',
  'cult',
  'artifact',
  'substance',
  'secret_place',
];

export const ENTITY_KIND_LABELS = {
  place: 'место',
  institution: 'институт',
  resource: 'ресурс',
  craft: 'ремесло',
  infrastructure: 'инфраструктура',
  custom: 'обычай',
  tension: 'напряжение',
  cult: 'культ',
  artifact: 'артефакт',
  substance: 'вещество',
  secret_place: 'тайное место',
};

const STRANGE_KINDS = new Set(['cult', 'artifact', 'substance', 'secret_place']);

const KIND_SET = new Set(ENTITY_KINDS);
const inflight = new WeakMap();

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max).trim() : t;
}

function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function entitiesCfg(plotCfgOrEntities = {}) {
  return plotCfgOrEntities?.mysteryEntities || plotCfgOrEntities || {};
}

export function normalizeCityEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim();
  if (!KIND_SET.has(kind)) return null;
  const name = clip(raw.name, 80);
  const about = clip(raw.about, 280);
  if (!name || !about) return null;
  const id = String(raw.id || '').trim() || newId('ent');
  return { id, kind, name, about };
}

export function normalizeCityEntities(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const one = normalizeCityEntity(item);
    if (!one) continue;
    const key = one.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(one);
  }
  return out;
}

function kindSpreadOk(list) {
  if (!list.length) return false;
  if (list.length < 6) return true;
  const counts = new Map();
  for (const item of list) {
    counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  }
  const top = Math.max(...counts.values());
  const unique = counts.size;
  const needKinds = list.length >= 24 ? 5 : 3;
  if (top > Math.ceil(list.length * 0.4) || unique < needKinds) return false;
  if (list.length >= 16) {
    const strange = list.filter((item) => STRANGE_KINDS.has(item.kind)).length;
    if (strange < 4) return false;
  }
  return true;
}

/** Обрезает сверху, но сначала снимает лишнее у самых частых видов — чтобы не потерять редкие. */
export function capCityEntities(list, maxCatalog) {
  const max = Math.max(1, Math.round(Number(maxCatalog) || 20));
  const out = normalizeCityEntities(list);
  while (out.length > max) {
    const counts = new Map();
    for (const item of out) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
    let dropKind = null;
    let dropCount = 0;
    for (const [kind, n] of counts) {
      if (n > dropCount) {
        dropKind = kind;
        dropCount = n;
      }
    }
    const idx =
      dropCount > 1 ? out.findLastIndex((item) => item.kind === dropKind) : out.length - 1;
    out.splice(idx, 1);
  }
  return out;
}

export function hasCityEntityCatalog(domain) {
  if (!domain || typeof domain !== 'object') return false;
  if (normalizeCityEntities(domain.cityEntities).length) return true;
  return domain.cityEntitiesReady === true;
}

/**
 * 1 якорь из каталога, совсем изредка 2. С маленькой вероятностью один слот — «изобрети новое».
 * Пустой каталог → пустой список (завязка идёт только от описания города).
 */
export function pickMysteryAnchors(catalog, plotCfgOrEntities = {}, rng = Math.random, opts = {}) {
  const list = normalizeCityEntities(catalog);
  if (!list.length) return [];
  const ent = entitiesCfg(plotCfgOrEntities);
  const pickMin = Math.max(1, Math.min(2, Math.round(Number(ent.pickMin ?? 1))));
  const pickMax = Math.max(pickMin, Math.min(2, Math.round(Number(ent.pickMax ?? 2))));
  const twoChance = Math.max(0, Math.min(1, Number(ent.twoChance ?? 0.12)));
  let n = pickMin;
  if (pickMax > pickMin && rng() < twoChance) n = pickMax;
  const inventChance = Math.max(0, Math.min(1, Number(ent.inventChance ?? 0.15)));
  const shuffled = shuffle(list, rng);
  const invent = rng() < inventChance;
  const out = [];
  if (invent) {
    const preferred = String(opts.inventKind || '').trim();
    const kind = KIND_SET.has(preferred)
      ? preferred
      : ENTITY_KINDS[Math.floor(rng() * ENTITY_KINDS.length)];
    out.push({ invent: true, kind });
  }
  for (const item of shuffled) {
    if (out.length >= n) break;
    out.push({
      invent: false,
      id: item.id,
      kind: item.kind,
      name: item.name,
      about: item.about,
    });
  }
  return shuffle(out, rng);
}

/** Текст только по выданным якорям — полный каталог сюда не попадает. */
export function formatMysteryAnchorsForPrompt(anchors) {
  const list = Array.isArray(anchors) ? anchors.filter(Boolean) : [];
  if (!list.length) return '';
  const lines = [
    'ЯКОРЯ ЭТОЙ ТАЙНЫ — повесь причинную модель именно на них.',
    'Полное описание города нужно, чтобы якоря не противоречили миру, а не чтобы снова взять самый громкий хронический риск острова.',
  ];
  for (const a of list) {
    const kindName = ENTITY_KIND_LABELS[a.kind] || a.kind || 'сущность';
    if (a.invent) {
      lines.push(
        `- изобрести: новая сущность вида «${kindName}». Правдоподобна для этого города, ещё не названа якорями выше. Не повторяй главное бедствие острова, если остальные якоря про другое.`,
      );
    } else {
      lines.push(`- ${kindName} «${a.name}»: ${a.about}`);
    }
  }
  return lines.join('\n');
}

async function askCityEntities({ runtime, domain, config, log, minCatalog, maxCatalog, retry = false }) {
  const draft = { data: null };
  const kindsHint = ENTITY_KINDS.map((k) => `${k} (${ENTITY_KIND_LABELS[k]})`).join(', ');
  const tools = [
    {
      name: 'submit_city_entities',
      description: `Список важных сущностей города: от ${minCatalog} до ${maxCatalog} штук. Не тайны и не сюжет.`,
      parameters: {
        type: 'object',
        required: ['entities'],
        properties: {
          entities: {
            type: 'array',
            description: `Ровно ${minCatalog}–${maxCatalog} сущностей разных видов.`,
            items: {
              type: 'object',
              required: ['kind', 'name', 'about'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ENTITY_KINDS,
                  description: `Вид: ${kindsHint}`,
                },
                name: { type: 'string', description: 'Имя сущности, 1–6 слов. Не человек.' },
                about: {
                  type: 'string',
                  description: '1–2 фразы: что это в этом городе. Без завязки тайны и без «странного».',
                },
              },
            },
          },
        },
      },
      handler: async (args) => {
        const list = normalizeCityEntities(args?.entities);
        if (list.length < minCatalog) {
          return toolFail(
            'too_few',
            `Нужно не меньше ${minCatalog} разных сущностей (пришло ${list.length}). Разложи по видам, не копи имена.`,
          );
        }
        if (!kindSpreadOk(list)) {
          return toolFail(
            'too_homogeneous',
            'Слишком много пунктов одного вида или мало культов/артефактов/веществ/тайных мест. Разложи виды; вынеси зародыши из лора.',
          );
        }
        draft.data = capCityEntities(list, maxCatalog);
        return { ok: true };
      },
    },
  ];

  const description = String(domain.description || '').trim() || '(описание пусто)';
  await runtime.run({
    agentId: 'cityEntities',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_city_entities' } },
    log,
    scene: 'city_entities',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}».\n${description}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Собери каталог важных сущностей города «${domain.name}».`,
          `Нужно ${minCatalog}–${maxCatalog} пунктов. Виды: ${kindsHint}.`,
          'Бери то, на чём может висеть городская жизнь, и то, из чего растёт тайна: места, институты, ресурсы, ремёсла, инфраструктура, обычаи, напряжения, культы, артефакты, вещества, потайные места.',
          'Именованных людей не заноси — ими занимается другая карта.',
          'Не пиши готовые тайны и завязки. Зародыши из лора (печати, реликвия, ночной обряд, закрытая книга, необычный состав) — отдельными пунктами своих видов.',
          'Не меньше четырёх пунктов видов культ / артефакт / вещество / тайное место. Торф и зерно сами по себе туда не клади.',
          'Не скучкуй всё вокруг одной материи или одного хронического риска: разложи виды и темы.',
          retry
            ? 'Прошлая попытка была слишком короткой или однородной. Расширь набор и виды.'
            : null,
          'Вызови submit_city_entities.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  return normalizeCityEntities(draft.data);
}

/**
 * Если каталога нет или он короче порога — спрашивает агента и пишет в domain.
 * Сохранение на диск делает вызывающий (генезис / тик). Сэмпл не пишет сейв.
 */
export async function ensureCityEntities({ domain, config, runtime, log: parentLog } = {}) {
  if (!domain) return [];
  const cfg = plotConfig(config);
  const minCatalog = Math.max(4, Math.round(Number(cfg.mysteryEntities?.minCatalog ?? 32)));
  const maxCatalog = Math.max(minCatalog, Math.round(Number(cfg.mysteryEntities?.maxCatalog ?? 48)));
  const existing = normalizeCityEntities(domain.cityEntities);
  if (existing.length >= minCatalog) {
    domain.cityEntities = existing;
    domain.cityEntitiesReady = true;
    return existing;
  }
  if (domain.cityEntitiesReady === true && !existing.length) {
    domain.cityEntities = existing;
    return existing;
  }
  if (inflight.has(domain)) return inflight.get(domain);

  const job = (async () => {
    const log = (parentLog || getLogger()).child({ scope: 'cityEntities', domainId: domain.id });
    let list = [];
    if (!runtime) {
      domain.cityEntities = existing;
      domain.cityEntitiesReady = true;
      log.warn('cityEntities.skipped', { reason: 'no_runtime' });
      return existing;
    }
    for (let attempt = 0; attempt < 2 && list.length < minCatalog; attempt += 1) {
      try {
        list = await askCityEntities({
          runtime,
          domain,
          config,
          log,
          minCatalog,
          maxCatalog,
          retry: attempt > 0,
        });
      } catch (err) {
        log.warn('cityEntities.attempt_failed', { attempt, error: err.message });
      }
    }
    if (list.length < minCatalog && existing.length) {
      list = existing;
    }
    domain.cityEntities = capCityEntities(list, maxCatalog);
    domain.cityEntitiesReady = true;
    if (!domain.cityEntities.length) {
      log.warn('cityEntities.empty', { reason: 'agent_gave_nothing' });
    } else {
      const kinds = {};
      for (const item of domain.cityEntities) kinds[item.kind] = (kinds[item.kind] || 0) + 1;
      log.info('cityEntities.built', { count: domain.cityEntities.length, kinds });
    }
    return domain.cityEntities;
  })();

  inflight.set(domain, job);
  try {
    return await job;
  } finally {
    inflight.delete(domain);
  }
}
