/**
 * Кого задевает перемена: какие идущие дела надо обновить.
 * Здесь только поиск по графу. Что стало с задетым, решают агенты в потоке.
 */

import type { Rules } from '../rules.js';
import type { City, Front } from '../city.js';
import { activeFronts, frontObjectIds } from './fronts.js';

/** Идущие дела, которых касается перемена. Сами источники перемены не обновляются. */
export function refreshTargets(rules: Rules, city: City, changedIds: readonly string[], exceptFrontIds: readonly string[]): Front[] {
  const changed = new Set(changedIds);
  const except = new Set(exceptFrontIds);
  return activeFronts(city)
    .filter((f) => !except.has(f.id) && f.form !== 'clock' && frontObjectIds(f).some((id) => changed.has(id)))
    .slice(0, rules.fronts.refresh.maxFronts);
}
