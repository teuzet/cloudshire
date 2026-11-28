/**
 * Якоря: постоянный объект держит фронт, пока цел и в строю.
 *
 * Что якорь держит, зависит от того, что двигает фронт. Беда и часы идут к сроку сами:
 * якорь останавливает, замедляет или торопит срок. Дело и поиск двигает работа: якорь
 * останавливает работу, отнимает или прибавляет её. Риск якорь меняет у дела, исход у любого фронта.
 *
 * Якорь не изнашивается. Объект исчез или выбыл — всё, что он держал, идёт как прежде,
 * а срок продолжается с того места, где встал.
 */

import type { City, Front, Hold, HoldSpec, WorldObject } from '../city.js';
import { RISK_STEPS, type HoldEffect, type Rules } from '../rules.js';

const EPS = 1e-9;
const RISKY = RISK_STEPS.indexOf('risky');

/** Что двигает фронт: беда и часы идут к сроку сами, дело и поиск двигает работа. */
export function ownMotion(front: Pick<Front, 'form'>): 'clock' | 'work' {
  return front.form === 'deed' || front.form === 'find' ? 'work' : 'clock';
}

/** Объект в строю: цел и не выбыл. Только такой держит. */
export function standing(obj: Pick<WorldObject, 'status' | 'out'>): boolean {
  return obj.status === 'active' && !obj.out;
}

export interface Holder {
  obj: WorldObject;
  hold: Hold;
}

/** Якоря фронта: объекты в строю, которые его держат. */
export function holdersOf(city: Pick<City, 'objects'>, frontId: string): Holder[] {
  const out: Holder[] = [];
  for (const obj of city.objects) {
    if (!obj.holds?.length || !standing(obj)) continue;
    for (const hold of obj.holds) if (hold.frontId === frontId) out.push({ obj, hold });
  }
  return out;
}

/** Фронт остановлен якорем: срока нет, пока якорь цел. */
export function isAsleep(front: Pick<Front, 'sleepLeft'>): boolean {
  return front.sleepLeft != null;
}

// ───────────────────────────── срок ─────────────────────────────

/** Во сколько раз быстрее обычного беда идёт к сроку под своими якорями. Ноль — стоит. */
export function clockRateOf(rules: Rules, city: Pick<City, 'objects'>, front: Pick<Front, 'id' | 'form'>): number {
  if (ownMotion(front) !== 'clock') return 1;
  let rate = 1;
  for (const { hold } of holdersOf(city, front.id)) {
    if (hold.effect === 'stop') return 0;
    if (hold.effect === 'slow') rate *= rules.fronts.hold.slowFactor;
    if (hold.effect === 'hurry') rate *= rules.fronts.hold.hurryFactor;
  }
  return rate;
}

/** Завести срок: `left` дней обычного хода от дня `day`, с поправкой на якоря фронта. */
export function setClock(front: Front, day: number, left: number): void {
  const rate = front.clockRate ?? 1;
  if (rate <= 0) {
    front.sleepLeft = Math.max(0, left);
    front.deadlineDay = null;
    return;
  }
  front.sleepLeft = null;
  front.deadlineDay = Math.round(day) + Math.max(0, Math.ceil(left / rate - EPS));
}

/**
 * Переставить срок под нынешние якоря. Прошедшее время засчитано по прежнему ходу,
 * оставшееся пойдёт по новому. Пока якоря не менялись, ничего не делает.
 */
export function retime(rules: Rules, city: Pick<City, 'objects'>, front: Front, day: number): boolean {
  const before = front.clockRate ?? 1;
  const rate = clockRateOf(rules, city, front);
  if (rate === before) return false;
  const left = front.sleepLeft != null ? front.sleepLeft : front.deadlineDay != null ? Math.max(0, front.deadlineDay - day) * before : null;
  front.clockRate = rate;
  if (left == null) return false;
  setClock(front, day, left);
  return true;
}

// ───────────────────────────── работа ─────────────────────────────

/** Что якоря делают с работой над делом: стоит ли она и сколько единиц в месяц прибавлено или отнято. */
/**
 * Что якоря делают с работой: стоит ли она и сколько единиц в месяц прибавляют или отнимают.
 * Найденное на старте дела (`found`) считается отдельно: у него общий потолок от работы ведущего.
 */
export function workHold(rules: Rules, city: Pick<City, 'objects'>, front: Pick<Front, 'id' | 'form'>): { stopped: boolean; unitsPerMonth: number; foundUnits: number } {
  if (ownMotion(front) !== 'work') return { stopped: false, unitsPerMonth: 0, foundUnits: 0 };
  let stopped = false;
  let units = 0;
  let found = 0;
  for (const { hold } of holdersOf(city, front.id)) {
    if (hold.effect === 'stop') stopped = true;
    const step = hold.effect === 'slow' ? -rules.fronts.hold.unitsPerMonth : hold.effect === 'hurry' ? rules.fronts.hold.unitsPerMonth : 0;
    if (hold.found) found += step;
    else units += step;
  }
  return { stopped, unitsPerMonth: units, foundUnits: found };
}

// ───────────────────────────── поставить и снять ─────────────────────────────

/** Как якорь может держать этот фронт. null — такому фронту этот якорь ничего не даёт. */
export function feasibleHold(city: Pick<City, 'objects'>, front: Front, spec: Pick<HoldSpec, 'effect' | 'stake' | 'failStake'>): HoldEffect | null {
  const effect = spec.effect;
  const work = ownMotion(front) === 'work';
  const rank = RISK_STEPS.indexOf(front.risk);
  switch (effect) {
    case 'stop':
    case 'slow':
    case 'hurry':
      return work || front.deadlineDay != null || front.sleepLeft != null ? effect : null;
    case 'riskier':
      return work && rank < RISKY ? effect : null;
    case 'safer':
      return work && rank > 0 && rank <= RISKY ? effect : null;
    case 'outcome':
      if (!spec.stake && !spec.failStake) return null;
      return holdersOf(city, front.id).some((h) => h.hold.effect === 'outcome') ? null : effect;
  }
}

/** Объект начинает держать фронт. null — якорь не встал: объект не в строю, фронту он ничего не даёт или уже держит так же. */
export function applyHold(rules: Rules, city: Pick<City, 'objects'>, front: Front, obj: WorldObject, spec: HoldSpec, day: number): Hold | null {
  if (front.status !== 'active' || !standing(obj)) return null;
  const effect = feasibleHold(city, front, spec);
  if (!effect) return null;
  if (obj.holds?.some((h) => h.frontId === front.id && h.effect === effect)) return null;
  const hold: Hold = { frontId: front.id, effect, day: Math.max(0, Math.round(day)) };
  if (spec.word) hold.word = true;
  if (spec.found) hold.found = true;
  if (effect === 'riskier' || effect === 'safer') {
    const rank = RISK_STEPS.indexOf(front.risk);
    const next = effect === 'riskier' ? Math.min(rank + 1, RISKY) : Math.max(rank - 1, 0);
    hold.riskShift = next - rank;
    front.risk = RISK_STEPS[next]!;
  }
  if (effect === 'outcome') {
    hold.saved = { stake: front.stake, failStake: front.failStake };
    if (spec.stake) front.stake = spec.stake;
    if (spec.failStake) front.failStake = spec.failStake;
  }
  (obj.holds ??= []).push(hold);
  retime(rules, city, front, day);
  return hold;
}

/** Якорь пал: снять его с объекта и вернуть фронту прежний ход. */
export function liftHold(rules: Rules, city: Pick<City, 'objects'>, front: Front | null, obj: WorldObject, hold: Hold, day: number): void {
  obj.holds = (obj.holds ?? []).filter((h) => h !== hold);
  if (!front || front.status !== 'active') return;
  if (hold.riskShift) {
    const rank = RISK_STEPS.indexOf(front.risk);
    // Дело, ставшее за это время затеей против здравого смысла, якорь назад не тянет.
    if (rank <= RISKY) front.risk = RISK_STEPS[Math.max(0, Math.min(RISKY, rank - hold.riskShift))]!;
  }
  if (hold.saved) {
    front.stake = hold.saved.stake;
    front.failStake = hold.saved.failStake;
  }
  retime(rules, city, front, day);
}

/** Фронт закрыт: держать больше нечего. */
export function dropHoldsOn(city: Pick<City, 'objects'>, frontId: string): void {
  for (const obj of city.objects) {
    if (obj.holds?.some((h) => h.frontId === frontId)) obj.holds = obj.holds.filter((h) => h.frontId !== frontId);
  }
}
