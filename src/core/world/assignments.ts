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

/**
 * Отвлечь занятого сановника на малое дело. Прежнее поручение остаётся за ним и стоит; когда малое
 * дело кончится, сановник вернётся к нему сам. Отвлечься можно один раз: с малого дела не отвлекаются.
 */
export function detour(
  city: Pick<City, 'assignments'>,
  args: { id: string; front: Pick<Front, 'id'>; officer: Officer; text?: string; verdict?: Verdict; tempo?: Tempo; day: number },
): Assignment {
  const current = assignmentOf(city, args.officer);
  if (!current) return createAssignment(city, args);
  if (current.returnTo) throw new Error(`сановник ${args.officer.office} уже отвлёкся`);
  current.paused = true;
  args.officer.assignmentId = null;
  const assignment = createAssignment(city, args);
  assignment.returnTo = current.id;
  return assignment;
}

/** Можно ли отвлечь сановника на малое дело: он занят большим и ещё не отвлёкся. */
export function canDetour(city: Pick<City, 'assignments'>, officer: Pick<Officer, 'assignmentId'>): boolean {
  const current = assignmentOf(city, officer);
  return Boolean(current && !current.returnTo);
}

/** Поручение, от которого сановник отвлёкся на это малое дело. */
export function pausedFor(city: Pick<City, 'assignments'>, assignment: Pick<Assignment, 'returnTo'>): Assignment | null {
  return assignment.returnTo ? (city.assignments.find((a) => a.id === assignment.returnTo && a.status === 'active') ?? null) : null;
}

/**
 * Снять сановника с дела. Он снова свободен, а если отвлекался на это дело, возвращается к прежнему:
 * его и возвращает функция, чтобы вызывающий пересчитал скорость того дела.
 */
export function closeAssignment(city: Pick<City, 'officers' | 'assignments'>, assignment: Assignment, day: number): Assignment | null {
  if (assignment.status !== 'active') return null;
  assignment.status = 'ended';
  assignment.endDay = Math.max(0, Math.round(day));
  assignment.paused = false;
  const officer = officerOf(city, assignment);
  if (officer?.assignmentId === assignment.id) officer.assignmentId = null;
  const back = pausedFor(city, assignment);
  if (!back || !officer || officer.assignmentId) return null;
  back.paused = false;
  officer.assignmentId = back.id;
  return back;
}
