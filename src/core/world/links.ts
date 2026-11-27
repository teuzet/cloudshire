/**
 * Связи между объектами и фронтами, последствия которых код разносит сам.
 *
 *   живёт на — фронт живёт на объекте: объект исчез или выбыл, фронт кончился без ставки;
 *   держит   — объект держит фронт, пока цел: объект исчез или выбыл, фронт идёт как прежде.
 *
 * Волна конечна: она идёт от объекта к фронтам и от фронта к его дочерним фронтам, кругов тут нет.
 */

import type { City, HoldSpec, WorldObject } from '../city.js';
import type { Rules } from '../rules.js';
import type { Change } from './changes.js';
import { activeFronts, closeFront, findFront, frontGist, progressAt, recomputeRate } from './fronts.js';
import { applyHold, liftHold, ownMotion } from './hold.js';

/**
 * Сколько работы стоит убрать объект вместе с бедами, которые на нём живут: убрать причину
 * беды стоит столько же, сколько снять саму беду, то есть остаток её шкалы.
 */
export function carriedWork(city: Pick<City, 'fronts' | 'objects'>, obj: Pick<WorldObject, 'id'>, day: number): number {
  const ids = new Set<string>([obj.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of city.objects) {
      if (o.status === 'active' && o.parentId && ids.has(o.parentId) && !ids.has(o.id)) {
        ids.add(o.id);
        grew = true;
      }
    }
  }
  let sum = 0;
  for (const front of activeFronts(city)) {
    if (!front.livesOn || !ids.has(front.livesOn) || ownMotion(front) !== 'clock' || front.capacity <= 0) continue;
    sum += Math.max(0, front.capacity - progressAt(front, day));
  }
  return Math.round(sum * 100) / 100;
}

/** Объект начинает держать фронт. Пусто — якорь не встал. */
export function holdFront(rules: Rules, city: City, obj: WorldObject, spec: HoldSpec, day: number): Change[] {
  const front = findFront(city, spec.frontId);
  if (!front || front.status !== 'active') return [];
  const hold = applyHold(rules, city, front, obj, spec, day);
  if (!hold) return [];
  recomputeRate(rules, city, front, day);
  return [{ kind: 'front_held', frontId: front.id, title: frontGist(front), objectId: obj.id, name: obj.name, effect: hold.effect, motion: ownMotion(front) }];
}

/**
 * Объекты исчезли или выбыли. Всё, что они держали, идёт как прежде; фронты, которые на них
 * жили, кончаются без ставки: беда уходит вместе с носителем, дело и поиск обрываются.
 */
export function objectsGone(rules: Rules, city: City, gone: readonly WorldObject[], day: number): Change[] {
  const changes: Change[] = [];
  for (const obj of gone) {
    for (const hold of [...(obj.holds ?? [])]) {
      const front = findFront(city, hold.frontId);
      liftHold(rules, city, front, obj, hold, day);
      if (!front || front.status !== 'active') continue;
      recomputeRate(rules, city, front, day);
      changes.push({ kind: 'front_freed', frontId: front.id, title: frontGist(front), objectId: obj.id, name: obj.name, effect: hold.effect, motion: ownMotion(front) });
    }
  }
  const names = new Map(gone.map((o) => [o.id, o.name]));
  for (const front of activeFronts(city)) {
    // Фронт мог закрыться вместе с родителем, пока шла волна.
    if (front.status !== 'active' || !front.livesOn || !names.has(front.livesOn)) continue;
    // Удобный случай упущен, дело и поиск оборвались, беда отпала сама: держаться им больше не на чем.
    const outcome = front.plus ? 'expired' : ownMotion(front) === 'work' ? 'cut' : 'gone';
    changes.push(...closeFront(rules, city, front, 'cancelled', day, { outcome, cause: names.get(front.livesOn) }));
  }
  return changes;
}
