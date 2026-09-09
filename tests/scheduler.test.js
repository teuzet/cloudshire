import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleJob,
  findJob,
  cancelJobs,
  cancelJobsForPlot,
  cancelJobsForThreat,
  dueJobs,
  nextJobDay,
  nextWakeAt,
  claimJob,
  completeJob,
  failJob,
  pruneJobs,
  beginRulerTurn,
  endRulerTurn,
  rulerTurnStale,
  worldDay,
  RULER_TURN_FAILSAFE_MS,
  DomainQueue,
  LockSet,
} from '../src/game/scheduler.js';
import { startClock } from '../src/game/gameClock.js';

function world() {
  const w = { jobs: [] };
  startClock(w, 0);
  return w;
}

test('задание встаёт в очередь ожидающим', () => {
  const w = world();
  const job = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 40, payload: { threatId: 't1' } });
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(findJob(w, job.id).dueDay, 40);
});

test('просроченные задания идут в порядке наступления', () => {
  const w = world();
  const late = scheduleJob(w, { domainId: 'a', kind: 'seed_appear', dueDay: 30 });
  const early = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 10 });
  scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 90 });
  const due = dueJobs(w, 40);
  assert.deepEqual(due.map((j) => j.id), [early.id, late.id]);
});

test('при равном дне побеждает раньше поставленное', () => {
  const w = world();
  const first = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 10 });
  const second = scheduleJob(w, { domainId: 'a', kind: 'process_finish', dueDay: 10 });
  assert.deepEqual(dueJobs(w, 10).map((j) => j.id), [first.id, second.id]);
});

test('очередь фильтруется по домену', () => {
  const w = world();
  scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 5 });
  const b = scheduleJob(w, { domainId: 'b', kind: 'threat_fire', dueDay: 5 });
  assert.deepEqual(dueJobs(w, 10, { domainId: 'b' }).map((j) => j.id), [b.id]);
  assert.equal(nextJobDay(w, { domainId: 'b' }), 5);
});

test('claim отделён от complete — падение не теряет и не дублирует', () => {
  const w = world();
  const job = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 5 });
  assert.equal(claimJob(job), true);
  assert.equal(job.state, 'running');
  assert.equal(job.attempts, 1);
  assert.equal(claimJob(job), false, 'взятое второй раз не выдаётся');
  assert.deepEqual(dueJobs(w, 5), [], 'взятое не висит в просроченных');

  failJob(job, 'модель отвалилась');
  assert.equal(job.state, 'pending', 'после сбоя задание вернулось в очередь');
  assert.deepEqual(dueJobs(w, 5).map((j) => j.id), [job.id]);
});

test('после трёх попыток задание сдаётся', () => {
  const w = world();
  const job = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 5 });
  for (let i = 0; i < 3; i += 1) {
    claimJob(job);
    failJob(job, 'опять');
  }
  assert.equal(job.state, 'failed');
  assert.deepEqual(dueJobs(w, 5), []);
});

test('complete запоминает результат', () => {
  const w = world();
  const job = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 5 });
  claimJob(job);
  completeJob(job, { chronicleId: 'f1' });
  assert.equal(job.state, 'done');
  assert.deepEqual(job.result, { chronicleId: 'f1' });
});

test('отмена по нити и по угрозе снимает только ожидающие', () => {
  const w = world();
  const a = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 5, payload: { plotId: 'p1', threatId: 't1' } });
  const b = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 9, payload: { plotId: 'p1', threatId: 't2' } });
  const other = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 9, payload: { plotId: 'p2' } });
  claimJob(a);

  const removed = cancelJobsForThreat(w, 't2');
  assert.deepEqual(removed.map((j) => j.id), [b.id]);
  assert.equal(b.cancelled, true);

  assert.deepEqual(cancelJobsForThreat(w, 't1'), [], 'уже выполняющееся не отменяем');
  assert.deepEqual(cancelJobsForPlot(w, 'p2').map((j) => j.id), [other.id]);
});

test('cancelJobs принимает произвольное условие', () => {
  const w = world();
  scheduleJob(w, { domainId: 'a', kind: 'seed_appear', dueDay: 5, payload: { sourceOrderId: 'ord1' } });
  scheduleJob(w, { domainId: 'a', kind: 'seed_appear', dueDay: 5, payload: { sourceOrderId: 'ord2' } });
  const removed = cancelJobs(w, (j) => j.payload?.sourceOrderId === 'ord1');
  assert.equal(removed.length, 1);
});

test('nextJobDay и nextWakeAt смотрят только на ожидающие', () => {
  const w = world();
  assert.equal(nextJobDay(w), null);
  assert.equal(nextWakeAt(w, {}), null);
  const job = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 15 });
  assert.equal(nextJobDay(w), 15);
  assert.equal(nextWakeAt(w, {}), 15 * 4 * 60 * 1000);
  claimJob(job);
  completeJob(job);
  assert.equal(nextJobDay(w), null);
});

test('очередь не растёт вечно', () => {
  const w = world();
  for (let i = 0; i < 20; i += 1) {
    const job = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: i });
    claimJob(job);
    completeJob(job);
  }
  const pending = scheduleJob(w, { domainId: 'a', kind: 'threat_fire', dueDay: 100 });
  assert.equal(pruneJobs(w, { keep: 5 }), 15);
  assert.equal(w.jobs.length, 6);
  assert.ok(findJob(w, pending.id), 'ожидающее не выбрасываем');
});

// ─────────────────────────── ход правителя ───────────────────────────

test('ход правителя останавливает время домена', () => {
  const w = world();
  const start = 40 * 60 * 1000; // день 10
  assert.equal(worldDay(w, { now: start }), 10);
  beginRulerTurn(w, start);
  assert.equal(worldDay(w, { now: start + 60_000 }), 10, 'пока жрец думает, день не меняется');
  endRulerTurn(w, start + 60_000);
  assert.equal(w.pausedMs, 60_000);
  assert.equal(worldDay(w, { now: start + 60_000 }), 10);
  assert.equal(worldDay(w, { now: start + 60_000 + 4 * 60_000 }), 11);
});

test('зависший ход сбрасывается предохранителем', () => {
  const w = world();
  beginRulerTurn(w, 0);
  assert.equal(rulerTurnStale(w, RULER_TURN_FAILSAFE_MS - 1), false);
  assert.equal(rulerTurnStale(w, RULER_TURN_FAILSAFE_MS), true);
  // Даже если ход не закрыли, время не стоит дольше предохранителя.
  const now = 10 * RULER_TURN_FAILSAFE_MS;
  assert.equal(worldDay(w, { now }), Math.floor((now - RULER_TURN_FAILSAFE_MS) / (4 * 60_000)));
});

test('закрытие незапущенного хода безвредно', () => {
  const w = world();
  endRulerTurn(w, 1000);
  assert.equal(w.pausedMs ?? 0, 0);
  assert.equal(w.turnStartedAt, null);
});

// ─────────────────────── один писатель на домен ───────────────────────

test('очередь домена не даёт задачам перемешаться', async () => {
  const q = new DomainQueue();
  const order = [];
  const slow = q.run('a', async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push('первая');
  });
  const fast = q.run('a', async () => {
    order.push('вторая');
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['первая', 'вторая']);
});

test('разные домены не блокируют друг друга', async () => {
  const q = new DomainQueue();
  const order = [];
  const a = q.run('a', async () => {
    await new Promise((r) => setTimeout(r, 25));
    order.push('a');
  });
  const b = q.run('b', async () => {
    order.push('b');
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['b', 'a']);
});

test('упавшая задача не рвёт очередь домена', async () => {
  const q = new DomainQueue();
  const order = [];
  const bad = q.run('a', async () => {
    throw new Error('сломалось');
  });
  await assert.rejects(bad);
  await q.run('a', async () => order.push('дальше'));
  assert.deepEqual(order, ['дальше']);
});

test('замки на нити берутся в отсортированном порядке', async () => {
  const locks = new LockSet();
  const order = [];
  // Два события в сопряжении просят одни и те же домены в разном порядке.
  const first = await locks.acquire(['b', 'a']);
  const second = locks.acquire(['a', 'b']).then((release) => {
    order.push('второе взяло');
    release();
  });
  order.push('первое взяло');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['первое взяло'], 'второе ждёт, а не проходит насквозь');
  first();
  await second;
  assert.deepEqual(order, ['первое взяло', 'второе взяло']);
});

test('замки на разные нити не пересекаются', async () => {
  const locks = new LockSet();
  const releaseA = await locks.acquire(['p1']);
  const releaseB = await locks.acquire(['p2']);
  releaseA();
  releaseB();
  assert.equal(locks.held.size, 0);
});
