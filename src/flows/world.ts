/**
 * Мир: часы, сезон, пул имён. Создаётся один раз.
 */

import type { World } from '../core/city.js';
import { newClock, skipDays } from '../core/time.js';
import { newId, type FlowDeps } from './context.js';

export interface NamesFile {
  female: string[];
  male: string[];
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Женские и мужские имена вперемешку, чтобы любая выборка была смешанной. */
export function buildNamePool(names: NamesFile, rng: () => number): string[] {
  const f = shuffle(names.female, rng);
  const m = shuffle(names.male, rng);
  const out: string[] = [];
  for (let i = 0; i < Math.max(f.length, m.length); i++) {
    if (f[i]) out.push(f[i] as string);
    if (m[i]) out.push(m[i] as string);
  }
  return [...new Set(out)];
}

export async function ensureWorld(
  deps: FlowDeps,
  args: { names: NamesFile; season?: { name: string; rules: string[] } },
): Promise<World> {
  const existing = await deps.storage.getWorld();
  if (existing) return existing;
  const world: World = {
    id: newId(deps, 'world'),
    clock: newClock(deps.clock.now()),
    season: { id: newId(deps, 'season'), name: args.season?.name ?? 'Первый сезон', rules: args.season?.rules ?? [], startedDay: 0 },
    namePool: buildNamePool(args.names, deps.random.rng),
    revision: 0,
  };
  return deps.storage.saveWorld(world);
}

/** Dev: промотать мировые часы. Города догонят себя при следующем проходе. */
export async function skipWorldDays(deps: FlowDeps, days: number): Promise<World> {
  const world = await deps.storage.getWorld();
  if (!world) throw new Error('мир не создан');
  return deps.storage.saveWorld({ ...world, clock: skipDays(world.clock, days, deps.rules) });
}
