/**
 * Вера — пятая ось города. Она не стат: фронты её не тратят и ценой не считают.
 * Лениво тянется к среднему четырёх статов и получает импульсы от событий по таблице.
 */

import type { FaithCase, FaithStrength, Rules } from '../rules.js';
import type { City } from '../city.js';
import { DAYS_PER_MONTH } from '../time.js';
import { statMean } from './stats.js';

const clip = (n: number) => Math.max(0, Math.min(100, n));

/** Довести веру до дня `day`: за месяц она проходит долю `pullPerMonth` разрыва со средним статов. */
export function settleFaith(rules: Rules, city: Pick<City, 'faith' | 'stats'>, day: number): number {
  const now = Math.max(city.faith.day, Math.round(day));
  const months = (now - city.faith.day) / DAYS_PER_MONTH;
  if (months > 0) {
    const mean = statMean(city);
    const keep = Math.pow(1 - rules.faith.pullPerMonth, months);
    city.faith.value = clip(mean + (city.faith.value - mean) * keep);
  }
  city.faith.day = now;
  return city.faith.value;
}

/** Импульс от события. Возвращает, на сколько вера сдвинулась. */
export function faithImpulse(
  rules: Rules,
  city: Pick<City, 'faith' | 'stats'>,
  ruling: { case: FaithCase; strength: FaithStrength },
  day: number,
): number {
  settleFaith(rules, city, day);
  if (ruling.case === 'none') return 0;
  const delta = rules.faith.impulses[ruling.strength][ruling.case];
  const before = city.faith.value;
  city.faith.value = clip(before + delta);
  return city.faith.value - before;
}

/** Вера целым числом: то, что видят игрок и расчёт маны. */
export function faithOf(city: Pick<City, 'faith'>): number {
  return Math.round(clip(city.faith.value));
}
