/**
 * Потеря записи. В живой партии так исчез шаг Керсая: дневной цикл и ход
 * правителя читали город по своей копии, а сохранял последний.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { YamlStorage } from '../src/storage/yaml.js';
import { StaleWriteError } from '../src/storage/revision.js';
import {
  DomainQueue,
  beginRulerTurn,
  endRulerTurn,
  mergeWorldJobs,
  rulerTurnHolds,
  scheduleJob,
  RULER_TURN_FAILSAFE_MS,
} from '../src/game/scheduler.js';

async function withStore(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudshire-race-'));
  const config = { storage: { yaml: { dir } }, world: { name: 'Тест' }, tick: { intervalHours: 2 } };
  const storage = new YamlStorage(config);
  await storage.init();
  try {
    return await fn(storage, config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedCity(storage) {
  const world = await storage.getWorld();
  const domain = {
    id: 'domain_kersai',
    worldId: world.id,
    name: 'Керсай',
    status: 'playing',
    plotlines: [],
    lore: [],
    state: { pendingActions: [] },
  };
  await storage.saveDomain(domain);
  return { world, domain };
}

test('запись от устаревшей ревизии отклоняется, а не затирает чужую', async () => {
  await withStore(async (storage) => {
    await seedCity(storage);

    const loop = await storage.getDomain('domain_kersai');
    const turn = await storage.getDomain('domain_kersai');

    loop.plotlines.push({ id: 'plot_seeded', title: 'Посеяно циклом' });
    await storage.saveDomain(loop);

    turn.lore.push({ id: 'lore_turn', text: 'Сказано в разговоре' });
    await assert.rejects(() => storage.saveDomain(turn), StaleWriteError);

    const stored = await storage.getDomain('domain_kersai');
    assert.equal(stored.plotlines.length, 1, 'работа цикла осталась на месте');
  });
});

test('взять-поменять-отдать переживает одновременных писателей', async () => {
  await withStore(async (storage) => {
    await seedCity(storage);

    await Promise.all([
      storage.updateDomain('domain_kersai', (d) => d.plotlines.push({ id: 'plot_loop' })),
      storage.updateDomain('domain_kersai', (d) => d.lore.push({ id: 'lore_turn' })),
    ]);

    const stored = await storage.getDomain('domain_kersai');
    assert.equal(stored.plotlines.length, 1);
    assert.equal(stored.lore.length, 1);
  });
});

test('очередь города пускает писателей по одному', async () => {
  await withStore(async (storage) => {
    await seedCity(storage);
    const queue = new DomainQueue();
    const order = [];

    const slow = queue.run('domain_kersai', async () => {
      const domain = await storage.getDomain('domain_kersai');
      await new Promise((r) => setTimeout(r, 20));
      domain.plotlines.push({ id: 'plot_loop' });
      await storage.saveDomain(domain);
      order.push('цикл');
    });
    assert.equal(queue.busy('domain_kersai'), true, 'занятость видна сразу, без await');

    const fast = queue.run('domain_kersai', async () => {
      const domain = await storage.getDomain('domain_kersai');
      domain.lore.push({ id: 'lore_turn' });
      await storage.saveDomain(domain);
      order.push('ход');
    });

    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['цикл', 'ход']);

    const stored = await storage.getDomain('domain_kersai');
    assert.equal(stored.plotlines.length, 1, 'посев цикла не потерян');
    assert.equal(stored.lore.length, 1, 'запись хода не потеряна');
  });
});

test('снимок пишется поверх чужих ревизий', async () => {
  await withStore(async (storage) => {
    const { world } = await seedCity(storage);
    const fromSnapshot = {
      id: 'domain_kersai',
      worldId: world.id,
      name: 'Керсай',
      status: 'playing',
      rev: 77,
      plotlines: [],
      lore: [],
      state: { pendingActions: [] },
    };
    await storage.replaceLiveWorld({ world, domains: [fromSnapshot] });
    const stored = await storage.getDomain('domain_kersai');
    assert.equal(stored.name, 'Керсай');
  });
});

// ─────────────────────────── очередь мира ───────────────────────────

test('слияние очереди: отработанное не воскресает, чужое и своё остаются', () => {
  const fresh = { jobs: [] };
  scheduleJob(fresh, { id: 'job_mine', domainId: 'd1', kind: 'process_finish', dueDay: 5 });
  scheduleJob(fresh, { id: 'job_chat', domainId: 'd1', kind: 'process_finish', dueDay: 9 });

  const mine = {
    jobs: [
      { id: 'job_mine', kind: 'process_finish', dueDay: 5, state: 'done' },
      { id: 'job_new', kind: 'threat_fire', dueDay: 7, state: 'pending' },
    ],
  };
  mergeWorldJobs(fresh, mine);

  const byId = new Map(fresh.jobs.map((j) => [j.id, j]));
  assert.equal(byId.get('job_mine').state, 'done', 'своё разобранное записалось');
  assert.equal(byId.get('job_chat').state, 'pending', 'чужое задание осталось');
  assert.equal(byId.get('job_new').kind, 'threat_fire', 'своё новое доехало');
});

test('слияние не поднимает обратно задание, снятое в чате', () => {
  const fresh = { jobs: [{ id: 'job_deed', kind: 'process_finish', dueDay: 5, state: 'failed', cancelled: true }] };
  const mine = { jobs: [{ id: 'job_deed', kind: 'process_finish', dueDay: 5, state: 'pending' }] };
  mergeWorldJobs(fresh, mine);
  assert.equal(fresh.jobs[0].state, 'failed');
});

test('ход держит только свой город, и зависший не держит никого', () => {
  const now = Date.now();
  const world = {};
  beginRulerTurn(world, now, { domainId: 'd1' });
  assert.equal(rulerTurnHolds(world, 'd1', now), true);
  assert.equal(rulerTurnHolds(world, 'd2', now), false);
  assert.equal(rulerTurnHolds(world, 'd1', now + RULER_TURN_FAILSAFE_MS + 1), false);
  endRulerTurn(world, now);
  assert.equal(rulerTurnHolds(world, 'd1', now), false);
  assert.equal(world.turnDomainId, null);
});
