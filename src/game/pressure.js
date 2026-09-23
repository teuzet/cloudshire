/**
 * Шкала напряжения истории.
 *
 * Беды больше не тикают своим сроком. Каждый день шкала растёт сама,
 * и на ста она выбирает беду из пула. Дела сдвигают уже накопленное.
 */

import { parseFreeformGravity, parseFreeformUrgency } from './plotlines.js';

export const PRESSURE_DEFAULTS = {
  directFail: 25,
  relevantFail: 20,
  directCrit: -15,
  relevantPerThreat: -8,
  relevantCritFactor: 2,
  relevantDepthPerThreat: 0.02,
  relevantCritDepthFactor: 1.5,
  neutralDepthShare: 0.5,
  fillDays: {
    FAST: [30, 60],
    MEDIUM: [60, 120],
    SLOW: [120, 240],
  },
  gravityFactor: {
    SITUATION: 0.8,
    EPISODE: 1,
    CRISIS: 1.2,
    RUPTURE: 1.5,
  },
  perStage: {
    SITUATION: [1, 3],
    EPISODE: [3, 6],
    CRISIS: [7, 12],
    RUPTURE: [15, 20],
  },
};

export function threatConfig(config) {
  const raw = config?.tick?.plot?.threats || {};
  const pressure = raw.pressure || {};
  return {
    directFail: numberOr(pressure.directFail, PRESSURE_DEFAULTS.directFail),
    relevantFail: numberOr(pressure.relevantFail, PRESSURE_DEFAULTS.relevantFail),
    directCrit: numberOr(pressure.directCrit, PRESSURE_DEFAULTS.directCrit),
    relevantPerThreat: numberOr(pressure.relevantPerThreat, PRESSURE_DEFAULTS.relevantPerThreat),
    relevantCritFactor: numberOr(pressure.relevantCritFactor, PRESSURE_DEFAULTS.relevantCritFactor),
    relevantDepthPerThreat: numberOr(raw.relevantDepthPerThreat, PRESSURE_DEFAULTS.relevantDepthPerThreat),
    relevantCritDepthFactor: numberOr(raw.relevantCritDepthFactor, PRESSURE_DEFAULTS.relevantCritDepthFactor),
    neutralDepthShare: numberOr(raw.neutralDepthShare, PRESSURE_DEFAULTS.neutralDepthShare),
    fillDays: { ...PRESSURE_DEFAULTS.fillDays, ...(pressure.fillDays || {}) },
    gravityFactor: { ...PRESSURE_DEFAULTS.gravityFactor, ...(pressure.gravityFactor || {}) },
    perStage: { ...PRESSURE_DEFAULTS.perStage, ...(raw.perStage || {}) },
  };
}

function numberOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function pressureRate(plot) {
  const days = Math.max(1, Math.round(Number(plot?.pressure?.fillDays) || 1));
  return 100 / days;
}

/** Значение шкалы на игровой день. Выше ста не поднимается. */
export function pressureAt(plot, day) {
  const stored = plot?.pressure;
  if (!stored) return 0;
  const elapsed = Math.max(0, Math.round(Number(day) || 0) - Math.round(Number(stored.day) || 0));
  return Math.min(100, Math.max(0, Number(stored.value) || 0) + elapsed * pressureRate(plot));
}

export function rollFillDays(plot, config, rng = Math.random) {
  const cfg = threatConfig(config);
  const urgency = parseFreeformUrgency(plot?.urgency);
  const span = cfg.fillDays[urgency] || cfg.fillDays.MEDIUM;
  const min = Math.max(1, Math.round(Number(span[0]) || 1));
  const max = Math.max(min, Math.round(Number(span[1]) || min));
  const rolled = min + rng() * (max - min);
  const factor = cfg.gravityFactor[parseFreeformGravity(plot?.gravity)] || 1;
  return Math.max(1, Math.round(rolled * factor));
}

export function resetPressure(plot, day, config, rng = Math.random) {
  if (!plot) return null;
  plot.pressure = {
    value: 0,
    day: Math.round(Number(day) || 0),
    fillDays: rollFillDays(plot, config, rng),
  };
  return plot.pressure;
}

export function ensurePressure(plot, day, config, rng = Math.random) {
  if (!plot?.pressure || !Number.isFinite(Number(plot.pressure.fillDays))) {
    return resetPressure(plot, day, config, rng);
  }
  return plot.pressure;
}

/**
 * Довести шкалу до сегодня и прибавить delta.
 * filled — переход через ста именно этим сдвигом.
 */
export function shiftPressure(plot, day, delta) {
  if (!plot?.pressure) return { before: 0, after: 0, filled: false };
  const before = pressureAt(plot, day);
  const after = clamp(before + (Number(delta) || 0), 0, 100);
  plot.pressure.value = after;
  plot.pressure.day = Math.round(Number(day) || 0);
  return { before, after, filled: before < 100 && after >= 100 };
}

/** День, когда шкала дойдёт до ста при текущей скорости. */
export function fillDay(plot) {
  const stored = plot?.pressure;
  if (!stored) return null;
  const value = Math.max(0, Number(stored.value) || 0);
  const day = Math.round(Number(stored.day) || 0);
  if (value >= 100) return day;
  const days = Math.ceil((100 - value) / pressureRate(plot));
  return day + days;
}
