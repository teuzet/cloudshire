/**
 * Порог фронта. Код решает, что порог пройден, и помечает его сработавшим;
 * какое событие или улику он открывает, выбирает агент (или правило по умолчанию).
 */

import type { Rules } from '../rules.js';
import type { City, Clue, Front, FrontEvent } from '../city.js';
import { accrueEffort, activeAssignmentsForFront, applyBlocks, closeAssignment } from './assignments.js';
import { crossedBeat, settleProgress } from './fronts.js';

export interface BeatPick {
  eventId: string | null;
  clueId: string | null;
}

export interface BeatStart {
  index: number;
  events: FrontEvent[];
  clues: Clue[];
}

/**
 * Довести фронт до дня `day` и открыть пройденный порог.
 * null — порога нет (например, скорость упала и событие уехало).
 */
export function beginBeat(rules: Rules, city: City, front: Front, day: number): BeatStart | null {
  if (front.status !== 'active') return null;
  accrueEffort(rules, city, day);
  applyBlocks(city, front);
  settleProgress(front, day);
  const index = crossedBeat(front);
  if (index == null) return null;
  front.beatsFired.push(index);
  return {
    index,
    events: front.events.filter((e) => e.status !== 'fired'),
    clues: front.clues.filter((c) => c.status === 'hidden'),
  };
}

/** Без агента: первое живое событие, иначе первая скрытая улика. */
export function defaultBeatPick(start: Pick<BeatStart, 'events' | 'clues'>): BeatPick {
  const event = start.events[0];
  if (event) return { eventId: event.id, clueId: null };
  return { eventId: null, clueId: start.clues[0]?.id ?? null };
}

export interface BeatOutcome {
  event: FrontEvent | null;
  clue: Clue | null;
  /** Событие выпало, но было заблокировано: ущерба нет. */
  averted: boolean;
  /** Сухой факт для хрониста. */
  fact: string;
}

export function applyBeatPick(front: Front, pick: BeatPick): BeatOutcome {
  let event: FrontEvent | null = null;
  let clue: Clue | null = null;
  let averted = false;
  if (pick.eventId) {
    event = front.events.find((e) => e.id === pick.eventId) ?? null;
    if (event) {
      averted = event.status === 'blocked';
      event.status = 'fired';
    }
  } else if (pick.clueId) {
    clue = front.clues.find((c) => c.id === pick.clueId) ?? null;
    if (clue) clue.status = 'revealed';
  }
  const fact = clue
    ? clue.fact
    : event
      ? averted
        ? `Подготовка сдержала удар: ${event.description}`
        : event.description
      : front.description;
  return { event, clue, averted, fact };
}

/** После содержательного результата закрыть поручения «до следующего результата». */
export function closeNextResultAssignments(city: City, front: Front, day: number): string[] {
  const closed: string[] = [];
  for (const a of activeAssignmentsForFront(city, front.id)) {
    if (a.stopWhen === 'next_result') {
      closeAssignment(city, a.id, day, 'done');
      closed.push(a.id);
    }
  }
  return closed;
}
