/**
 * Полосы: срок дела, сложность, счётчик угрозы.
 *
 * Принцип: агенты видят полосы, код видит дни. Агент никогда не называет
 * число дней — он выбирает полосу, а движок бросает конкретный срок внутри неё.
 */

// ─────────────────────────────── срок дела ───────────────────────────────

export const DURATION_BANDS = ['INSTANT', 'DAYS', 'WEEKS', 'SEASON', 'YEAR', 'YEARS'];

export const DURATION_SPEC = {
  INSTANT: { min: 1, max: 3, label: 'мгновенно' },
  DAYS: { min: 5, max: 15, label: 'дни' },
  WEEKS: { min: 20, max: 60, label: 'недели' },
  SEASON: { min: 60, max: 150, label: 'сезон' },
  YEAR: { min: 150, max: 360, label: 'год' },
  YEARS: { min: 360, max: 1080, label: 'годы' },
};

/** Мгновенное дело всё равно занимает сановника — иначе ломается экономия столпов. */
export const MIN_OFFICER_DAYS = 5;

export function normalizeDurationBand(raw, fallback = 'WEEKS') {
  const key = String(raw || '').trim().toUpperCase();
  return DURATION_BANDS.includes(key) ? key : fallback;
}

export function durationBandIndex(band) {
  return DURATION_BANDS.indexOf(normalizeDurationBand(band));
}

/** Сдвиг полосы на N ступеней с зажимом по краям. */
export function shiftDurationBand(band, steps) {
  const i = durationBandIndex(band);
  const next = Math.max(0, Math.min(DURATION_BANDS.length - 1, i + Math.round(Number(steps) || 0)));
  return DURATION_BANDS[next];
}

/** Конкретный срок внутри полосы. Жребий — код, не агент. */
export function rollDurationDays(band, rng = Math.random) {
  const spec = DURATION_SPEC[normalizeDurationBand(band)];
  const span = spec.max - spec.min;
  return spec.min + Math.round(rng() * span);
}

/** По числу дней обратно к полосе (для отчётов и миграции). */
export function durationBandOfDays(days) {
  const d = Math.max(0, Number(days) || 0);
  for (const band of DURATION_BANDS) {
    if (d <= DURATION_SPEC[band].max) return band;
  }
  return 'YEARS';
}

// ─────────────────────────────── сложность ───────────────────────────────

export const DIFFICULTY_BANDS = ['TRIVIAL', 'PLAIN', 'HARD', 'SEVERE', 'EXTREME', 'IMPOSSIBLE'];

export const DIFFICULTY_SPEC = {
  TRIVIAL: { required: 0, label: 'по силам любому' },
  PLAIN: { required: 20, label: 'обычное' },
  HARD: { required: 45, label: 'трудное' },
  SEVERE: { required: 70, label: 'очень трудное' },
  EXTREME: { required: 95, label: 'на пределе' },
  IMPOSSIBLE: { required: Infinity, label: 'невозможное' },
};

export function normalizeDifficultyBand(raw, fallback = 'PLAIN') {
  const key = String(raw || '').trim().toUpperCase();
  return DIFFICULTY_BANDS.includes(key) ? key : fallback;
}

export function difficultyBandIndex(band) {
  return DIFFICULTY_BANDS.indexOf(normalizeDifficultyBand(band));
}

export function shiftDifficultyBand(band, steps) {
  const i = difficultyBandIndex(band);
  const next = Math.max(0, Math.min(DIFFICULTY_BANDS.length - 1, i + Math.round(Number(steps) || 0)));
  return DIFFICULTY_BANDS[next];
}

export function requiredStat(band) {
  return DIFFICULTY_SPEC[normalizeDifficultyBand(band)].required;
}

/** Невозможное — флаг, а не порог: бросок не спасёт даже при стате 100 с благословением. */
export function isImpossible(band) {
  return normalizeDifficultyBand(band) === 'IMPOSSIBLE';
}

// ──────────────────────────── счётчик угрозы ────────────────────────────

export const THREAT_BANDS = ['DAYS', 'WEEKS', 'SEASON', 'YEAR'];

export const THREAT_SPEC = {
  DAYS: { min: 5, max: 20, label: 'дни' },
  WEEKS: { min: 25, max: 60, label: 'недели' },
  SEASON: { min: 60, max: 150, label: 'сезон' },
  YEAR: { min: 150, max: 360, label: 'год' },
};

/** Насколько вероятно, что город изначально видит угрозу этой полосы. */
export const THREAT_KNOWN_CHANCE = {
  DAYS: 0.9,
  WEEKS: 0.9,
  SEASON: 0.6,
  YEAR: 0.25,
};

export function normalizeThreatBand(raw, fallback = 'SEASON') {
  const key = String(raw || '').trim().toUpperCase();
  return THREAT_BANDS.includes(key) ? key : fallback;
}

export function threatBandIndex(band) {
  return THREAT_BANDS.indexOf(normalizeThreatBand(band));
}

export function shiftThreatBand(band, steps) {
  const i = threatBandIndex(band);
  const next = Math.max(0, Math.min(THREAT_BANDS.length - 1, i + Math.round(Number(steps) || 0)));
  return THREAT_BANDS[next];
}

export function rollThreatDays(band, rng = Math.random) {
  const spec = THREAT_SPEC[normalizeThreatBand(band)];
  return spec.min + Math.round(rng() * (spec.max - spec.min));
}

/**
 * Полосы слотов параллельных угроз.
 * Веса падают у уже выпавшей полосы, чтобы набор обычно был разнородным,
 * но изредка выпадал целиком быстрым или целиком медленным.
 */
export const THREAT_SLOT_WEIGHTS = { WEEKS: 40, SEASON: 40, YEAR: 20 };
export const THREAT_REPEAT_DAMPING = 0.35;

export function pickThreatBands(count, rng = Math.random, { damping = THREAT_REPEAT_DAMPING } = {}) {
  const weights = { ...THREAT_SLOT_WEIGHTS };
  const out = [];
  for (let i = 0; i < Math.max(0, Math.round(count)); i += 1) {
    const keys = Object.keys(weights);
    const total = keys.reduce((sum, k) => sum + weights[k], 0);
    if (total <= 0) {
      out.push('SEASON');
      continue;
    }
    let r = rng() * total;
    let picked = keys[keys.length - 1];
    for (const k of keys) {
      r -= weights[k];
      if (r <= 0) {
        picked = k;
        break;
      }
    }
    out.push(picked);
    weights[picked] *= damping;
  }
  return out;
}

// ─────────────────────────── полоса остатка ───────────────────────────

/**
 * Что жрец знает о сроке известной угрозы: полоса, а не число.
 * Тот же словарь, что у сроков дел, — чтобы можно было сравнивать вслух.
 */
export function remainingBand(days) {
  const d = Math.max(0, Number(days) || 0);
  if (d <= 3) return 'INSTANT';
  if (d <= 18) return 'DAYS';
  if (d <= 65) return 'WEEKS';
  if (d <= 160) return 'SEASON';
  if (d <= 400) return 'YEAR';
  return 'YEARS';
}

/**
 * Успеет ли дело к сроку угрозы. Сравниваем по дням, а жрецу отдаём полосы.
 * `inTime: false` — повод жрецу поправить покровителя.
 */
export function deedBeatsThreat(deedDays, threatRemainingDays) {
  const deed = Math.max(0, Number(deedDays) || 0);
  const threat = Math.max(0, Number(threatRemainingDays) || 0);
  return {
    inTime: deed <= threat,
    deedBand: remainingBand(deed),
    threatBand: remainingBand(threat),
  };
}
