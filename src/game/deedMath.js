/**
 * Арифметика дела: маржа исхода, темп и вклад в глубину истории.
 *
 * Сложность — сдвиг по той же кривой провала, что и раньше: в `finishFailChance`
 * вместо стата подставляется `50 + margin`. Никакой новой случайности.
 */

import {
  DURATION_BANDS,
  DIFFICULTY_BANDS,
  normalizeDurationBand,
  normalizeDifficultyBand,
  requiredStat,
  isImpossible,
  shiftDurationBand,
  rollDurationDays,
} from './bands.js';

export const BLESS_MARGIN = 15;
export const OFF_PORTFOLIO_PENALTY = 40;
export const MARGIN_BASELINE = 50;

/**
 * Маржа дела. Темп сюда не входит: спешка и обстоятельность меняют
 * `paceRatio`, а он уже учтён в броске исхода.
 */
export function deedMargin({
  stat = 50,
  difficulty = 'PLAIN',
  blessed = false,
  offPortfolio = false,
} = {}) {
  const band = normalizeDifficultyBand(difficulty);
  if (isImpossible(band)) return -Infinity;
  const s = Math.max(0, Math.min(100, Number(stat) || 0));
  let margin = s - requiredStat(band);
  if (blessed) margin += BLESS_MARGIN;
  if (offPortfolio) margin -= OFF_PORTFOLIO_PENALTY;
  return margin;
}

/** Значение, которое уходит в `finishFailChance` вместо стата. */
export function marginToCurveInput(margin) {
  if (!Number.isFinite(margin)) return 0;
  return Math.max(0, Math.min(100, MARGIN_BASELINE + margin));
}

// ─────────────────────────────── темп ───────────────────────────────

export const PACE_SHIFTS = [-1, 0, 1];

export function normalizePaceShift(raw) {
  const v = Math.round(Number(raw) || 0);
  return Math.max(-1, Math.min(1, v));
}

export function paceLabel(shift) {
  const s = normalizePaceShift(shift);
  if (s < 0) return 'спешка';
  if (s > 0) return 'обстоятельно';
  return 'обычно';
}

/**
 * Полоса, по которой дело реально идёт. Сдвиг максимум на одну ступень,
 * и он суммарный, а не по каждой просьбе.
 */
export function pacedDurationBand(originalBand, paceShift) {
  return shiftDurationBand(normalizeDurationBand(originalBand), normalizePaceShift(paceShift));
}

/**
 * `paceRatio = фактические дни / честная оценка`.
 * <1 — спешка, шансы успеха и крита падают пропорционально; >1 — обстоятельность.
 */
export function paceRatio({ objectiveDays, scheduledDays } = {}) {
  const objective = Math.max(1, Number(objectiveDays) || 1);
  const scheduled = Math.max(1, Number(scheduledDays) || objective);
  return scheduled / objective;
}

/** Пересчёт срока при смене темпа: тот же жребий, но в другой полосе. */
export function repaceDeed(
  { durationBand, paceShift = 0, elapsedDays = 0 } = {},
  nextShift,
  rng = Math.random,
) {
  const original = normalizeDurationBand(durationBand);
  const shift = normalizePaceShift(nextShift);
  const band = pacedDurationBand(original, shift);
  const totalDays = Math.max(1, rollDurationDays(band, rng));
  const done = Math.max(0, Number(elapsedDays) || 0);
  return {
    paceShift: shift,
    pacedBand: band,
    totalDays: Math.max(done + 1, totalDays),
    remainingDays: Math.max(1, totalDays - done),
    changed: shift !== normalizePaceShift(paceShift),
  };
}

// ────────────────────────── вклад в глубину ──────────────────────────

/**
 * Единицы работы. Срок задаёт потолок строки, сложность — крутизну внутри него:
 * быстрое дело не может сделать много, как бы трудно оно ни было.
 */
export const WORK_UNITS = {
  INSTANT: { TRIVIAL: 0.05, PLAIN: 0.1, HARD: 0.3, SEVERE: 0.5, EXTREME: 0.6 },
  DAYS: { TRIVIAL: 0.1, PLAIN: 0.2, HARD: 0.5, SEVERE: 0.8, EXTREME: 0.8 },
  WEEKS: { TRIVIAL: 0.2, PLAIN: 0.4, HARD: 0.8, SEVERE: 1.3, EXTREME: 1.4 },
  SEASON: { TRIVIAL: 0.3, PLAIN: 0.6, HARD: 1.1, SEVERE: 1.7, EXTREME: 2.0 },
  YEAR: { TRIVIAL: 0.45, PLAIN: 0.9, HARD: 1.5, SEVERE: 2.2, EXTREME: 3.0 },
  YEARS: { TRIVIAL: 0.6, PLAIN: 1.2, HARD: 2.0, SEVERE: 3.0, EXTREME: 4.0 },
};

/** Одно и то же дело делает больше для мелкой беды, чем для разрыва. */
export const GRAVITY_DEPTH_MULTIPLIER = {
  SITUATION: 2.0,
  EPISODE: 1.4,
  CRISIS: 1.0,
  RUPTURE: 0.7,
};

export const CRIT_DEPTH_MULTIPLIER = 1.5;
export const DEPTH_SPREAD = 0.15;

export function normalizeGravity(raw, fallback = 'EPISODE') {
  const key = String(raw || '').trim().toUpperCase();
  return GRAVITY_DEPTH_MULTIPLIER[key] ? key : fallback;
}

export function workUnits(durationBand, difficultyBand) {
  const dur = normalizeDurationBand(durationBand);
  const dif = normalizeDifficultyBand(difficultyBand);
  if (isImpossible(dif)) return 0;
  return WORK_UNITS[dur]?.[dif] ?? 0;
}

/**
 * Вклад дела в глубину истории.
 *
 * Считается по **исходной** полосе срока: спешка меняет шансы, а не объём работы,
 * иначе годовое дело можно было бы поторопить до сезона и получить годовой вклад.
 * Разброс ±15% — чтобы результат не был арифметически предсказуем.
 */
export function depthGain({
  durationBand,
  difficulty,
  gravity,
  finish = 'ok',
  rng = Math.random,
  spread = DEPTH_SPREAD,
} = {}) {
  if (finish === 'fail') return 0;
  const base = workUnits(durationBand, difficulty);
  if (base <= 0) return 0;
  const mult = GRAVITY_DEPTH_MULTIPLIER[normalizeGravity(gravity)];
  const crit = finish === 'crit' ? CRIT_DEPTH_MULTIPLIER : 1;
  const jitter = 1 + (rng() * 2 - 1) * Math.max(0, spread);
  const raw = base * mult * crit * jitter;
  return Math.round(raw * 100) / 100;
}

/** Хватит ли вклада, чтобы закрыть историю прямо сейчас. */
export function closesPlot({ depth = 0, gain = 0, maxDepth = 3 } = {}) {
  return Number(depth) + Number(gain) >= Math.max(0.01, Number(maxDepth) || 1);
}

/** Сколько работы осталось — для речи жреца, в единицах, не в делах. */
export function remainingWork({ depth = 0, maxDepth = 3 } = {}) {
  return Math.max(0, Math.round((Number(maxDepth) - Number(depth)) * 100) / 100);
}

export { DURATION_BANDS, DIFFICULTY_BANDS };
