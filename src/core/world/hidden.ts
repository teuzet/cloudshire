/**
 * Неузнанное: что о фронте или объекте в мире действительно скрыто. Улика посаженной истории,
 * скрытый участник (носитель, тот, кто держит, сторона, вложенное). Код исполняет скрытое всегда;
 * знание только даёт игроку назвать его в приказе.
 */

import type { City, Front, WorldObject } from '../city.js';
import { activeFronts, findFront, frontTouches } from './fronts.js';
import { findObject } from './objects.js';
import { withNested } from './patch.js';

export type HiddenItem = { kind: 'clue'; frontId: string; clueId: string; fact: string } | { kind: 'object'; objectId: string };

/** О чём спрашивают: дело, часть города или оба. */
export interface HiddenAbout {
  frontId: string | null;
  objectId: string | null;
}

/**
 * Что ещё скрыто: сначала улики по порядку, потом участники. Пусто — узнавать нечего.
 * Того, кого открывает успех идущего дела (приз поиска), здесь нет: его откроет только само дело.
 */
export function hiddenAbout(city: Pick<City, 'fronts' | 'objects'>, about: HiddenAbout): HiddenItem[] {
  const prizes = new Set(prizesOf(city).keys());
  return scope(city, about).filter((h) => h.kind !== 'object' || !prizes.has(h.objectId));
}

/** Есть ли здесь неузнанное вообще, вместе с призом дела: жрец знает, что знает не всё. */
export function anyHidden(city: Pick<City, 'fronts' | 'objects'>, about: HiddenAbout): boolean {
  return scope(city, about).length > 0;
}

/** Дела, чей успех откроет скрытое в этом круге: остальное узнать можно, только доведя их до конца. */
export function prizeFronts(city: Pick<City, 'fronts' | 'objects'>, about: HiddenAbout): Front[] {
  const prizes = prizesOf(city);
  const ids = new Set(scope(city, about).flatMap((h) => (h.kind === 'object' ? (prizes.get(h.objectId) ?? []) : [])));
  return activeFronts(city).filter((f) => ids.has(f.id));
}

/** Скрытое, которое открывает ставка успеха идущих дел: id объекта — дела. */
function prizesOf(city: Pick<City, 'fronts'>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of activeFronts(city)) {
    for (const op of f.stake) if (op.op === 'reveal') out.set(op.target, [...(out.get(op.target) ?? []), f.id]);
  }
  return out;
}

function scope(city: Pick<City, 'fronts' | 'objects'>, about: HiddenAbout): HiddenItem[] {
  const fronts: Front[] = [];
  const front = about.frontId ? findFront(city, about.frontId) : null;
  if (front && front.status === 'active') fronts.push(front);
  const obj = about.objectId ? findObject(city, about.objectId) : null;
  const place = obj && obj.status === 'active' ? withNested(city, [obj.id]) : new Set<string>();
  // То, что живёт на объекте или касается его и вложенного в него, тоже «о нём».
  for (const f of activeFronts(city)) if (!fronts.includes(f) && frontTouches(city, f).some((id) => place.has(id))) fronts.push(f);

  const clues: HiddenItem[] = fronts.flatMap((f) => (f.script?.clues ?? []).filter((c) => !c.revealed).map((c) => ({ kind: 'clue' as const, frontId: f.id, clueId: c.id, fact: c.fact })));
  const ids = new Set<string>();
  // Участники фронта: носитель и то, что на нём находится, те, кто в фронте замешан или под ударом
  // его ставки, те, кто его держит.
  for (const f of fronts) {
    for (const id of frontTouches(city, f)) ids.add(id);
    if (f.livesOn) for (const id of withNested(city, [f.livesOn])) ids.add(id);
  }
  for (const id of place) ids.add(id);
  if (obj) ids.delete(obj.id);
  const objects: HiddenItem[] = [...ids]
    .map((id) => findObject(city, id))
    .filter((o): o is WorldObject => Boolean(o && o.status === 'active' && o.hidden && !o.temporary))
    .map((o) => ({ kind: 'object' as const, objectId: o.id }));
  return [...clues, ...objects];
}
