/**
 * Поручения: сановник ведёт один фронт. Стратегия и темп — свойства назначения.
 */

import type { Tempo, Verdict } from '../rules.js';
import type { Assignment, City, Front, Officer } from '../city.js';

export function activeAssignments(city: Pick<City, 'assignments'>): Assignment[] {
  return city.assignments.filter((a) => a.status === 'active');
}

/** Ведущий фронта: активное поручение на нём. Один на фронт. */
export function leadOf(city: Pick<City, 'assignments'>, frontId: string): Assignment | null {
  return city.assignments.find((a) => a.status === 'active' && a.frontId === frontId) ?? null;
}

export function officerOf(city: Pick<City, 'officers'>, assignment: Pick<Assignment, 'office'>): Officer | null {
  return city.officers.find((o) => o.office === assignment.office) ?? null;
}

export function assignmentOf(city: Pick<City, 'assignments'>, officer: Pick<Officer, 'assignmentId'>): Assignment | null {
  if (!officer.assignmentId) return null;
  return city.assignments.find((a) => a.id === officer.assignmentId && a.status === 'active') ?? null;
}

export function createAssignment(
  city: Pick<City, 'assignments'>,
  args: { id: string; front: Pick<Front, 'id'>; officer: Officer; text?: string; verdict?: Verdict; tempo?: Tempo; day: number },
): Assignment {
  if (args.officer.assignmentId) throw new Error(`сановник ${args.officer.office} уже занят`);
  if (leadOf(city, args.front.id)) throw new Error(`у фронта ${args.front.id} уже есть ведущий`);
  const assignment: Assignment = {
    id: args.id,
    frontId: args.front.id,
    office: args.officer.office,
    text: (args.text ?? '').trim().slice(0, 600),
    verdict: args.verdict ?? 'fits',
    tempo: args.tempo ?? 0,
    status: 'active',
    startDay: Math.max(0, Math.round(args.day)),
    endDay: null,
  };
  city.assignments.push(assignment);
  args.officer.assignmentId = assignment.id;
  return assignment;
}

/** Снять сановника с дела. Он снова свободен. */
export function closeAssignment(city: Pick<City, 'officers'>, assignment: Assignment, day: number): void {
  if (assignment.status !== 'active') return;
  assignment.status = 'ended';
  assignment.endDay = Math.max(0, Math.round(day));
  const officer = officerOf(city, assignment);
  if (officer?.assignmentId === assignment.id) officer.assignmentId = null;
}
