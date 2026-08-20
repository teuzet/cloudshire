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
    const forcedId = forcedChoices[group.id];
    const tag =
      (forcedId && group.tags.find((t) => t.id === forcedId)) ||
      group.tags[Math.floor(rng() * group.tags.length)];
    return {
      groupId: group.id,
      groupName: group.name,
      tagId: tag.id,
      tagName: tag.name,
    };
  });
}

export function pickMilestones(config, rng = Math.random) {
  const pool = [...(config.world.milestonePool || [])];
  const min = config.world.milestonesPerDomain?.min ?? 3;
  const max = config.world.milestonesPerDomain?.max ?? 5;
  const count = Math.min(pool.length, min + Math.floor(rng() * (max - min + 1)));

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, count).map((m) => ({
    id: m.id,
    text: m.text,
    points: m.points,
    status: 'open',
  }));
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

export function formatStatsForPrompt(stats, config) {
  return config.stats
    .map((def) => {
      const value = stats[def.id];
      const scale = def.scale || {};
      const key = nearestScaleKey(value, scale);
      const hint = scale[key] || scale[String(key)] || '';
      return `${def.name} (${def.id}): ${value}/100 — ориентир: ${hint}`;
    })
    .join('\n');
}

/**
 * Качественная картина статов для правителя: без чисел, с тоном по шкале.
 * Берём ориентир с ближайшей нижней ступени шкалы (33 → ступень 25 «скудная жизнь»).
 */
export function qualitativeStatsBrief(stats, config) {
  return (config.stats || [])
    .map((def) => {
      const value = Number(stats?.[def.id]);
      const v = Number.isFinite(value) ? value : 50;
      const scale = def.scale || {};
      const keys = Object.keys(scale)
        .map(Number)
        .sort((a, b) => a - b);
      let key = keys[0] ?? 0;
      for (const k of keys) {
        if (k <= v) key = k;
      }
      const hint = scale[key] || scale[String(key)] || 'неясно';
      let tone = 'средний';
      if (v < 30) tone = 'плохо / низко';
      else if (v < 42) tone = 'скорее слабо';
      else if (v < 58) tone = 'обычно';
      else if (v < 72) tone = 'скорее сильно';
      else tone = 'хорошо / высоко';
      return `- ${def.name}: ${tone}. Ориентир: ${hint}`;
    })
    .join('\n');
}

export function formatTagsForPrompt(tags) {
  return tags.map((t) => `${t.groupName}: ${t.tagName}`).join('\n');
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
