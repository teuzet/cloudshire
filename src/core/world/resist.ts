/**
 * Сопротивление стороны: правка вредит тому, у кого есть воля, и он стоит на месте работ.
 * Платы работой за это нет: расплата идёт через риск самого дела. Риск выше на одну ступень,
 * но не выше «рискованно»; осложнение от противника бьёт по самому делу (запись словаря с ролью
 * «противник»). Способ работы может снять сопротивление: тогда ступень возвращается.
 */

import type { City, Front, Resist } from '../city.js';
import { RISK_STEPS, type ObjectType } from '../rules.js';
import { withOuter } from './fronts.js';
import { findObject } from './objects.js';

const RISKY = RISK_STEPS.indexOf('risky');

/** У кого есть своя воля: такие стороны могут выиграть или потерять от правки. */
export const WILLED: readonly ObjectType[] = ['community', 'organization', 'person', 'threat'];

/**
 * Стоит ли сторона на месте работ: она сама в отпечатке или среди объектов правки, либо стоит на том же
 * носителе, что и они (в том же, во что они вложены, или в них самих).
 */
export function onSite(city: Pick<City, 'objects'>, sideId: string, objectIds: readonly string[]): boolean {
  const side = findObject(city, sideId);
  if (!side || side.status !== 'active' || side.out || side.temporary || !WILLED.includes(side.type)) return false;
  const here = withOuter(city, objectIds);
  for (const id of withOuter(city, [side.id])) if (here.has(id)) return true;
  return false;
}

/**
 * Записать, кто сопротивляется делу, и сдвинуть риск. Ступень поднимается один раз, пока есть
 * хотя бы один противник, с которым способ работы не справляется, и возвращается, когда таких нет.
 */
export function setResistance(front: Front, resist: readonly Resist[]): void {
  if (resist.length) front.resist = resist.map((r) => ({ ...r }));
  else delete front.resist;
  const applied = front.resistShift ?? 0;
  const wanted = resist.some((r) => !r.answered) ? 1 : 0;
  const rank = RISK_STEPS.indexOf(front.risk);
  if (wanted && !applied && rank < RISKY) {
    front.risk = RISK_STEPS[rank + 1]!;
    front.resistShift = 1;
  } else if (!wanted && applied) {
    // Дело, ставшее затеей против здравого смысла, сопротивление назад не тянет.
    if (rank <= RISKY) front.risk = RISK_STEPS[Math.max(0, rank - applied)]!;
    delete front.resistShift;
  }
}

/** Риск оценили заново: прибавка от сопротивления ставится поверх новой оценки. */
export function reapplyResistance(front: Front): void {
  delete front.resistShift;
  setResistance(front, front.resist ?? []);
}

/** Противники дела, с которыми способ работы не справляется, и они ещё в строю. */
export function opponentsOf(city: Pick<City, 'objects'>, front: Pick<Front, 'resist'>) {
  return (front.resist ?? [])
    .filter((r) => !r.answered)
    .map((r) => findObject(city, r.objectId))
    .filter((o): o is NonNullable<typeof o> => Boolean(o && o.status === 'active' && !o.out));
}
