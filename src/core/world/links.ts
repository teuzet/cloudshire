/**
 * Связи между объектами и фронтами, последствия которых код разносит сам.
 *
 *   живёт на — фронт живёт на объекте: объект исчез или выбыл, фронт кончился без ставки;
 *   держит   — объект держит фронт, пока цел: объект исчез или выбыл, фронт идёт как прежде.
 *
 * Волна конечна: она идёт от объекта к фронтам и от фронта к его дочерним фронтам, кругов тут нет.
 */

import type { City, Front, FrontLink, HoldSpec, WorldObject } from '../city.js';
import type { Rules } from '../rules.js';
import { HELD_WORDS, type Change } from './changes.js';
import { activeFronts, closeFront, findFront, frontGist, progressAt, recomputeRate } from './fronts.js';
import { applyHold, liftHold, ownMotion } from './hold.js';
import { findObject } from './objects.js';

/**
 * Что изменится, когда дело будет готово, по одной фразе на влияние. `name` — имя результата.
 * Влияния на то, чего уже нет, пропущены.
 */
export function linkLines(city: Pick<City, 'fronts'>, links: readonly FrontLink[], name: string): string[] {
  const lines: string[] = [];
  for (const link of links) {
    const front = findFront(city, link.frontId);
    if (!front || front.status !== 'active') continue;
    const gist = frontGist(front);
    if (link.effect === 'removes') lines.push(front.plus ? `пропадёт случай: «${gist}»` : `больше не будет: «${gist}»`);
    else {
      const words = HELD_WORDS[ownMotion(front)][link.effect](gist, name);
      lines.push(`${words.charAt(0).toLowerCase()}${words.slice(1)}${link.word ? ' (держится на слове)' : ''}`);
    }
  }
  return lines;
}

/** Имя того, чем кончится дело: новый объект или тот, что оно меняет. */
export function resultName(city: Pick<City, 'objects'>, front: Pick<Front, 'stake'>): string | null {
  for (const op of front.stake) {
    if (op.op === 'create' && op.result) return op.object.name;
  }
  for (const op of front.stake) {
    if (op.op === 'hold' || op.op === 'revalue') return findObject(city, op.target)?.name ?? null;
  }
  return null;
}

/**
 * Окрестность объекта словами: где он находится, что находится на нём, что он держит и что на нём
 * держится. Это видят агенты, чтобы «сбить цепи» могло прийти в голову и жрецу, и беде по соседству.
 * Скрытое названо только тем, кому `seeHidden` разрешает его видеть. Без `events` названо только место.
 */
export function nearWords(city: Pick<City, 'fronts' | 'objects'>, obj: Pick<WorldObject, 'id' | 'parentId' | 'holds'>, seeHidden = false, events = true): string {
  const seen = (o: WorldObject | undefined | null): o is WorldObject => Boolean(o && o.status === 'active' && (seeHidden || !o.hidden));
  const parts: string[] = [];
  const parent = obj.parentId ? findObject(city, obj.parentId) : null;
  if (seen(parent)) parts.push(`Находится здесь: ${parent.name}.`);
  const inside = city.objects.filter((o) => o.parentId === obj.id && !o.temporary && seen(o)).map((o) => o.name);
  if (inside.length) parts.push(`Здесь находится: ${inside.join(', ')}.`);
  // Тому, кто судит о мире, а не о событиях, хватает места: идущее рядом приказ как раз и меняет.
  if (!events) return parts.join(' ');
  for (const hold of obj.holds ?? []) {
    const front = findFront(city, hold.frontId);
    if (front && front.status === 'active') parts.push(`${HELD_WORDS[ownMotion(front)][hold.effect](frontGist(front), 'это')}.`);
  }
  const living = activeFronts(city)
    .filter((f) => f.livesOn === obj.id)
    .map((f) => `«${frontGist(f)}»`);
  if (living.length) parts.push(`На этом держится: ${living.join('; ')}.`);
  return parts.join(' ');
}

/**
 * Сколько работы стоит убрать объект вместе с бедами, которые на нём живут: убрать причину
 * беды стоит столько же, сколько снять саму беду, то есть остаток её шкалы.
 */
export function carriedWork(city: Pick<City, 'fronts' | 'objects'>, obj: Pick<WorldObject, 'id'>, day: number): number {
  let sum = 0;
  for (const front of frontsOn(city, obj)) {
    if (ownMotion(front) !== 'clock' || front.capacity <= 0) continue;
    sum += Math.max(0, front.capacity - progressAt(front, day));
  }
  return Math.round(sum * 100) / 100;
}

/** Фронты, которые живут на объекте или на вложенном в него: с его уходом они кончатся. */
export function frontsOn(city: Pick<City, 'fronts' | 'objects'>, obj: Pick<WorldObject, 'id'>): Front[] {
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
  return activeFronts(city).filter((f) => f.livesOn != null && ids.has(f.livesOn));
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
