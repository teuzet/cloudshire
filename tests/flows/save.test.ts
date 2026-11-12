import { describe, expect, test } from 'vitest';
import { today } from '../../src/flows/context.js';
import { exportGame, importGame } from '../../src/flows/save.js';
import { isPaused, pauseWorld, resumeWorld } from '../../src/flows/world.js';
import { blankCity } from '../helpers/fixtures.js';
import { stand } from '../helpers/game.js';

async function day(s: Awaited<ReturnType<typeof stand>>): Promise<number> {
  return today(s.deps, (await s.deps.storage.getWorld())!);
}

describe('пауза и сохранения dev-клиента', () => {
  test('пока часы стоят, игровой день не меняется; после паузы идёт дальше с того же дня', async () => {
    const s = await stand();
    s.passDays(5);
    await pauseWorld(s.deps);
    expect(isPaused((await s.deps.storage.getWorld())!)).toBe(true);
    s.passDays(40);
    expect(await day(s)).toBe(5);
    await resumeWorld(s.deps);
    expect(await day(s)).toBe(5);
    s.passDays(2);
    expect(await day(s)).toBe(7);
  });

  test('загрузка возвращает город, черновик и тот же игровой день, сколько бы ни прошло', async () => {
    const s = await stand();
    await s.deps.storage.saveCity(blankCity({ ownerId: 'dev' }));
    s.passDays(10);
    const save = await exportGame(s.deps, 'dev');
    expect(save.day).toBe(10);
    expect(save.city?.name).toBe('Туманск');

    s.passDays(100);
    const city = await s.deps.storage.getCityByOwner('dev');
    await s.deps.storage.saveCity({ ...city!, name: 'Другой' });
    await importGame(s.deps, 'dev', structuredClone(save));
    expect(await day(s)).toBe(10);
    expect((await s.deps.storage.getCityByOwner('dev'))?.name).toBe('Туманск');
    s.passDays(1);
    expect(await day(s)).toBe(11);
  });

  test('сохранение на паузе загружается на паузе', async () => {
    const s = await stand();
    s.passDays(3);
    await pauseWorld(s.deps);
    const save = await exportGame(s.deps, 'dev');
    await resumeWorld(s.deps);
    s.passDays(50);
    await importGame(s.deps, 'dev', structuredClone(save));
    s.passDays(20);
    expect(await day(s)).toBe(3);
    expect(isPaused((await s.deps.storage.getWorld())!)).toBe(true);
    expect(await s.deps.storage.getCityByOwner('dev')).toBeNull();
  });
});
