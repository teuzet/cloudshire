/**
 * Перевод полос в числа. Все числа — из правил; LLM их не видит.
 */

import { DAYS_PER_MONTH } from '../time.js';
import {
  IMPACT_LEVELS,
  impactRank,
  type DriftBand,
  type Efficiency,
  type Impact,
  type Risk,
  type Rules,
} from '../rules.js';
import type { Direction } from '../city.js';

export function impactEffort(rules: Rules, impact: Impact): number {
  return rules.fronts.impact.effort[impact];
}

export function impactRawBudget(rules: Rules, impact: Impact): number {
  return rules.fronts.impact.rawBudget[impact];
}

export function consequenceBudget(rules: Rules, impact: Impact): number {
  return rules.fronts.impact.consequences[impact];
}

export function driftPerDay(rules: Rules, band: DriftBand): number {
  return rules.fronts.drift.perMonth[band] / DAYS_PER_MONTH;
}

/**
 * Effort сановника за игровой день, со знаком направления.
 * backward — минус, none — ноль.
 */
export function officerRate(
  rules: Rules,
  args: { stat: number; efficiency: Efficiency; direction: Direction },
): number {
  if (args.direction === 'none') return 0;
  const a = rules.fronts.assignment;
  const stat = Math.max(0, Math.min(100, args.stat));
  const rate = a.baseRate * (a.statFloor + stat / 100) * a.efficiency[args.efficiency];
  return args.direction === 'backward' ? -rate : rate;
}

/** Пороги битов: effort * i / (beatCount + 1). */
export function beatThresholds(effort: number, beatCount: number): number[] {
  const count = Math.round(beatCount);
  if (count <= 0 || effort <= 0) return [];
  const out: number[] = [];
  for (let i = 1; i <= count; i += 1) out.push((effort * i) / (count + 1));
  return out;
}

/** Шанс осложнения за кусок выполненного effort. */
export function complicationChance(rules: Rules, risk: Risk, effortDone: number): number {
  const per = rules.fronts.risk.perEffort[risk];
  return 1 - (1 - per) ** Math.max(0, effortDone);
}

/** Не дать осложнению превысить потолок ущерба для этого риска. */
export function clampImpactByRisk(rules: Rules, risk: Risk, proposed: Impact): Impact {
  const cap = rules.fronts.risk.impactCap[risk];
  return impactRank(proposed) > impactRank(cap) ? cap : proposed;
}

export function efficiencyMultiplier(rules: Rules, level: Efficiency): number {
  return rules.fronts.assignment.efficiency[level];
}

/** Уровни, которыми модель может оценивать вес существующей вещи (без NONE). */
export function weightLevels(): Impact[] {
  return IMPACT_LEVELS.filter((l) => l !== 'NONE');
}
