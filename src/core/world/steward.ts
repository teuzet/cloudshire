/**
 * Наказ жрецу: что делать с бедой, на которую покровитель не ответил. Покровитель задаёт наказ
 * словами, жрец переводит их в режим и срок ожидания. Решает код: какая беда, кто из свободных
 * сановников и каким из здравых способов. Модель здесь не нужна.
 */

import type { City, Front, Officer, StewardOrder } from '../city.js';
import { STEWARD_WAITS, type Rules, type StewardWait } from '../rules.js';
import { leadOf } from './assignments.js';
import { officerFit } from './numbers.js';

export function stewardOrder(rules: Rules, city: Pick<City, 'steward'>): StewardOrder {
  return city.steward ?? { mode: rules.fronts.steward.mode, wait: rules.fronts.steward.wait, spare: [], text: '' };
}

export function isStewardWait(value: string): value is StewardWait {
  return (STEWARD_WAITS as readonly string[]).includes(value);
}

/** Беды без ведущего, самая срочная первой. */
export function unattendedTroubles(city: Pick<City, 'fronts' | 'assignments'>): Front[] {
  return city.fronts
    .filter((f) => f.status === 'active' && !f.plus && (f.form === 'threat' || f.form === 'tension') && f.origin !== 'player' && f.capacity > 0 && !leadOf(city, f.id))
    .sort((a, b) => (a.deadlineDay ?? Infinity) - (b.deadlineDay ?? Infinity) || a.createdDay - b.createdDay);
}

export interface StewardPick {
  front: Front;
  officer: Officer;
  /** Способ, которым сановник берётся за беду. */
  move: string;
}

/** Кого и на какую беду жрец поставит сам в этот день; null — ждать или некого. */
export function stewardPick(rules: Rules, city: Pick<City, 'fronts' | 'assignments' | 'officers' | 'stats' | 'steward'>, day: number): StewardPick | null {
  const order = stewardOrder(rules, city);
  if (order.mode === 'report') return null;
  const wait = order.mode === 'act' ? 0 : rules.fronts.steward.waitDays[order.wait];
  const free = city.officers.filter((o) => !o.assignmentId && !order.spare.includes(o.office));
  if (!free.length) return null;
  const front = unattendedTroubles(city).find((f) => f.createdDay + wait <= day);
  if (!front) return null;
  const officer = [...free].sort((a, b) => officerFit(rules, city, b, front.profile) - officerFit(rules, city, a, front.profile))[0]!;
  const move = front.key?.moves?.[0] ?? front.description;
  return { front, officer, move };
}
