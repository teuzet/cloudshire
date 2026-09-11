import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { YamlStorage } from '../src/storage/yaml.js';

function testConfig(dir) {
  return {
    storage: { yaml: { dir } },
    world: { name: 'Тест' },
    tick: { intervalHours: 2 },
  };
}

async function withStore(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudshire-wipe-'));
  const storage = new YamlStorage(testConfig(dir));
  await storage.init();
  try {
    return await fn(storage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('wipe меняет id мира и стирает домены', async () => {
  await withStore(async (storage) => {
    const old = await storage.getWorld();
    await storage.saveDomain({
      id: 'domain_old',
      worldId: old.id,
      name: 'Варнели',
      status: 'playing',
    });
    const result = await storage.wipeAll();
    assert.notEqual(result.newWorldId, old.id);
    const live = await storage.getWorld();
    assert.equal(live.id, result.newWorldId);
    assert.equal((await storage.listDomains()).length, 0);
  });
});

test('save после wipe не воскрешает старый мир и домен', async () => {
  await withStore(async (storage) => {
    const oldWorld = await storage.getWorld();
    const oldDomain = {
      id: 'domain_old',
      worldId: oldWorld.id,
      name: 'Варнели',
      status: 'playing',
    };
    await storage.saveDomain(oldDomain);
    await storage.saveUserBinding({
      userId: 'local-test',
      worldId: oldWorld.id,
      domainId: oldDomain.id,
    });
    await storage.saveConflux({
      id: 'conflux_old',
      worldId: oldWorld.id,
      domainIds: [oldDomain.id],
      status: 'approaching',
    });

    await storage.wipeAll();
    await storage.saveWorld(oldWorld);
    await storage.saveDomain(oldDomain);
    await storage.saveUserBinding({
      userId: 'local-test',
      worldId: oldWorld.id,
      domainId: oldDomain.id,
    });
    await storage.saveConflux({
      id: 'conflux_old',
      worldId: oldWorld.id,
      domainIds: [oldDomain.id],
      status: 'approaching',
    });

    const live = await storage.getWorld();
    assert.notEqual(live.id, oldWorld.id);
    assert.equal((await storage.listDomains()).length, 0);
    assert.equal((await storage.listUserBindings()).length, 0);
    assert.equal((await storage.listConfluxes()).length, 0);
  });
});

test('wipe дожидается in-flight save и всё равно удаляет город', async () => {
  await withStore(async (storage) => {
    const old = await storage.getWorld();
    const domain = {
      id: 'domain_old',
      worldId: old.id,
      name: 'Варнели',
      status: 'playing',
    };
    await storage.saveDomain(domain);

    let saveStarted = false;
    const orig = storage.writeDomainUnlocked.bind(storage);
    storage.writeDomainUnlocked = async (d) => {
      saveStarted = true;
      await new Promise((r) => setTimeout(r, 40));
      return orig(d);
    };

    const saving = storage.saveDomain({ ...domain, name: 'Варнели-2' });
    const wiping = (async () => {
      while (!saveStarted) await new Promise((r) => setTimeout(r, 1));
      return storage.wipeAll();
    })();

    await Promise.all([saving, wiping]);
    assert.equal((await storage.listDomains()).length, 0);
    const live = await storage.getWorld();
    assert.notEqual(live.id, old.id);
  });
});
