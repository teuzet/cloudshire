/**
 * Бесшовный мир: история не кончается точкой, она оставляет узел, из которого растёт следующая.
 * Узел с прошлым — якорь, то, что спит под ним, ушедшая сторона. Он ждёт, пока посев не возьмёт
 * его в новую историю. Стороны помнят, что покровитель сделал им во вред и на пользу.
 */

import type { City, Front, WorldObject } from '../city.js';
import type { Rules } from '../rules.js';
import type { Change } from './changes.js';
import { findFront, frontGist, frontTouches } from './fronts.js';
import { isAsleep } from './hold.js';
import { findObject, isDeparted } from './objects.js';

/** Объект виден городу и стоит в нём. */
const standing = (o: WorldObject | null | undefined): o is WorldObject => Boolean(o && o.status === 'active' && !o.hidden && !o.temporary && !o.out);

/**
 * Узлы с прошлым, которые ещё не сыграли снова: id — день, с которого это узел.
 * Якорь (кроме найденного на время дела) держит идущее; то, что спит под якорем, ждёт, когда он
 * падёт; ушедшая сторона может вернуться. Объект, который посев уже взял после этого дня, не ждёт.
 */
export function nodesWithPast(city: Pick<City, 'objects' | 'fronts'>): Map<string, number> {
  const out = new Map<string, number>();
  const note = (id: string, day: number) => out.set(id, Math.max(out.get(id) ?? Number.NEGATIVE_INFINITY, day));
  for (const anchor of city.objects) {
    if (!standing(anchor)) continue;
    for (const hold of anchor.holds ?? []) {
      const front = hold.found ? null : findFront(city, hold.frontId);
      if (!front || front.status !== 'active') continue;
      note(anchor.id, hold.day);
      if (!isAsleep(front)) continue;
      for (const id of [...frontTouches(city, front), ...(front.livesOn ? [front.livesOn] : [])]) if (standing(findObject(city, id))) note(id, hold.day);
    }
  }
  for (const o of city.objects) if (isDeparted(o)) note(o.id, o.out!.day);
  for (const [id, day] of out) {
    const played = findObject(city, id)?.playedDay;
    if (played != null && played >= day) out.delete(id);
  }
  return out;
}

/** Узлы по свежести, для посева: сначала то, что стало узлом недавно. */
export function nodeObjects(city: Pick<City, 'objects' | 'fronts'>): WorldObject[] {
  return [...nodesWithPast(city)]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => findObject(city, id))
    .filter((o): o is WorldObject => Boolean(o));
}

/** Готовое дело ложится в память сторон, которым оно во вред или на пользу. */
export function rememberSides(rules: Rules, city: Pick<City, 'objects'>, front: Front, day: number): void {
  const deed = frontGist(front);
  for (const side of front.sides ?? []) {
    const obj = findObject(city, side.objectId);
    if (!obj || obj.hidden) continue;
    const log = (obj.log ??= []);
    log.push({ day, text: `По воле покровителя сделано: ${deed}. ${side.stance === 'harms' ? 'Им это во вред' : 'Им это на пользу'}.` });
    if (log.length > rules.fronts.objects.logMax) log.splice(0, log.length - rules.fronts.objects.logMax);
  }
}

/** Ушедшая сторона возвращается с новой историей: снова в городе, а помнит всё, что было. */
export function bringBack(city: Pick<City, 'objects'>, obj: WorldObject, day: number): Change[] {
  if (!isDeparted(obj)) return [];
  obj.status = 'active';
  obj.deletedDay = null;
  obj.out = null;
  obj.freshDay = day;
  // Того, в чём сторона была, может уже не быть: тогда она просто в городе.
  if (obj.parentId && findObject(city, obj.parentId)?.status !== 'active') obj.parentId = null;
  return [{ kind: 'object_back', objectId: obj.id, name: obj.name, delta: { prosperity: 0, security: 0, knowledge: 0, influence: 0 }, description: null }];
}
