import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { YamlStorage } from '../src/storage/yaml.js';
import { holdClock, worldDay, clockIsHeld } from '../src/game/scheduler.js';
import {
  captureLiveWorld,
  writePlaySnapshot,
  listPlaySnapshots,
  readPlaySnapshot,
  deletePlaySnapshot,
  restoreLiveWorld,
  PLAY_SNAPSHOT_KIND,
  PLAY_SNAPSHOT_VERSION,
} from '../src/game/playSnapshot.js';

function testConfig(dir) {
  return {
    storage: { yaml: { dir } },
    world: { name: 'Тест' },
    tick: { intervalHours: 2 },
  };
}

async function withStore(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudshire-snapshot-'));
  const config = testConfig(dir);
  const storage = new YamlStorage(config);
  await storage.init();
  try {
    return await fn(storage, config, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedCity(storage, extra = {}) {
  const world = await storage.getWorld();
  const domain = {
    id: 'domain_sarkum',
    worldId: world.id,
    name: 'Саркум',
    status: 'playing',
    plotlines: [{ id: 'plot_well', kind: 'story', title: 'Гул колодца', synopsis: 'Вода поёт.' }],
    ...extra.domain,
  };
  await storage.saveDomain(domain);
  await storage.saveUserBinding({
    userId: 'local-test',
    worldId: world.id,
    domainId: domain.id,
  });
  await storage.saveConflux({
    id: 'conflux_1',
    worldId: world.id,
    domainIds: [domain.id],
    status: 'docked',
  });
  return { world, domain };
}

test('снимок запоминает города, дела и паузу, загрузка откатывает и не мотает день', async () => {
  await withStore(async (storage, config) => {
    const seeded = await seedCity(storage);
    const now = Date.now();
    const world = await storage.getWorld();
    world.jobs = [
      {
        id: 'job_fire',
        domainId: seeded.domain.id,
        kind: 'threat_fire',
        dueDay: 40,
        state: 'pending',
        payload: { threatId: 'thr_1' },
        attempts: 0,
      },
    ];
    holdClock(world, now);
    await storage.saveWorld(world);
    const savedDay = worldDay(world, { now, config });

    const written = await writePlaySnapshot(config, await captureLiveWorld(storage, { config, now }), {
      label: 'перед развилкой',
    });
    assert.equal(written.ok, true);
    assert.equal(written.label, 'перед развилкой');
    assert.match(written.id, /^save_[a-z0-9]+$/i);

    const live = await storage.getWorld();
    live.jobs = [];
    await storage.saveWorld(live);
    await storage.saveDomain({
      ...seeded.domain,
      name: 'Другое имя',
      plotlines: [],
    });
    await storage.saveDomain({
      id: 'domain_extra',
      worldId: live.id,
      name: 'Лишний',
      status: 'playing',
    });
    await storage.saveConflux({
      id: 'conflux_extra',
      worldId: live.id,
      domainIds: ['domain_extra'],
      status: 'approaching',
    });

    const later = now + 24 * 60 * 60 * 1000;
    const bundle = await readPlaySnapshot(config, written.id);
    assert.equal(bundle.kind, PLAY_SNAPSHOT_KIND);
    const restored = await restoreLiveWorld(storage, bundle, { config, now: later });
    assert.equal(restored.ok, true);
    assert.equal(restored.worldId, seeded.world.id);
    assert.equal(restored.clockHeld, true);

    const after = await storage.getWorld();
    assert.equal(after.id, seeded.world.id);
    assert.equal(clockIsHeld(after), true);
    assert.equal(worldDay(after, { now: later, config }), savedDay);
    assert.equal(after.jobs[0].id, 'job_fire');
    assert.equal(after.jobs[0].payload.threatId, 'thr_1');

    const domains = await storage.listDomains();
    assert.equal(domains.length, 1);
    assert.equal(domains[0].name, 'Саркум');
    assert.equal(domains[0].plotlines[0].title, 'Гул колодца');
    assert.equal((await storage.listConfluxes()).length, 1);
    assert.equal((await storage.listUserBindings())[0].userId, 'local-test');
  });
});

test('снимок без паузы после загрузки не прыгает вперёд от стены часов', async () => {
  await withStore(async (storage, config) => {
    await seedCity(storage);
    const now = Date.now();
    const world = await storage.getWorld();
    const savedDay = worldDay(world, { now, config });
    const written = await writePlaySnapshot(config, await captureLiveWorld(storage, { config, now }), {
      label: 'ход идёт',
    });
    const later = now + 12 * 60 * 60 * 1000;
    const bundle = await readPlaySnapshot(config, written.id);
    const restored = await restoreLiveWorld(storage, bundle, { config, now: later });
    assert.equal(restored.clockHeld, false);
    const after = await storage.getWorld();
    assert.equal(clockIsHeld(after), false);
    assert.equal(worldDay(after, { now: later, config }), savedDay);
  });
});

test('список, подпись и удаление снимков', async () => {
  await withStore(async (storage, config) => {
    await seedCity(storage);
    const first = await writePlaySnapshot(config, await captureLiveWorld(storage), { label: '  первый  слот  ' });
    const second = await writePlaySnapshot(config, await captureLiveWorld(storage), { label: 'второй' });
    assert.equal(first.label, 'первый слот');
    const listed = await listPlaySnapshots(config);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, second.id);
    assert.deepEqual(listed.map((s) => s.label).sort(), ['второй', 'первый слот']);
    assert.equal(listed[0].cityNames[0], 'Саркум');
    assert.equal(listed[0].domainCount, 1);
    assert.equal(listed[0].worldName, 'Тест');

    const gone = await deletePlaySnapshot(config, first.id);
    assert.equal(gone.ok, true);
    assert.equal((await listPlaySnapshots(config)).length, 1);
    assert.equal(await readPlaySnapshot(config, first.id), null);
    const missing = await deletePlaySnapshot(config, first.id);
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'not_found');
  });
});

test('снимок берёт весь мир: оба острова и очередь', async () => {
  await withStore(async (storage, config) => {
    const { world, domain } = await seedCity(storage);
    await storage.saveDomain({
      id: 'domain_other',
      worldId: world.id,
      name: 'Веллея',
      status: 'playing',
    });
    await storage.saveUserBinding({
      userId: 'local-other',
      worldId: world.id,
      domainId: 'domain_other',
    });
    const live = await storage.getWorld();
    live.jobs = [{ id: 'job_world', kind: 'story_tick', dueDay: 9, state: 'pending' }];
    await storage.saveWorld(live);

    const bundle = await captureLiveWorld(storage, { config });
    assert.equal(bundle.version, PLAY_SNAPSHOT_VERSION);
    assert.deepEqual(bundle.domains.map((d) => d.name).sort(), ['Веллея', 'Саркум']);
    assert.equal(bundle.users.length, 2);
    assert.equal(bundle.world.jobs[0].id, 'job_world');
    assert.equal(bundle.catalogs, undefined);

    const written = await writePlaySnapshot(config, bundle, { label: 'весь мир' });
    await storage.saveDomain({ ...domain, name: 'Переименовали' });
    await storage.saveDomain({
      id: 'domain_extra',
      worldId: world.id,
      name: 'Лишний',
      status: 'playing',
    });
    const laterWorld = await storage.getWorld();
    laterWorld.jobs = [];
    await storage.saveWorld(laterWorld);

    const restored = await restoreLiveWorld(storage, await readPlaySnapshot(config, written.id), {
      config,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.domainCount, 2);
    const names = (await storage.listDomains()).map((d) => d.name).sort();
    assert.deepEqual(names, ['Веллея', 'Саркум']);
    assert.equal((await storage.getWorld()).jobs[0].id, 'job_world');
  });
});
