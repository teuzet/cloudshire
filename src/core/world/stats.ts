/**
 * Статы города производные:
 *
 *   stat[k] = clip(0, 100, round(statScale * Σ objects.statEffect[k] + ledger[k]))
 *
 * statScale фиксируется на генезисе так, чтобы сумма статов была ровно statBudget.
 * ledger держит изменения без носителя в мире и подгонку генезиса под коридор.
 */

import { emptyStatMap, STAT_IDS, type Impact, type Rules, type StatId, type StatMap } from '../rules.js';
import type { City } from '../city.js';
import { activeObjects } from './objects.js';
import { impactRawBudget } from './scales.js';

export function sumObjectEffects(city: Pick<City, 'objects'>): StatMap {
  const sum = emptyStatMap();
  for (const obj of activeObjects(city)) {
    for (const id of STAT_IDS) sum[id] += obj.statEffect[id];
  }
  return sum;
}

/** Пересчитать статы из объектов и ledger. Мутирует и возвращает city.stats. */
export function recomputeStats(city: Pick<City, 'objects' | 'statScale' | 'statLedger' | 'stats'>): StatMap {
  const sum = sumObjectEffects(city);
  for (const id of STAT_IDS) {
    const raw = city.statScale * sum[id] + city.statLedger[id];
    city.stats[id] = Math.max(0, Math.min(100, Math.round(raw)));
  }
  return city.stats;
}

export function addToLedger(
  city: Pick<City, 'objects' | 'statScale' | 'statLedger' | 'stats'>,
  deltas: Partial<StatMap>,
): StatMap {
  for (const id of STAT_IDS) {
    const n = Number(deltas[id]);
    if (Number.isFinite(n) && n !== 0) city.statLedger[id] += n;
  }
  return recomputeStats(city);
}

/** Вера — среднее четырёх статов. Не хранится, всегда считается. */
export function faithOf(city: Pick<City, 'stats'>): number {
  const sum = STAT_IDS.reduce((acc, id) => acc + city.stats[id], 0);
  return Math.max(0, Math.min(100, Math.round(sum / STAT_IDS.length)));
}

/**
 * Сырой вклад объекта: бюджет веса делится между статами пропорционально
 * модулю профиля, знак сохраняется.
 */
export function objectContribution(rules: Rules, weight: Impact, profile: Partial<StatMap>): StatMap {
  const budget = impactRawBudget(rules, weight);
  let denom = 0;
  for (const id of STAT_IDS) denom += Math.abs(Number(profile[id]) || 0);
  const out = emptyStatMap();
  if (denom === 0) return out;
  for (const id of STAT_IDS) out[id] = (budget * (Number(profile[id]) || 0)) / denom;
  return out;
}

/** Довести набор целых до суммы budget, не выходя из [min, max]. Порядок сохраняется. */
export function clipToBudget(values: number[], { budget, min, max }: { budget: number; min: number; max: number }): number[] {
  const ints = values.map((v) => Math.max(min, Math.min(max, Math.round(v))));
  let cur = ints.reduce((a, b) => a + b, 0);
  for (let guard = 0; cur !== budget && guard < 1000; guard += 1) {
    const dir = cur < budget ? 1 : -1;
    let idx = -1;
    let best = -1;
    ints.forEach((v, i) => {
      if (dir > 0 && v >= max) return;
      if (dir < 0 && v <= min) return;
      const room = dir > 0 ? max - v : v - min;
      if (room > best) {
        best = room;
        idx = i;
      }
    });
    if (idx < 0) break;
    ints[idx] = (ints[idx] ?? 0) + dir;
    cur += dir;
  }
  return ints;
}

export interface GenesisStats {
  statScale: number;
  stats: StatMap;
  ledger: StatMap;
}

/**
 * Масштаб генезиса: сумма статов ровно statBudget, каждый в коридоре.
 * Подгонка под коридор уходит в ledger, чтобы статы остались честно производными.
 */
export function genesisStats(rules: Rules, contributions: StatMap[]): GenesisStats {
  const summed = emptyStatMap();
  for (const c of contributions) for (const id of STAT_IDS) summed[id] += c[id];
  const total = STAT_IDS.reduce((acc, id) => acc + summed[id], 0);
  if (!(total > 0)) throw new Error('суммарный вклад объектов неположительный');
  const { statBudget, statMin, statMax } = rules.genesis;
  const statScale = statBudget / total;
  const derived = STAT_IDS.map((id) => Math.round(statScale * summed[id]));
  const final = clipToBudget(derived, { budget: statBudget, min: statMin, max: statMax });
  const stats = emptyStatMap();
  const ledger = emptyStatMap();
  STAT_IDS.forEach((id, i) => {
    stats[id] = final[i] ?? 0;
    ledger[id] = (final[i] ?? 0) - (derived[i] ?? 0);
  });
  return { statScale, stats, ledger };
}

/** Ближайшая нижняя ступень шкалы. */
function floorKey(value: number, scale: Record<string, string>): string | undefined {
  const keys = Object.keys(scale)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let key: number | undefined = keys[0];
  for (const k of keys) if (k <= value) key = k;
  return key == null ? undefined : String(key);
}

/** «ужасающе» … «божественно». */
export function statEpithet(rules: Rules, value: number): string {
  const key = floorKey(value, rules.statEpithets);
  return (key && rules.statEpithets[key]) || 'обычно';
}

/** Качественная сводка статов для агентов: без чисел, эпитет и ориентир. */
export function qualitativeStats(rules: Rules, stats: StatMap): string {
  return rules.stats
    .map((def) => {
      const v = stats[def.id];
      const key = floorKey(v, def.scale);
      const hint = (key && def.scale[key]) || '';
      return `- ${def.name} (${statEpithet(rules, v)}).${def.about ? ` ${def.about}` : ''}${hint ? ` Ориентир: ${hint}` : ''}`;
    })
    .join('\n');
}

export function statName(rules: Rules, id: StatId): string {
  return rules.stats.find((s) => s.id === id)?.name ?? id;
}
