/**
 * Единый модуль бросков мира: ход дел и окраска битов нитей.
 * Весь баланс случайности живёт здесь и в config.tick.plot.roll —
 * чтобы крутить его числами, а не формулировками в промптах.
 */

function clampStat(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, v));
}

/**
 * Сжатая шкала: стат 0 не означает верный провал, стат 100 — не гарантия.
 * По умолчанию удача идёт от 25% до 75%.
 */
export function compressedChance(statValue, { minChance = 0.25, maxChance = 0.75 } = {}) {
  const v = clampStat(statValue) / 100;
  return minChance + (maxChance - minChance) * v;
}

/**
 * Ход дела за месяц: 0 — застой, 1 — обычный, 2 — рывок.
 * Порог от среднего связанных статов, полосы широкие: необычное должно быть редким.
 */
export function rollProcessAdvance(avgStat, rng = Math.random) {
  const avg = Math.round(clampStat(avgStat));
  const roll = Math.floor(rng() * 101);
  let advance = 1;
  let kind = 'normal';
  if (roll > avg + 40) {
    advance = 0;
    kind = 'stall';
  } else if (roll < avg - 40) {
    advance = 2;
    kind = 'surge';
  }
  return {
    roll,
    avg,
    advance,
    kind,
    unusual: kind !== 'normal',
    thresholds: { stallAbove: avg + 40, surgeBelow: avg - 40 },
  };
}

/**
 * По какому стату кидать окраску бита: перевес в пользу главного,
 * иначе история про воду каждый второй месяц решалась бы верой.
 */
export function pickRollStat(relatedStats = [], rng = Math.random, { primaryWeight = 2 } = {}) {
  const ids = (relatedStats || []).map(String).filter(Boolean);
  if (!ids.length) return null;
  const weights = ids.map((_, i) => (i === 0 ? Math.max(1, primaryWeight) : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < ids.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return ids[i];
  }
  return ids[ids.length - 1];
}

/**
 * Окраска самопроизвольного бита: удача города, двойственный исход или беда.
 * Слабая сторона города сама производит неприятности в своей области.
 */
export function rollTint(statValue, rng = Math.random, cfg = {}) {
  const chance = compressedChance(statValue, cfg);
  const band = Math.max(0, Math.min(0.45, Number(cfg.dualBand ?? 0.2)));
  const roll = rng();
  let tint;
  if (roll < chance - band / 2) tint = 'good';
  else if (roll < chance + band / 2) tint = 'dual';
  else tint = 'bad';
  return { roll: Math.round(roll * 100), chance: Math.round(chance * 100), tint };
}

/** Окраска бита, вызванного делом: темп дела уже брошен, второй раз не кидаем. */
export function tintFromProcessOutcome(outcome) {
  if (!outcome) return 'dual';
  if (outcome.finished) return outcome.failed ? 'bad' : 'good';
  if (outcome.kind === 'stall') return 'bad';
  if (outcome.kind === 'surge') return 'good';
  return 'dual';
}

export const TINT_LABELS = {
  good: 'в пользу города',
  dual: 'двойственный: вышло, но с ценой',
  bad: 'против города',
};

/** Вероятность добровольного бита: интерес, важность и подпирающий возраст. */
export function beatChance(plot, cfg) {
  const b = cfg?.beats || {};
  const temp = clampStat(plot?.temperature) / 100;
  const imp = clampStat(plot?.importance) / 100;
  const maxAge = Math.max(1, Number(plot?.maxAgeMonths) || 6);
  const agePressure = Math.min(1, (Number(plot?.ageMonths) || 0) / maxAge);
  const raw =
    (b.baseChance ?? 0.15) +
    temp * (b.temperatureWeight ?? 0.5) +
    imp * (b.importanceWeight ?? 0.2) +
    agePressure * (b.agePressure ?? 0.15);
  return Math.max(b.minChance ?? 0.05, Math.min(b.maxChance ?? 0.8, raw));
}
