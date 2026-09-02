/**
 * Мана покровителя: 0–100. За 12 тиков приходит столько, сколько веры.
 * Благословение дела стоит 10 за каждый месяц базовой длительности (оценщик).
 */

export const MANA_MAX = 100;
export const MANA_TICKS_TO_FAITH = 12;
export const MANA_BLESS_PER_MONTH = 10;

function clampMana(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MANA_MAX, v));
}

export function currentMana(domain) {
  return clampMana(domain?.state?.mana);
}

export function blessManaCost(process) {
  const months = Math.max(
    1,
    Math.round(Number(process?.objectiveMonths || process?.expectedMonths || 1)),
  );
  return months * MANA_BLESS_PER_MONTH;
}

/** Доля веры за тик без потери за год: remainder += faith, income = floor(remainder/12). */
export function grantManaForTick(domain) {
  if (!domain || typeof domain !== 'object') return { granted: 0, mana: 0 };
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  const faith = Math.max(0, Math.min(100, Math.round(Number(domain.state.faith) || 0)));
  let remainder = Math.max(0, Math.round(Number(domain.state.manaAccrue) || 0));
  remainder += faith;
  const granted = Math.floor(remainder / MANA_TICKS_TO_FAITH);
  remainder %= MANA_TICKS_TO_FAITH;
  const before = currentMana(domain);
  const mana = Math.min(MANA_MAX, before + granted);
  domain.state.mana = mana;
  domain.state.manaAccrue = remainder;
  return { granted: mana - before, mana, faith };
}

export function spendMana(domain, cost) {
  const need = Math.max(0, Math.round(Number(cost) || 0));
  const have = currentMana(domain);
  if (have < need) return { ok: false, error: 'no_mana', mana: have, cost: need };
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  domain.state.mana = have - need;
  return { ok: true, mana: domain.state.mana, cost: need };
}
