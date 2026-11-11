/**
 * Проход по городам: тем, у кого наступило задание, — догнать себя.
 * Клиент зовёт это по таймеру; сам поток таймеров не держит.
 */

import { nextJobDay } from '../core/jobs.js';
import type { CityLocks } from './city-lock.js';
import { requireWorld, today, type FlowDeps } from './context.js';
import { advanceCity } from './day.js';

export async function runDueCities(deps: FlowDeps, locks: CityLocks): Promise<{ cities: number; news: number }> {
  const world = await requireWorld(deps);
  const now = today(deps, world);
  let cities = 0;
  let news = 0;
  for (const city of await deps.storage.listCities()) {
    const next = nextJobDay(city);
    if (next == null || next > now) continue;
    cities += 1;
    try {
      news += await locks.run(city.id, () => advanceCity(deps, city.id));
    } catch (err) {
      deps.log?.warn('advance_failed', { cityId: city.id, error: String(err) });
    }
  }
  return { cities, news };
}
