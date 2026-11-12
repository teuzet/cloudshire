/**
 * Dev: сохранение и загрузка игры одного игрока. Сохранение — мир, город и черновик онбординга
 * как есть плюс реальный момент сохранения. Всё в городе считается в игровых днях; в реальном
 * времени живут только мировые часы, поэтому при загрузке их якорь сдвигается так, чтобы игровой
 * день остался тем же, что был в момент сохранения (и пауза, если часы стояли).
 */

import type { City, World } from '../core/city.js';
import type { ClockState } from '../core/time.js';
import type { OnboardingDraft } from '../ports/storage.js';
import { today, type FlowDeps } from './context.js';

export interface GameSave {
  version: 1;
  /** Реальный момент сохранения. */
  savedAtMs: number;
  /** Игровой день в момент сохранения — для списка сохранений. */
  day: number;
  world: World;
  city: City | null;
  draft: OnboardingDraft | null;
}

export async function exportGame(deps: FlowDeps, ownerId: string): Promise<GameSave> {
  const world = await deps.storage.getWorld();
  if (!world) throw new Error('мир не создан');
  return {
    version: 1,
    savedAtMs: deps.clock.now(),
    day: today(deps, world),
    world,
    city: await deps.storage.getCityByOwner(ownerId),
    draft: await deps.storage.getDraft(ownerId),
  };
}

export function shiftClock(clock: ClockState, deltaMs: number): ClockState {
  return { ...clock, epochMs: clock.epochMs + deltaMs, heldAtMs: clock.heldAtMs == null ? null : clock.heldAtMs + deltaMs };
}

/** Заменить игру игрока сохранением. Мир общий: его часы, сезон и пул имён тоже берутся из сохранения. */
export async function importGame(deps: FlowDeps, ownerId: string, save: GameSave): Promise<void> {
  if (save.version !== 1) throw new Error(`сохранение версии ${String(save.version)} не поддерживается`);
  const current = await deps.storage.getWorld();
  const delta = deps.clock.now() - save.savedAtMs;
  const world: World = { ...save.world, clock: shiftClock(save.world.clock, delta), revision: current?.revision ?? 0 };
  await deps.storage.saveWorld(world);

  const oldCity = await deps.storage.getCityByOwner(ownerId);
  if (oldCity) await deps.storage.deleteCity(oldCity.id);
  if (save.city) {
    const other = await deps.storage.getCity(save.city.id);
    if (other) await deps.storage.deleteCity(other.id);
    await deps.storage.saveCity({ ...save.city, ownerId, revision: 0 });
  }
  await deps.storage.deleteDraft(ownerId);
  if (save.draft) await deps.storage.saveDraft({ ...save.draft, ownerId, revision: 0 });
}
