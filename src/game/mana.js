/**
 * Мана покровителя: 0–100. Приход непрерывный — за реальные сутки (игровой год)
 * приходит ровно столько, сколько веры. Хранится дробной, показывается целой.
 *
 * Мана — лимитер разговора, а не платный вход. Чтение бесплатно всегда:
 * при нуле маны игрок не должен оказаться запертым вне игры.
 */

import { DAYS_PER_YEAR } from './gameClock.js';
import { DURATION_BANDS, normalizeDurationBand } from './bands.js';

export const MANA_MAX = 100;

/** Ход правителя. Тул-коллы дороже: они двигают мир, а не только речь. */
export const MANA_TURN_COST = 1;
export const MANA_TURN_COST_WITH_TOOLS = 2;

/** Благословение по полосе срока: чем длиннее дело, тем дороже вмешательство. */
export const MANA_BLESS_BY_BAND = {
  INSTANT: 2,
  DAYS: 4,
  WEEKS: 8,
  SEASON: 15,
  YEAR: 25,
  YEARS: 40,
};

function clampMana(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MANA_MAX, v));
}

/**
 * Округление хранимого значения. Шесть знаков, а не два: приход считается
 * дневными шагами, и грубое округление на каждом шаге воровало бы ману
 * у того, кто заходит часто.
 */
function store(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Точное значение для арифметики. */
export function manaExact(domain) {
  return clampMana(domain?.state?.mana);
}

/** То, что видит игрок. */
export function currentMana(domain) {
  return Math.floor(manaExact(domain));
}

export function blessManaCost(process) {
  const band = normalizeDurationBand(
    process?.durationBand || process?.objectiveDurationBand,
    null,
  );
  if (band && DURATION_BANDS.includes(band)) return MANA_BLESS_BY_BAND[band];
  const months = Number(process?.objectiveMonths || process?.expectedMonths);
  const days = Number.isFinite(Number(process?.objectiveDays || process?.totalDays))
    ? Number(process?.objectiveDays || process?.totalDays)
    : Number.isFinite(months) && months > 0
      ? months * 30
      : NaN;
  if (Number.isFinite(days) && days > 0) {
    if (days <= 3) return MANA_BLESS_BY_BAND.INSTANT;
    if (days <= 15) return MANA_BLESS_BY_BAND.DAYS;
    if (days <= 60) return MANA_BLESS_BY_BAND.WEEKS;
    if (days <= 150) return MANA_BLESS_BY_BAND.SEASON;
    if (days <= 360) return MANA_BLESS_BY_BAND.YEAR;
    return MANA_BLESS_BY_BAND.YEARS;
  }
  return MANA_BLESS_BY_BAND.WEEKS;
}

/**
 * Начислить ману за прошедшие игровые дни. Идемпотентно по `manaDay`:
 * повторный вызов в тот же день ничего не добавит, а пропущенные дни
 * (процесс лежал) добавит все сразу.
 */
export function accrueMana(domain, day) {
  if (!domain || typeof domain !== 'object') return { granted: 0, mana: 0 };
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  const now = Math.max(0, Math.round(Number(day) || 0));
  const last = Number(domain.state.manaDay);
  if (!Number.isFinite(last)) {
    domain.state.manaDay = now;
    domain.state.mana = manaExact(domain);
    return { granted: 0, mana: manaExact(domain) };
  }
  const elapsed = Math.max(0, now - last);
  if (elapsed === 0) return { granted: 0, mana: manaExact(domain) };
  const faith = Math.max(0, Math.min(100, Number(domain.state.faith) || 0));
  const before = manaExact(domain);
  const mana = clampMana(before + (faith * elapsed) / DAYS_PER_YEAR);
  domain.state.mana = store(mana);
  domain.state.manaDay = now;
  return { granted: store(mana - before), mana: domain.state.mana, faith };
}

export function turnManaCost({ usedTools = false } = {}) {
  return usedTools ? MANA_TURN_COST_WITH_TOOLS : MANA_TURN_COST;
}

export function canAffordTurn(domain) {
  return manaExact(domain) >= MANA_TURN_COST;
}

export function spendMana(domain, cost) {
  const need = Math.max(0, Number(cost) || 0);
  const have = manaExact(domain);
  if (have < need) return { ok: false, error: 'no_mana', mana: currentMana(domain), cost: need };
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  domain.state.mana = store(have - need);
  return { ok: true, mana: domain.state.mana, cost: need };
}

/**
 * Списание за ход. Онбординг освобождён: учить игрока за его же ману — плохо.
 */
export function spendTurnMana(domain, { usedTools = false, free = false } = {}) {
  if (free) return { ok: true, mana: manaExact(domain), cost: 0 };
  return spendMana(domain, turnManaCost({ usedTools }));
}
