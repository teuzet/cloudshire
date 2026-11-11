/**
 * Поручение сановника. Оценщик (агент) говорит только полосы:
 * направление, сила, что блокирует, когда остановиться. Скорость считает код.
 */

import type { Efficiency, Office, Risk, Rules } from '../rules.js';
import type { Assignment, City, Direction, Front, StopWhen } from '../city.js';
import { officerRate } from './scales.js';

export interface AssignmentVerdict {
  direction: Direction;
  efficiency: Efficiency;
  blocks: string[];
  stopWhen: StopWhen;
}

export const NO_EFFECT: AssignmentVerdict = { direction: 'none', efficiency: 'normal', blocks: [], stopWhen: 'stake' };

export function createAssignment(args: {
  id: string;
  frontId: string | null;
  office: Office;
  text: string;
  verdict: AssignmentVerdict;
  risk?: Risk | null;
  day: number;
}): Assignment {
  const day = Math.max(0, Math.round(args.day));
  return {
    id: args.id,
    frontId: args.frontId,
    office: args.office,
    text: args.text.trim(),
    direction: args.verdict.direction,
    efficiency: args.verdict.efficiency,
    blocks: [...new Set(args.verdict.blocks)],
    stopWhen: args.verdict.stopWhen,
    risk: args.risk ?? null,
    status: 'active',
    startDay: day,
    endDay: null,
    effortDone: 0,
    effortDay: day,
    riskCheckedAtEffort: 0,
  };
}

export function activeAssignments(city: Pick<City, 'assignments'>): Assignment[] {
  return city.assignments.filter((a) => a.status === 'active');
}

export function activeAssignmentsForFront(city: Pick<City, 'assignments'>, frontId: string): Assignment[] {
  return city.assignments.filter((a) => a.status === 'active' && a.frontId === frontId);
}

export function findAssignment(city: Pick<City, 'assignments'>, id: string): Assignment | null {
  return city.assignments.find((a) => a.id === id) ?? null;
}

/** Закрыть поручение и освободить сановника. */
export function closeAssignment(
  city: Pick<City, 'assignments' | 'officers'>,
  id: string,
  day: number,
  reason: 'done' | 'cancelled',
): Assignment | null {
  const a = findAssignment(city, id);
  if (!a || a.status !== 'active') return a;
  a.status = reason;
  a.endDay = Math.max(0, Math.round(day));
  for (const officer of city.officers) {
    if (officer.assignmentId === a.id) officer.assignmentId = null;
  }
  return a;
}

/** Скорость сановника этого поручения сейчас (со знаком). */
export function assignmentRate(rules: Rules, city: Pick<City, 'officers' | 'stats'>, a: Assignment): number {
  const officer = city.officers.find((o) => o.office === a.office);
  const stat = officer ? city.stats[officer.statId] : 0;
  return officerRate(rules, { stat, efficiency: a.efficiency, direction: a.direction });
}

/** Докопить вложенный effort всех живых поручений до дня `day`. */
export function accrueEffort(rules: Rules, city: Pick<City, 'assignments' | 'officers' | 'stats'>, day: number): void {
  const now = Math.max(0, Math.round(day));
  for (const a of activeAssignments(city)) {
    const elapsed = Math.max(0, now - a.effortDay);
    a.effortDone += Math.abs(assignmentRate(rules, city, a)) * elapsed;
    a.effortDay = now;
  }
}

/**
 * Блоки срабатывают, когда сановник реально успел поработать (не меньше единицы effort).
 * Заблокированное событие всё равно может выпасть, но ущерба не нанесёт.
 */
export function applyBlocks(city: Pick<City, 'assignments'>, front: Front): string[] {
  const blocked: string[] = [];
  for (const a of activeAssignmentsForFront(city, front.id)) {
    if (a.effortDone < 1) continue;
    for (const id of a.blocks) {
      const event = front.events.find((e) => e.id === id);
      if (event && event.status === 'live') {
        event.status = 'blocked';
        blocked.push(event.id);
      }
    }
  }
  return blocked;
}
