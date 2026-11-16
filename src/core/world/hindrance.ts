/**
 * Помехи на деле. Помеха бьёт по делу одним из четырёх способов: замедляет работу,
 * съедает срок, делает работу опаснее или портит готовое. Ведущий может справиться
 * с ней словом приказа: если нынешний способ работы с помехой справляется, она обойдена
 * и этому делу больше не мешает. Убрать её из мира — отдельное дело.
 */
import type { City, Front, WorldObject } from '../city.js';
import { RISK_STEPS, type HindranceEffect, type Rules } from '../rules.js';
import { attachedTo } from './objects.js';

/** Помехи на деле: объекты с отрицательной привязкой. */
export function hindrancesOf(city: Pick<City, 'objects'>, frontId: string): WorldObject[] {
  return attachedTo(city, frontId).filter((o) => (o.attach?.rate ?? 0) < 0);
}

/** Чем помеха бьёт сейчас. Срок без срока и риск на краю лестницы сводятся к замедлению. */
export function effectOf(obj: WorldObject): HindranceEffect {
  return obj.attach?.effect ?? 'pace';
}

/** Помеха действует: не обойдена. */
export function biting(obj: WorldObject): boolean {
  return (obj.attach?.rate ?? 0) < 0 && !obj.attach?.answered;
}

/** Скорость, которую помеха отнимает у дела: только у помехи-замедления, пока её не обошли. */
export function paceOf(obj: WorldObject): number {
  const a = obj.attach;
  if (!a) return 0;
  if (a.rate > 0) return a.rate;
  return biting(obj) && effectOf(obj) === 'pace' ? a.rate : 0;
}

/** Выбрать удар, который у этого дела вообще возможен. */
export function feasibleEffect(front: Pick<Front, 'deadlineDay' | 'risk'>, effect: HindranceEffect | undefined): HindranceEffect {
  if (effect === 'deadline' && front.deadlineDay == null) return 'pace';
  if (effect === 'risk' && RISK_STEPS.indexOf(front.risk) >= RISK_STEPS.indexOf('risky')) return 'pace';
  return effect ?? 'pace';
}

/** Наложить удар помехи на дело. Повторный вызов ничего не меняет. */
export function applyHindrance(rules: Rules, front: Front, obj: WorldObject, day: number): void {
  const a = obj.attach;
  if (!a || a.rate >= 0 || a.answered) return;
  const effect = effectOf(obj);
  if (effect === 'deadline' && front.deadlineDay != null && !a.shift) {
    const left = Math.max(0, front.deadlineDay - day);
    a.shift = Math.round(left * rules.fronts.hindrance.deadlineShare);
    front.deadlineDay -= a.shift;
  }
  if (effect === 'risk' && !a.riskBefore) {
    a.riskBefore = front.risk;
    front.risk = RISK_STEPS[Math.min(RISK_STEPS.indexOf(front.risk) + 1, RISK_STEPS.indexOf('risky'))]!;
  }
}

/** Снять удар помехи с дела: её обошли или убрали. */
export function liftHindrance(front: Front | null, obj: WorldObject): void {
  const a = obj.attach;
  if (!a) return;
  if (front && a.shift && front.deadlineDay != null) front.deadlineDay += a.shift;
  if (front && a.riskBefore) front.risk = a.riskBefore;
  a.shift = 0;
  delete a.riskBefore;
}

/** Нынешний способ работы справляется с помехой или перестал справляться. */
export function setAnswered(rules: Rules, front: Front, obj: WorldObject, answered: boolean, day: number): boolean {
  const a = obj.attach;
  if (!a || a.rate >= 0 || Boolean(a.answered) === answered) return false;
  if (answered) {
    liftHindrance(front, obj);
    a.answered = true;
  } else {
    a.answered = false;
    applyHindrance(rules, front, obj, day);
  }
  return true;
}

/** Как удар помехи виден в городе: словами мира, для жреца и рассказчиков. */
export const EFFECT_WORDS: Record<HindranceEffect, string> = {
  pace: 'работа идёт медленнее',
  deadline: 'времени до срока стало меньше',
  risk: 'на работах стало опаснее',
  outcome: 'готовое выйдет хуже задуманного',
};
