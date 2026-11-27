/**
 * Кого задевает перемена: какие идущие дела надо обновить.
 * Здесь только поиск по графу. Что стало с задетым, решают агенты в потоке.
 */

import type { Rules } from '../rules.js';
import type { City, Front } from '../city.js';
import { activeFronts, findFront, frontObjectIds, neighbors } from './fronts.js';

/**
 * Идущие дела, которых касается перемена. Сами источники перемены не обновляются.
 * Перемена бывает двух видов: изменился объект (задеты фронты, которые его касаются)
 * или изменились условия фронта (задеты он сам и его соседи).
 */
export function refreshTargets(
  rules: Rules,
  city: City,
  changedIds: readonly string[],
  exceptFrontIds: readonly string[],
  changedFrontIds: readonly string[] = [],
): Front[] {
  const changed = new Set(changedIds);
  const except = new Set(exceptFrontIds);
  const near = new Set<string>();
  for (const id of changedFrontIds) {
    const front = findFront(city, id);
    if (!front || front.status !== 'active') continue;
    near.add(front.id);
    for (const n of neighbors(city, front)) near.add(n.id);
  }
  return activeFronts(city)
    .filter((f) => !except.has(f.id) && f.form !== 'clock' && (near.has(f.id) || frontObjectIds(f).some((id) => changed.has(id))))
    .slice(0, rules.fronts.refresh.maxFronts);
}
