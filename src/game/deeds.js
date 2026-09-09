/**
 * Дело на непрерывном времени.
 *
 * Раньше дело жило месяцами: `expectedMonths`, `monthsLeft`, бросок хода на тике.
 * Теперь у него есть день начала и день срока, а бросок один — на финише.
 * Промежуточных «ходов» нет: между началом и исходом в деле не происходит
 * ничего, о чём стоило бы писать хронику.
 *
 * Месячные поля остаются производными: их читают мини-аппка, тулы жреца и
 * старый месячный путь сопряжения. Писать в них напрямую больше не нужно.
 */

import {
  DURATION_SPEC,
  MIN_OFFICER_DAYS,
  normalizeDifficultyBand,
  normalizeDurationBand,
  isImpossible,
  rollDurationDays,
  remainingBand,
} from './bands.js';
import {
  deedMargin,
  marginToCurveInput,
  normalizePaceShift,
  pacedDurationBand,
  paceRatio,
} from './deedMath.js';
import { DAYS_PER_MONTH } from './gameClock.js';
import { applyBlessShift, rollProcessFinish, FINISH_LABELS } from './rolls.js';
import { listStatIds } from './processes.js';

/** Сколько игровых месяцев показать в старых полях. Ноль не показываем: дело идёт. */
function monthsOf(days) {
  return Math.max(1, Math.min(12, Math.round(Math.max(0, Number(days) || 0) / DAYS_PER_MONTH)));
}

/**
 * Привести дело к дневной модели. Идемпотентно и безопасно для старых записей:
 * дело, заведённое месяцами, получает дни из `objectiveMonths`.
 */
export function normalizeDeed(process) {
  if (!process || typeof process !== 'object') return process;

  process.durationBand = normalizeDurationBand(process.durationBand);
  process.difficulty = normalizeDifficultyBand(process.difficulty);
  process.paceShift = normalizePaceShift(process.paceShift);
  process.pacedBand = pacedDurationBand(process.durationBand, process.paceShift);

  const spec = DURATION_SPEC[process.durationBand];
  let objective = Math.round(Number(process.objectiveDays));
  if (!Number.isFinite(objective) || objective <= 0) {
    const months = Number(process.objectiveMonths || process.expectedMonths);
    objective = Number.isFinite(months) && months > 0 ? Math.round(months * DAYS_PER_MONTH) : spec.min;
  }
  process.objectiveDays = Math.max(1, objective);

  let scheduled = Math.round(Number(process.scheduledDays));
  if (!Number.isFinite(scheduled) || scheduled <= 0) scheduled = process.objectiveDays;
  process.scheduledDays = Math.max(1, scheduled);

  process.officerDays = Math.max(
    MIN_OFFICER_DAYS,
    Math.round(Number(process.officerDays) || process.scheduledDays),
  );

  if (process.startDay != null) process.startDay = Math.max(0, Math.round(Number(process.startDay) || 0));
  if (process.dueDay != null) process.dueDay = Math.max(0, Math.round(Number(process.dueDay) || 0));
  if (process.startDay != null && process.dueDay == null) {
    process.dueDay = process.startDay + process.scheduledDays;
  }

  process.impossible = Boolean(process.impossible) || isImpossible(process.difficulty);

  // Производные месячные поля: только для чтения старым кодом и мини-аппкой.
  process.objectiveMonths = monthsOf(process.objectiveDays);
  process.expectedMonths = monthsOf(process.scheduledDays);
  process.durationMonths = process.expectedMonths;
  return process;
}

/**
 * Поставить дело на календарь. День срока считается от дня начала, а не от
 * «конца месяца»: дело, заведённое в разговоре, кончится ровно через свой срок.
 */
export function startDeed(process, { day = 0, judged = null, rng = Math.random } = {}) {
  if (!process || typeof process !== 'object') return process;
  if (judged) {
    process.durationBand = normalizeDurationBand(judged.durationBand);
    process.difficulty = normalizeDifficultyBand(judged.difficulty);
    if (judged.objectiveDays) process.objectiveDays = Math.max(1, Math.round(judged.objectiveDays));
    if (judged.impossible) process.impossible = true;
    if (judged.note) process.judgeNote = String(judged.note).slice(0, 240);
  }
  normalizeDeed(process);
  if (!Number.isFinite(Number(process.objectiveDays)) || process.objectiveDays <= 0) {
    process.objectiveDays = rollDurationDays(process.durationBand, rng);
  }
  if (process.paceShift === 0) {
    process.scheduledDays = process.objectiveDays;
  } else {
    process.scheduledDays = Math.max(1, rollDurationDays(process.pacedBand, rng));
  }
  process.startDay = Math.max(0, Math.round(Number(day) || 0));
  process.dueDay = process.startDay + process.scheduledDays;
  process.officerDays = Math.max(MIN_OFFICER_DAYS, process.scheduledDays);
  normalizeDeed(process);
  return process;
}

export function deedElapsedDays(process, day) {
  const start = Number(process?.startDay);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.round(Number(day) || 0) - start);
}

export function deedRemainingDays(process, day) {
  const due = Number(process?.dueDay);
  if (!Number.isFinite(due)) return Math.max(1, Number(process?.scheduledDays) || 1);
  return Math.max(0, due - Math.round(Number(day) || 0));
}

/** Полоса остатка — то, что жрец может сказать вслух. */
export function deedRemainingBand(process, day) {
  return remainingBand(deedRemainingDays(process, day));
}

export function deedDue(process, day) {
  return deedRemainingDays(process, day) <= 0;
}

/**
 * Пауза и снятие с паузы на дневном времени: остаток срока сохраняется,
 * день срока сдвигается на всё время простоя.
 */
export function pauseDeedClock(process, day) {
  if (!process) return process;
  process.pausedRemainingDays = deedRemainingDays(process, day);
  process.pausedDay = Math.round(Number(day) || 0);
  process.dueDay = null;
  return process;
}

export function resumeDeedClock(process, day) {
  if (!process) return process;
  const left = Math.max(1, Math.round(Number(process.pausedRemainingDays) || process.scheduledDays || 1));
  process.dueDay = Math.round(Number(day) || 0) + left;
  delete process.pausedRemainingDays;
  delete process.pausedDay;
  return process;
}

/**
 * Сменить темп. Сдвиг суммарный и не больше одной ступени: вторая просьба
 * «поторопитесь» получает честный отказ, а не бесконечное сжатие срока.
 */
export function applyPace(process, nextShift, { day = 0, rng = Math.random } = {}) {
  if (!process) return { ok: false, error: 'not_found' };
  normalizeDeed(process);
  const wanted = normalizePaceShift(nextShift);
  if (wanted === process.paceShift) return { ok: false, error: 'same_pace', paceShift: process.paceShift };

  const elapsed = deedElapsedDays(process, day);
  const band = pacedDurationBand(process.durationBand, wanted);
  const total = Math.max(elapsed + 1, Math.round(rollDurationDays(band, rng)));
  process.paceShift = wanted;
  process.pacedBand = band;
  process.scheduledDays = total;
  process.dueDay = Math.max(0, Math.round(Number(process.startDay) || 0)) + total;
  normalizeDeed(process);
  return {
    ok: true,
    paceShift: wanted,
    pacedBand: band,
    remainingDays: deedRemainingDays(process, day),
  };
}

/** Стат дела: связанный стат города, чужой портфель считается в марже. */
export function deedStat(domain, process, config = null) {
  const stats = domain?.stats || {};
  const id = (process?.linkedStats || [])[0];
  if (id && Number.isFinite(Number(stats[id]))) return Math.max(0, Math.min(100, Number(stats[id])));
  const ids = listStatIds(config);
  const vals = (ids.length ? ids.map((k) => stats[k]) : Object.values(stats))
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return 50;
  return Math.max(0, Math.min(100, vals.reduce((a, b) => a + b, 0) / vals.length));
}

/** Маржа исхода: стат минус требование сложности, плюс благословение. */
export function deedMarginFor(domain, process, config = null) {
  return deedMargin({
    stat: deedStat(domain, process, config),
    difficulty: process?.difficulty,
    blessed: Boolean(process?.blessed),
    offPortfolio: Boolean(process?.offPortfolio),
  });
}

/**
 * Бросок исхода. Сложность входит в кривую через маржу, спешка — через
 * `paceRatio`, как и раньше. Невозможное дело не бросается вовсе.
 */
export function rollDeedFinish(domain, process, { config = null, rng = Math.random } = {}) {
  normalizeDeed(process);
  const blessed = Boolean(process.blessed);
  if (process.impossible) {
    return {
      finish: 'fail',
      rolled: 'fail',
      blessed,
      impossible: true,
      margin: -Infinity,
      curveInput: 0,
      paceRatio: 1,
      weights: { fail: 100, ok: 0, crit: 0 },
    };
  }
  const margin = deedMarginFor(domain, process, config);
  const curveInput = marginToCurveInput(margin);
  const ratio = paceRatio({
    objectiveDays: process.objectiveDays,
    scheduledDays: process.scheduledDays,
  });
  const rolled = rollProcessFinish(curveInput, ratio, rng, config?.tick?.plot?.roll || {});
  const finish = blessed ? applyBlessShift(rolled.finish) : rolled.finish;
  return {
    finish,
    rolled: rolled.finish,
    blessed,
    impossible: false,
    margin,
    curveInput,
    paceRatio: ratio,
    roll: rolled.roll,
    weights: rolled.weights,
  };
}

/** Закрыть дело исходом. Столп освобождает вызывающий: он же ведёт сановников. */
export function finishDeed(process, { day = 0, finish = 'ok', blessed = false } = {}) {
  if (!process) return process;
  normalizeDeed(process);
  process.status = finish === 'fail' ? 'failed' : 'resolved';
  process.finishKind = finish;
  process.finishBlessed = Boolean(blessed || process.blessed);
  process.resolvedDay = Math.round(Number(day) || 0);
  process.dueDay = process.resolvedDay;
  process.monthsLeft = 0;
  process.monthsDone = process.expectedMonths;
  process.updatedAt = new Date().toISOString();
  return process;
}

/** Что жрец говорит об исходе. Тот же словарь, что у старого пути. */
export function deedFinishLabel(finish, blessed = false) {
  const gloss = FINISH_LABELS[finish] || FINISH_LABELS.ok;
  return blessed ? `${gloss} ${FINISH_LABELS.blessed}` : gloss;
}

/** Итог дела для хроники и рассказчика. */
export function deedOutcome(process, { finish, day = 0, roll = null } = {}) {
  return {
    processId: process?.id || null,
    summary: process?.summary || '',
    detail: process?.detail || '',
    goal: process?.goal || null,
    linkedStats: [...(process?.linkedStats || [])],
    durationBand: process?.durationBand || null,
    difficulty: process?.difficulty || null,
    paceShift: process?.paceShift || 0,
    officerId: process?.officerId || null,
    office: process?.office || null,
    intel: Boolean(process?.intel),
    blessed: Boolean(process?.blessed),
    alignment: process?.plotEngagement || null,
    finished: true,
    finish,
    finishLabel: deedFinishLabel(finish, process?.blessed),
    day: Math.round(Number(day) || 0),
    roll,
  };
}
