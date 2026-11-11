/**
 * Фронт — постепенный процесс к ставке.
 * Прогресс ленивый: хранится вместе с днём пересчёта и скоростью, а день
 * пересечения следующего порога решается одной формулой.
 */

import type { DriftBand, Rules } from '../rules.js';
import type { City, Clue, ConsequenceDraft, Front, FrontEvent, FrontOrigin, Stake } from '../city.js';
import { assignmentRate, activeAssignmentsForFront } from './assignments.js';
import { beatThresholds, driftPerDay } from './scales.js';

const EPS = 1e-9;

export function createFront(
  rules: Rules,
  args: {
    id: string;
    description: string;
    stake: Stake | null;
    effort: number;
    driftBand: DriftBand;
    beatCount: number;
    events?: Array<Pick<FrontEvent, 'id' | 'description'>>;
    clues?: Array<Pick<Clue, 'id' | 'fact' | 'alignment'>>;
    alignment?: string;
    refs?: string[];
    pendingConsequences?: ConsequenceDraft[];
    origin?: FrontOrigin;
    day: number;
  },
): Front {
  const day = Math.max(0, Math.round(args.day));
  return {
    id: args.id,
    origin: args.origin ?? 'story',
    description: args.description.trim(),
    stake: args.stake,
    effort: Math.max(0, args.effort),
    progress: 0,
    progressDay: day,
    driftBand: args.driftBand,
    ratePerDay: driftPerDay(rules, args.driftBand),
    beatCount: Math.max(0, Math.round(args.beatCount)),
    beatsFired: [],
    events: (args.events ?? []).map((e) => ({ id: e.id, description: e.description, status: 'live' as const })),
    clues: (args.clues ?? []).map((c) => ({ id: c.id, fact: c.fact, alignment: c.alignment, status: 'hidden' as const })),
    alignment: (args.alignment ?? '').trim(),
    refs: [...new Set(args.refs ?? [])],
    pendingConsequences: args.pendingConsequences ?? [],
    status: 'active',
    createdDay: day,
    resolvedDay: null,
  };
}

export function progressAt(front: Front, day: number): number {
  const elapsed = Math.max(0, Math.round(day) - front.progressDay);
  const raw = front.progress + front.ratePerDay * elapsed;
  return Math.max(0, Math.min(front.effort, raw));
}

export function settleProgress(front: Front, day: number): number {
  front.progress = progressAt(front, day);
  front.progressDay = Math.max(front.progressDay, Math.round(day));
  return front.progress;
}

/** Пересчитать скорость: дрейф плюс все живые поручения на этот фронт. */
export function recomputeRate(rules: Rules, city: Pick<City, 'assignments' | 'officers' | 'stats'>, front: Front, day: number): number {
  settleProgress(front, day);
  let rate = driftPerDay(rules, front.driftBand);
  for (const a of activeAssignmentsForFront(city, front.id)) rate += assignmentRate(rules, city, a);
  front.ratePerDay = rate;
  return rate;
}

export function pendingThresholds(front: Front): number[] {
  const fired = new Set(front.beatsFired);
  return beatThresholds(front.effort, front.beatCount).filter((_, i) => !fired.has(i));
}

export type FrontEventKind = 'front_beat' | 'front_stake';

/** Ближайшее событие фронта и его день. null — фронт стоит или уже закрыт. */
export function nextFrontEvent(front: Front): { kind: FrontEventKind; day: number } | null {
  if (front.status !== 'active' || !(front.ratePerDay > 0)) return null;
  const beats = pendingThresholds(front).filter((t) => t > front.progress + EPS && t < front.effort);
  const target = beats.length ? Math.min(...beats) : front.effort;
  if (!(target > front.progress + EPS)) {
    // Ставка уже достигнута, но не разыграна.
    return { kind: 'front_stake', day: front.progressDay };
  }
  const days = Math.ceil((target - front.progress) / front.ratePerDay - EPS);
  return { kind: beats.length ? 'front_beat' : 'front_stake', day: front.progressDay + Math.max(0, days) };
}

/** Индекс первого пройденного, но ещё не сработавшего порога. */
export function crossedBeat(front: Front): number | null {
  const thresholds = beatThresholds(front.effort, front.beatCount);
  const fired = new Set(front.beatsFired);
  for (let i = 0; i < thresholds.length; i += 1) {
    if (fired.has(i)) continue;
    if (front.progress + EPS >= (thresholds[i] ?? Infinity)) return i;
  }
  return null;
}

export function stakeReached(front: Front): boolean {
  return front.effort > 0 && front.progress + EPS >= front.effort;
}

export function activeFronts(city: Pick<City, 'fronts'>): Front[] {
  return city.fronts.filter((f) => f.status === 'active');
}

export function findFront(city: Pick<City, 'fronts'>, id: string): Front | null {
  return city.fronts.find((f) => f.id === id) ?? null;
}

/** Доля пройденного для показа игроку: 0..1. */
export function frontShare(front: Front, day: number): number {
  if (front.effort <= 0) return 0;
  return progressAt(front, day) / front.effort;
}
