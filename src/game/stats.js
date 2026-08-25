/** Box–Muller normal sample */
function gaussian(rng = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Independent normal rolls biased to center (no fixed sum).
 */
export function rollDomainStats(config, rng = Math.random) {
  const defs = config.stats;
  const mean = config.genesis.statMean ?? 50;
  const std = config.genesis.statStd ?? 12;
  const min = config.genesis.statMin ?? 18;
  const max = config.genesis.statMax ?? 82;
  const stats = {};
  for (const def of defs) {
    stats[def.id] = clamp(mean + gaussian(rng) * std, min, max);
  }
  return stats;
}

export function rollPopulation(config, rng = Math.random) {
  const { min, max } = config.genesis.population;
  const mean = (min + max) / 2;
  const std = (max - min) / 6;
  const value = clamp(mean + gaussian(rng) * std, min, max);
  return Math.round(value / 100) * 100;
}

export function pickTags(config, rng = Math.random, forcedChoices = {}) {
  return (config.genesis.tagGroups || []).map((group) => {
    const forced = forcedChoices[group.id];
    if (forced != null && String(forced).trim()) {
      const raw = String(forced).trim();
      const fromCatalog = group.tags.find((t) => t.id === raw || t.name === raw);
      if (fromCatalog) {
        return {
          groupId: group.id,
          groupName: group.name,
          tagId: fromCatalog.id,
          tagName: fromCatalog.name,
          source: 'catalog',
        };
      }
      // Свободные слова игрока — не обязаны совпадать с каталогом
      const slug = raw
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 40);
      return {
        groupId: group.id,
        groupName: group.name,
        tagId: `free:${slug || 'custom'}`,
        tagName: raw,
        source: 'freeform',
      };
    }
    const tag = group.tags[Math.floor(rng() * group.tags.length)];
    return {
      groupId: group.id,
      groupName: group.name,
      tagId: tag.id,
      tagName: tag.name,
      source: 'random',
    };
  });
}

function nearestScaleKey(value, scale) {
  const keys = Object.keys(scale)
    .map(Number)
    .sort((a, b) => a - b);
  let best = keys[0];
  for (const k of keys) {
    if (Math.abs(k - value) < Math.abs(best - value)) best = k;
  }
  return best;
}

/** Ближайшая нижняя (или равная) ступень шкалы. */
function floorScaleKey(value, scale) {
  const keys = Object.keys(scale)
    .map(Number)
    .sort((a, b) => a - b);
  if (!keys.length) return 0;
  let key = keys[0];
  for (const k of keys) {
    if (k <= value) key = k;
  }
  return key;
}

const DEFAULT_EPITHETS = {
  0: 'ужасающе',
  12: 'плачевно',
  25: 'скудно',
  37: 'скромно',
  50: 'обычно',
  62: 'заметно',
  75: 'сильно',
  87: 'блистательно',
  100: 'божественно',
};

export function getStatEpithetScale(config) {
  const raw = config?.statEpithets;
  if (raw && typeof raw === 'object' && Object.keys(raw).length) return raw;
  return DEFAULT_EPITHETS;
}

/** Эпитет 0–100: ужасающе … божественно. */
export function statEpithet(value, config) {
  const v = Number.isFinite(Number(value)) ? Number(value) : 50;
  const scale = getStatEpithetScale(config);
  const key = floorScaleKey(v, scale);
  return scale[key] || scale[String(key)] || 'обычно';
}

export function formatStatValue(value, config) {
  const v = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 50;
  return `${v} (${statEpithet(v, config)})`;
}

export function statDeltaLimits(config) {
  const typical = Math.abs(config?.tick?.typicalStatDelta ?? 5);
  return { typicalMax: typical };
}

/**
 * Применить дельты статов. Без потолка на величину дельты — итог клипится в 0–100.
 * @returns {{ [key: string]: { from: number, to: number, delta: number } }}
 */
export function applyStatDeltas(stats, deltas) {
  const changes = {};
  if (!stats || typeof stats !== 'object') return changes;
  for (const [key, raw] of Object.entries(deltas || {})) {
    if (!(key in stats)) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    const delta = Math.round(n);
    if (delta === 0) continue;
    const from = Number(stats[key]) || 0;
    const to = Math.max(0, Math.min(100, Math.round(from + delta)));
    const applied = to - from;
    if (applied === 0) continue;
    stats[key] = to;
    changes[key] = { from, to, delta: applied };
  }
  return changes;
}

/**
 * Статы для агентов со стейтом: число + эпитет + about + ориентир шкалы.
 */
export function formatStatsForPrompt(stats, config) {
  return (config.stats || [])
    .map((def) => {
      const value = Number(stats?.[def.id]);
      const v = Number.isFinite(value) ? value : 50;
      const scale = def.scale || {};
      const key = nearestScaleKey(v, scale);
      const hint = scale[key] || scale[String(key)] || '';
      const about = def.about ? ` ${def.about}` : '';
      const covers = def.covers ? ` Сферы: ${def.covers}` : '';
      const when = def.changeWhen ? ` Менять, когда: ${def.changeWhen}` : '';
      const orient = hint ? ` Ориентир: ${hint}` : '';
      return `${def.name} (${def.id}): ${formatStatValue(v, config)}.${about}${covers}${when}${orient}`;
    })
    .join('\n');
}

/**
 * Качественная картина для правителя: без чисел, эпитет + about + ориентир.
 */
/** Короткая форма для доски нитей: «Вера (скудно), Знание (заметно)». */
export function statEpithetsShort(stats, config, ids = []) {
  const defs = config.stats || [];
  return (ids || [])
    .map((id) => defs.find((d) => d.id === id))
    .filter(Boolean)
    .map((def) => {
      const value = Number(stats?.[def.id]);
      const v = Number.isFinite(value) ? value : 50;
      return `${def.name} (${statEpithet(v, config)})`;
    })
    .join(', ');
}

/**
 * Качественная сводка по статам. `only` — сузить до нужных id
 * (например, до тех, что сейчас в игре у сюжетной нити).
 */
export function qualitativeStatsBrief(stats, config, { only = null } = {}) {
  const wanted = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
  return (config.stats || [])
    .filter((def) => !wanted || wanted.has(def.id))
    .map((def) => {
      const value = Number(stats?.[def.id]);
      const v = Number.isFinite(value) ? value : 50;
      const epithet = statEpithet(v, config);
      const scale = def.scale || {};
      const key = floorScaleKey(v, scale);
      const hint = scale[key] || scale[String(key)] || 'неясно';
      const about = def.about ? ` ${def.about}` : '';
      const covers = def.covers ? ` Сферы: ${def.covers}` : '';
      const when = def.changeWhen ? ` Менять, когда: ${def.changeWhen}` : '';
      return `- ${def.name} (${epithet}).${about}${covers}${when} Ориентир: ${hint}`;
    })
    .join('\n');
}

export function formatTagsForPrompt(tags) {
  return tags
    .map((t) => {
      const src =
        t.source === 'freeform' ? ' (слова игрока)' : t.source === 'random' ? ' (random)' : '';
      return `${t.groupName}: ${t.tagName}${src}`;
    })
    .join('\n');
}

export function qualitativePopulation(n) {
  if (n < 10000) return 'небольшой город, порядка нескольких тысяч жителей';
  if (n < 30000) return 'средний город, десятки тысяч жителей';
  if (n < 70000) return 'крупный город, многие десятки тысяч';
  return 'очень крупный город, под сотню тысяч или около того';
}

export function isForbiddenDomainName(name) {
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  const banned = ['cloudshire', 'облачныйшир', 'cloudshir', 'клаудшир'];
  return banned.some((b) => n.includes(b));
}

/** Лояльность / ужас правителя к покровителю. */
export function formatRulerAttitudes(character, config) {
  normalizeRulerAttitudes(character);
  const loy = formatStatValue(character.loyalty, config);
  const ter = formatStatValue(character.terror, config);
  return [
    `Лояльность: ${loy} — преданность и готовность служить добровольно.`,
    `Ужас: ${ter} — священный страх / благоговение перед покровителем.`,
    'Высокое значение ЛЮБОГО заметно повышает готовность исполнять (особенно при должном тоне покровителя).',
    'Меняй adjust_loyalty / adjust_terror по ходу разговора (милость, угроза, унижение, чудо…).',
  ].join('\n');
}

export function normalizeRulerAttitudes(character) {
  if (!character || typeof character !== 'object') return character;
  if (!Number.isFinite(Number(character.loyalty))) character.loyalty = 50;
  else character.loyalty = clamp(character.loyalty, 0, 100);
  if (!Number.isFinite(Number(character.terror))) character.terror = 50;
  else character.terror = clamp(character.terror, 0, 100);
  return character;
}

export function adjustAttitude(character, field, delta, { maxStep = 25 } = {}) {
  normalizeRulerAttitudes(character);
  if (field !== 'loyalty' && field !== 'terror') {
    return {
      ok: false,
      error: 'invalid_field',
      agentMessage:
        'field должен быть loyalty или terror. Вызови adjust_loyalty / adjust_terror с delta ≠ 0.',
    };
  }
  const d = Math.max(-maxStep, Math.min(maxStep, Math.round(Number(delta) || 0)));
  if (d === 0) {
    return {
      ok: false,
      error: 'delta_zero',
      agentMessage:
        'delta=0 — изменения нет. Передай заметный шаг (±5…15, макс ±25) или не вызывай tool.',
    };
  }
  const from = character[field];
  character[field] = clamp(from + d, 0, 100);
  return { ok: true, field, from, to: character[field], delta: character[field] - from };
}
