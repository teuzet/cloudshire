/**
 * Режиссёрский посев саспенса: gravity, depth, tone/source/situation/dynamic.
 * Gravity — вход движка, не оценка модели. Depth смещён gravity и жанром, не склеен с ними.
 */

import { liveStoryImportance, pickSeedTags } from './plotlines.js';
import { castRecords } from './models.js';

const DEPTH_UP_TONES = new Set(['exploration', 'uncanny', 'mystical', 'adventure', 'wonder', 'horror']);
const DEPTH_DOWN_TONES = new Set(['social', 'economic', 'political']);
const DEPTH_UP_SOURCES = new Set(['unknown', 'archaeological', 'creature', 'environment']);
const DEPTH_DOWN_SOURCES = new Set(['social', 'economic', 'political']);

function clampInt(n, lo, hi, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function suspenseCfg(cfg = {}) {
  const s = cfg?.suspense || {};
  return {
    gravityFloor: clampInt(s.gravityFloor, 5, 40, 20),
    openingGravityMin: clampInt(s.openingGravityMin, 5, 40, 20),
    openingGravityMax: clampInt(s.openingGravityMax, 20, 60, 40),
    depth4Chance: Math.max(0, Math.min(0.2, Number(s.depth4Chance ?? 0.03))),
    depth4MinGravity: clampInt(s.depth4MinGravity, 50, 100, 75),
  };
}

function pickWeighted(tags, rng) {
  const list = (tags || []).filter(Boolean);
  if (!list.length) return null;
  const weights = list.map((t) => Math.max(0, Number(t.weight) || 1));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return list[Math.floor(rng() * list.length)] || null;
  let r = rng() * total;
  for (let i = 0; i < list.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

export function sampleSuspenseGravity(domain, { opening = false, fromClosed = null, rng = Math.random, cfg = null } = {}) {
  const s = suspenseCfg(cfg);
  const floor = s.gravityFloor;
  if (fromClosed && Number.isFinite(Number(fromClosed.gravity))) {
    const lo = clampInt(fromClosed.gravity, floor, 100, floor);
    return lo + Math.floor(rng() * (100 - lo + 1));
  }
  if (opening) {
    const lo = s.openingGravityMin;
    const hi = Math.max(lo, s.openingGravityMax);
    return lo + Math.floor(rng() * (hi - lo + 1));
  }
  const sum = liveStoryImportance(domain);
  const high = Math.max(floor, Math.min(100, 150 - sum));
  return floor + Math.floor(rng() * (high - floor + 1));
}

export function sampleSuspenseDepth(
  gravity,
  { toneId = '', sourceId = '', opening = false, rng = Math.random, cfg = null } = {},
) {
  const s = suspenseCfg(cfg);
  const g = clampInt(gravity, 0, 100, 40);
  let base = 1;
  if (g >= 65) base = 3;
  else if (g >= 40) base = 2;

  let depth = base;
  const jump = rng();
  if (jump < 0.18) depth -= 1;
  else if (jump > 0.82) depth += 1;

  const tone = String(toneId || '').toLowerCase();
  const source = String(sourceId || '').toLowerCase();
  if ((DEPTH_UP_TONES.has(tone) || DEPTH_UP_SOURCES.has(source)) && rng() < 0.2) depth += 1;
  if ((DEPTH_DOWN_TONES.has(tone) || DEPTH_DOWN_SOURCES.has(source)) && rng() < 0.2) depth -= 1;

  depth = Math.max(1, Math.min(3, depth));
  if (opening) depth = Math.min(depth, 2);

  if (
    !opening &&
    depth === 3 &&
    g >= s.depth4MinGravity &&
    rng() < s.depth4Chance
  ) {
    depth = 4;
  }
  return depth;
}

function gravityBand(g) {
  if (g <= 25) return 'minor — небольшой постоянный след';
  if (g <= 50) return 'significant — локальное устойчивое изменение';
  if (g <= 75) return 'major — значимое изменение устройства города возможно';
  return 'fate_shaping — финал почти обязан оставить крупный след в сеттинге';
}

export function rollSuspenseSeed({
  domain,
  cfg,
  opening = false,
  fromClosed = null,
  rng = Math.random,
} = {}) {
  const tags = pickSeedTags(cfg, { storyType: 'suspense', opening, rng });
  const gravity = sampleSuspenseGravity(domain, { opening, fromClosed, rng, cfg });
  const toneGroup = (cfg?.tagGroups || []).find((g) => g.id === 'tone');
  const primary = tags.find((t) => t.groupId === 'tone') || null;
  let extra = null;
  if (toneGroup && rng() < 0.45) {
    const others = (toneGroup.tags || []).filter((t) => t.id !== primary?.tagId);
    const pick = pickWeighted(others, rng);
    if (pick) {
      extra = {
        groupId: 'tone',
        groupName: toneGroup.name || 'Тон',
        tagId: pick.id,
        tagName: pick.name,
        secondary: true,
      };
    }
  }
  const tagsOut = extra ? [...tags, extra] : tags;
  const source = tagsOut.find((t) => t.groupId === 'source') || null;
  const situation = tagsOut.find((t) => t.groupId === 'situation') || null;
  const dynamic = tagsOut.find((t) => t.groupId === 'dynamic') || null;
  const depth = sampleSuspenseDepth(gravity, {
    toneId: primary?.tagId,
    sourceId: source?.tagId,
    opening,
    rng,
    cfg,
  });
  return {
    gravity,
    depth,
    tags: tagsOut,
    tonePrimary: primary?.tagId || null,
    toneSecondary: extra?.tagId || null,
    source: source?.tagId || null,
    situation: situation?.tagId || null,
    dynamic: dynamic?.tagId || null,
  };
}

export function formatSuspenseSeedForPrompt(seed, { opening = false, fromClosed = null } = {}) {
  if (!seed) return '';
  const lines = [
    '==================================================',
    'РЕЖИССУРА СЕВА (движок уже бросил, не подменяй)',
    '==================================================',
    `gravity: ${seed.gravity} (${gravityBand(seed.gravity)})`,
    'Gravity — потенциальный постоянный след в городе, не «насколько интересно» и не географический охват.',
    `depth: ${seed.depth}` +
      (seed.depth <= 1
        ? ' — короткая живая история; одно сильное вмешательство может закрыть.'
        : seed.depth === 2
          ? ' — полноценная дуга, минимум один содержательный поворот.'
          : ' — глубокая история: несколько разных состояний. Не закрывай одним успехом.'),
    seed.tonePrimary
      ? `tone: ${seed.tonePrimary}${seed.toneSecondary ? ` + ${seed.toneSecondary}` : ''}`
      : null,
    seed.source ? `source (причинная сила, не география): ${seed.source}` : null,
    seed.situation ? `situation: ${seed.situation}` : null,
    seed.dynamic ? `dynamic (как ситуация живёт без игрока): ${seed.dynamic}` : null,
    '',
    'Сначала событие, потом якоря города. Не начинай с конфликта ремесленников/домов/торговцев только потому, что они есть в описании.',
    'Социальная реакция — слой поверх premise, не замена premise.',
    'Обычные свары допустимы, если выпали SOCIAL/POLITICAL/ECONOMIC. Иначе не схлопывай природное, аномальное, религиозное или внешнее в спор двух групп.',
    opening
      ? 'СТАРТ города: не катастрофа и не конец острова. Игрок сразу видит, куда вмешаться.'
      : null,
    fromClosed
      ? `Сиквел: gravity не ниже ${fromClosed.gravity}. Расти из остатка закрытой истории, не повторяй её.`
      : null,
  ];
  return lines.filter((x) => x != null).join('\n');
}

export function characterPlotOccupancy(domain) {
  const openIds = new Set(
    (domain?.plotlines || [])
      .filter((p) => p && p.kind !== 'order')
      .map((p) => String(p.id)),
  );
  const ruler = String(domain?.characters?.[0]?.name || '')
    .trim()
    .toLowerCase();
  const free = [];
  const busy = [];
  for (const c of castRecords(domain?.lore)) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    if (ruler && name.toLowerCase() === ruler) continue;
    if (c.status === 'dead') continue;
    const bound = (c.relatedPlotlineIds || []).map(String).filter((id) => openIds.has(id));
    const row = {
      name,
      role: c.role || '',
      about: c.about || '',
      status: c.status || 'alive',
      plotIds: bound,
    };
    if (bound.length) busy.push(row);
    else free.push(row);
  }
  return { free, busy, ruler: domain?.characters?.[0]?.name || '' };
}

export function formatOccupancyForPrompt(occupancy, { limit = 8 } = {}) {
  if (!occupancy) return '';
  const free = (occupancy.free || []).slice(0, limit);
  const busy = (occupancy.busy || []).slice(0, limit);
  const lines = [
    '==================================================',
    'ЛЮДИ',
    '==================================================',
    'Именованных заводи только в крайнем случае: новая устойчивая функция, которую никто существующий не может выполнить.',
    'Иначе — безымянная функция («разведчики», «лекарь храма»).',
    occupancy.ruler ? `Правитель — ${occupancy.ruler}. Двигателем завязки и в newCharacters не ставь.` : null,
    '',
    'Свободные (реюз только если причинно естественно):',
    free.length
      ? free.map((c) => `- ${c.name}${c.role ? `, ${c.role}` : ''}${c.about ? `: ${c.about}` : ''}`).join('\n')
      : '(свободных именованных нет)',
    '',
    'Заняты живыми историями (не используй):',
    busy.length
      ? busy.map((c) => `- ${c.name}${c.role ? `, ${c.role}` : ''}`).join('\n')
      : '(никто не занят)',
  ];
  return lines.filter((x) => x != null).join('\n');
}
