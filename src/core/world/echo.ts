/**
 * Кого задевает перемена: эхо по связям объектов и обновление идущих дел.
 * Здесь только поиск по графу. Что стало с задетым, решают агенты в потоке.
 */

import type { Rules } from '../rules.js';
import type { City, Front, WorldObject } from '../city.js';
import type { Rng } from '../random.js';
import { weightedOrder } from './dynamics.js';
import { activeFronts, frontObjectIds } from './fronts.js';
import { findObject, linkedObjects } from './objects.js';

/**
 * Объекты, по которым пойдёт эхо: связанные с изменившимися, не больше `echo.maxPerChange`.
 * Объект, на котором уже висит фронт эха, пропускается: волна идёт по шагу за раз.
 */
export function echoTargets(rules: Rules, city: City, changedIds: readonly string[], rng: Rng): Array<{ target: WorldObject; source: WorldObject }> {
  const changed = new Set(changedIds);
  const busy = new Set(activeFronts(city).filter((f) => f.origin === 'echo').flatMap((f) => f.refs));
  const found = new Map<string, { target: WorldObject; source: WorldObject }>();
  for (const id of changedIds) {
    const source = findObject(city, id);
    if (!source) continue;
    for (const near of linkedObjects(city, source)) {
      if (changed.has(near.id) || busy.has(near.id) || near.hidden || near.temporary || found.has(near.id)) continue;
      found.set(near.id, { target: near, source });
    }
  }
  return weightedOrder([...found.values()], () => 1, rng).slice(0, rules.fronts.echo.maxPerChange);
}

/** Идущие дела, которых касается перемена. Сами источники перемены не обновляются. */
export function refreshTargets(rules: Rules, city: City, changedIds: readonly string[], exceptFrontIds: readonly string[]): Front[] {
  const changed = new Set(changedIds);
  const except = new Set(exceptFrontIds);
  return activeFronts(city)
    .filter((f) => !except.has(f.id) && f.form !== 'clock' && frontObjectIds(f).some((id) => changed.has(id)))
    .slice(0, rules.fronts.refresh.maxFronts);
}
