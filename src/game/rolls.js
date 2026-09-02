/**
 * Единый модуль бросков мира: ход дел и окраска битов нитей.
 * Весь баланс случайности живёт здесь и в config.tick.plot.roll —
 * чтобы крутить его числами, а не формулировками в промптах.
 */

import { isThreeActPlot, plotScale } from './plotlines.js';

function clampStat(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, v));
}

/**
 * Сжатая шкала: стат 0 не означает верный провал, стат 100 — не гарантия.
 * По умолчанию удача идёт от 25% до 75%. Для окраски битов, не для исхода дела.
 */
export function compressedChance(statValue, { minChance = 0.25, maxChance = 0.75 } = {}) {
  const v = clampStat(statValue) / 100;
  return minChance + (maxChance - minChance) * v;
}

/** Якоря стат → доля провала дела при обычном темпе. */
export const DEFAULT_FINISH_FAIL_CURVE = [
  { stat: 0, fail: 0.85 },
  { stat: 40, fail: 0.45 },
  { stat: 60, fail: 0.15 },
  { stat: 70, fail: 0.1 },
  { stat: 90, fail: 0 },
];

function asFailP(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v > 1) return Math.max(0, Math.min(1, v / 100));
  return Math.max(0, Math.min(1, v));
}

export function parseFinishFailCurve(raw) {
  const src = Array.isArray(raw) && raw.length ? raw : DEFAULT_FINISH_FAIL_CURVE;
  const pts = [];
  for (const item of src) {
    const stat = clampStat(item?.stat ?? item?.[0]);
    const fail = asFailP(item?.fail ?? item?.[1]);
    if (fail == null) continue;
    pts.push({ stat, fail });
  }
  pts.sort((a, b) => a.stat - b.stat);
  return pts.length ? pts : DEFAULT_FINISH_FAIL_CURVE.map((p) => ({ ...p }));
}

/**
 * Доля провала завершения дела по среднему связанных статов.
 * 40 ≈ 45%, 60–70 ≈ 10–15%, 90+ = 0.
 */
export function finishFailChance(statValue, cfg = {}) {
  const pts = parseFinishFailCurve(cfg.finishFailCurve);
  const v = clampStat(statValue);
  if (v <= pts[0].stat) return pts[0].fail;
  const last = pts[pts.length - 1];
  if (v >= last.stat) return last.fail;
  for (let i = 1; i < pts.length; i += 1) {
    if (v <= pts[i].stat) {
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.stat - a.stat || 1;
      return a.fail + ((v - a.stat) / span) * (b.fail - a.fail);
    }
  }
  return last.fail;
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

/**
 * Исход завершения дела: провал / нейтральный успех / критический успех.
 * paceRatio = назначенный срок / объективная оценка: <1 спешка, >1 обстоятельность.
 * При стате 90+ провала нет даже в спешке.
 */
export function rollProcessFinish(avgStat, paceRatio = 1, rng = Math.random, cfg = {}) {
  const critShare = Math.max(0.05, Math.min(0.45, Number(cfg.finishCritShare ?? 0.25)));
  const baseFail = finishFailChance(avgStat, cfg);
  let pFail = baseFail;
  let pCrit = (1 - pFail) * critShare;
  let pOk = (1 - pFail) * (1 - critShare);
  const ratio = Number(paceRatio);
  if (baseFail > 0 && Number.isFinite(ratio) && ratio > 0 && ratio < 1) {
    pCrit *= ratio;
    pOk *= ratio;
    pFail = 1 - pCrit - pOk;
  } else if (baseFail > 0 && Number.isFinite(ratio) && ratio > 1) {
    pFail *= 1 / ratio;
    const leftover = 1 - pFail;
    const success = pCrit + pOk;
    if (success > 0) {
      const k = leftover / success;
      pCrit *= k;
      pOk *= k;
    } else {
      pOk = leftover;
    }
  }
  const roll = rng();
  let finish = 'ok';
  if (roll < pFail) finish = 'fail';
  else if (roll >= pFail + pOk) finish = 'crit';
  return {
    finish,
    roll: Math.round(roll * 100),
    paceRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
    weights: {
      fail: Math.round(pFail * 100),
      ok: Math.round(pOk * 100),
      crit: Math.round(pCrit * 100),
    },
  };
}

export const FINISH_SHORT = {
  fail: '[ПРОВАЛ]',
  ok: '[УСПЕХ]',
  crit: '[КРИТИЧЕСКИЙ УСПЕХ]',
};

export const FINISH_LABELS = {
  fail: '[ПРОВАЛ]: цель не достигнута или достигнута только частично',
  ok: '[УСПЕХ]: цель достигнута без побочных эффектов или с небольшими негативными',
  crit: '[КРИТИЧЕСКИЙ УСПЕХ]: цель достигнута триумфально',
  blessed:
    '[КРИТИЧЕСКИЙ УСПЕХ] по благословению покровителя: цель достигнута триумфально, явно сверх смертных сил',
};

/** Токен исхода — тот же, что в инструкциях агентов. */
export function finishTag(finish) {
  return FINISH_SHORT[finish] || null;
}

/** Строка для промпта: сначала токен [ПРОВАЛ]/[УСПЕХ]/[КРИТИЧЕСКИЙ УСПЕХ], затем толкование. */
export function formatFinishForPrompt(finish, { blessed = false } = {}) {
  if (blessed) return `${FINISH_SHORT.crit}. ${FINISH_LABELS.blessed}`;
  const tag = FINISH_SHORT[finish] || FINISH_SHORT.ok;
  const gloss = FINISH_LABELS[finish] || FINISH_LABELS.ok;
  return `${tag}. ${gloss}`;
}

/** Окраска бита, вызванного делом: темп дела уже брошен, второй раз не кидаем. */
export function tintFromProcessOutcome(outcome) {
  if (!outcome) return 'dual';
  if (outcome.finished) {
    if (outcome.finish === 'fail' || outcome.failed) return 'bad';
    if (outcome.finish === 'crit') return 'good';
    return 'dual';
  }
  if (outcome.kind === 'stall') return 'bad';
  if (outcome.kind === 'surge') return 'good';
  return 'dual';
}

export const TINT_LABELS = {
  good: 'в пользу города',
  dual: 'двойственный: вышло, но с ценой',
  bad: 'против города',
};

/** Вероятность добровольного бита: жар, масштаб истории и возраст. */
export function beatChance(plot, cfg) {
  const b = cfg?.beats || {};
  if (isThreeActPlot(plot)) {
    const raw = Number(plot.urgency) / 100;
    return Math.max(b.minChance ?? 0.05, Math.min(b.maxChance ?? 0.8, Number.isFinite(raw) ? raw : 0));
  }
  const temp = clampStat(plot?.temperature) / 100;
  const scale = Math.max(0, Math.min(100, plotScale(plot))) / 100;
  const maxAge = Math.max(1, Number(plot?.maxAgeMonths) || 6);
  const agePressure = Math.min(1, (Number(plot?.ageMonths) || 0) / maxAge);
  const raw =
    (b.baseChance ?? 0.15) +
    temp * (b.temperatureWeight ?? 0.5) +
    scale * (b.importanceWeight ?? 0.2) +
    agePressure * (b.agePressure ?? 0.15);
  return Math.max(b.minChance ?? 0.05, Math.min(b.maxChance ?? 0.8, raw));
}
