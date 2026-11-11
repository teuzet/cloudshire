/**
 * Мана покровителя. Сейчас она только плата за реплику жрецу.
 * Приход непрерывный: за игровой год приходит столько, сколько у города веры.
 * Чтение бесплатно всегда: при нуле маны игрок не заперт вне игры.
 */

import type { Rules } from './rules.js';
import type { City } from './city.js';
import { DAYS_PER_YEAR } from './time.js';
import { faithOf } from './world/stats.js';

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Начислить ману по прошедшим дням. Хранится дробной, показывается целой. */
export function accrueMana(rules: Rules, city: Pick<City, 'mana' | 'stats'>, day: number): number {
  const now = Math.max(0, Math.round(day));
  const elapsed = Math.max(0, now - city.mana.day);
  if (elapsed > 0) {
    const gain = (faithOf(city) * elapsed) / DAYS_PER_YEAR;
    city.mana.value = round6(Math.min(rules.mana.max, city.mana.value + gain));
  }
  city.mana.day = Math.max(city.mana.day, now);
  return city.mana.value;
}

export function turnCost(rules: Rules, { acted }: { acted: boolean }): number {
  return acted ? rules.mana.turnCostWithAction : rules.mana.turnCost;
}

export function canAfford(city: Pick<City, 'mana'>, cost: number): boolean {
  return city.mana.value + 1e-9 >= cost;
}

/** Списать ману. Не уходит в минус. */
export function spendMana(city: Pick<City, 'mana'>, cost: number): boolean {
  if (!canAfford(city, cost)) return false;
  city.mana.value = round6(Math.max(0, city.mana.value - cost));
  return true;
}

export function manaShown(city: Pick<City, 'mana'>): number {
  return Math.floor(city.mana.value + 1e-9);
}
