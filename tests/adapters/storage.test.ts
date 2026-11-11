import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { FileStorage } from '../../src/adapters/storage/file.js';
import { MemoryStorage } from '../../src/adapters/storage/memory.js';
import { StaleWriteError, type Storage } from '../../src/ports/storage.js';
import { blankCity } from '../helpers/fixtures.js';

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true });
});

const makers: Array<[string, () => Promise<Storage>]> = [
  ['память', async () => new MemoryStorage()],
  [
    'файлы',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudshire-'));
      tmpDirs.push(dir);
      return new FileStorage(dir);
    },
  ],
];

// Один контракт на все адаптеры: Mongo потом пройдёт его же.
describe.each(makers)('хранилище: %s', (_name, make) => {
  test('город сохраняется и находится по владельцу', async () => {
    const s = await make();
    const saved = await s.saveCity(blankCity({ id: 'c1', ownerId: 'u1' }));
    expect(saved.revision).toBe(1);
    expect((await s.getCityByOwner('u1'))?.id).toBe('c1');
    expect(await s.listCities()).toHaveLength(1);
  });

  test('запись поверх чужой правки падает', async () => {
    const s = await make();
    const first = await s.saveCity(blankCity({ id: 'c1' }));
    const a = structuredClone(first);
    const b = structuredClone(first);
    await s.saveCity(a);
    await expect(s.saveCity(b)).rejects.toBeInstanceOf(StaleWriteError);
  });

  test('отданная копия не связана с сохранённым', async () => {
    const s = await make();
    const saved = await s.saveCity(blankCity({ id: 'c1' }));
    saved.name = 'Другое';
    expect((await s.getCity('c1'))?.name).not.toBe('Другое');
  });

  test('удаление и черновики', async () => {
    const s = await make();
    await s.saveCity(blankCity({ id: 'c1' }));
    await s.deleteCity('c1');
    expect(await s.getCity('c1')).toBeNull();
    await s.saveDraft({ ownerId: 'u', messages: [], seed: null, status: 'talking', revision: 0 });
    expect((await s.getDraft('u'))?.revision).toBe(1);
    await s.deleteDraft('u');
    expect(await s.getDraft('u')).toBeNull();
  });
});
