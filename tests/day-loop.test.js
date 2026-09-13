import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerForEvent, deliverEvent, stepDomain, runDayLoop } from '../src/game/dayLoop.js';
import { wakeDelayMs, MIN_WAKE_MS, MAX_WAKE_MS } from '../src/scheduler/days.js';
import { scheduleJob, beginRulerTurn, holdClock, RULER_TURN_FAILSAFE_MS } from '../src/game/scheduler.js';
import { scheduleDeedJob } from '../src/game/worldLoop.js';
import { startDeed } from '../src/game/deeds.js';
import { notifySettings, markPushed } from '../src/game/notify.js';
import { realMsPerGameDay } from '../src/game/gameClock.js';
import { addPriestOrder } from '../src/game/priestOrders.js';

const config = {
  stats: [{ id: 'prosperity' }, { id: 'security' }],
  tick: { plot: { roll: {} }, steward: { cooldownDays: 30 } },
};

const silentLog = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeWorld(extra = {}) {
  return { id: 'w1', epochAt: new Date(0).toISOString(), dayIndex: 0, jobs: [], ...extra };
}

function makePlot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    title: 'Трещина в опорном столбе',
    synopsis: 'северное крыло ведёт',
    gravity: 'CRISIS',
    depth: 0,
    maxDepth: 3,
    failCount: 0,
    maxFails: 2,
    defenseCount: 0,
    threats: [],
    relatedProcessIds: [],
    chronicleIds: [],
    endings: [{ id: 'e1', kind: 'BAD_ENDING', text: 'Крыло рушится' }],
    ...extra,
  };
}

function makeDomain({ plots = [], processes = [], id = 'd1' } = {}) {
  return {
    id,
    name: 'Тихая Гряда',
    ownerUserId: 'u1',
    status: 'playing',
    stats: { prosperity: 70, security: 55 },
    lore: [],
    officers: [],
    characters: [{ name: 'Малуша', dialogHistory: [] }],
    plotlines: plots,
    closedPlotlines: [],
    state: { pendingActions: processes, mana: 50, faith: 60, manaDay: 100 },
  };
}

/** Приложение-заглушка: собирает, что жрец сказал и что ушло в телефон. */
function fakeApp() {
  const said = [];
  const pushed = [];
  return {
    said,
    pushed,
    async persistDialog(domain, role, content, opts) {
      said.push({ role, content, ...opts });
    },
    async emitOutbound(userId, message, meta) {
      pushed.push({ userId, message, ...meta });
    },
  };
}

/**
 * Рантайм-заглушка: инструменты не вызывает. Судья статов и хранитель нитей
 * тогда просто ничего не меняют, и в шаге остаётся видна работа движка.
 */
function quietRuntime() {
  const seen = [];
  return {
    seen,
    async run(opts) {
      seen.push(opts.agentId);
      return { text: '', toolTrace: [] };
    },
  };
}

/** Рантайм, который всегда отвечает одной фразой глашатая. */
function heraldRuntime(text = 'Покровитель, опору закрепили.') {
  const seen = [];
  return {
    seen,
    async run(opts) {
      seen.push(opts.agentId);
      return { text };
    },
  };
}

function storageOf(domains, world) {
  const byId = new Map(domains.map((d) => [d.id, d]));
  return {
    saved: [],
    async getWorld() {
      return world;
    },
    async saveWorld() {},
    async listDomains() {
      return [...byId.values()];
    },
    async getDomain(id) {
      return byId.get(id) || null;
    },
    async saveDomain(d) {
      this.saved.push(d.id);
      byId.set(d.id, d);
    },
    async listConfluxes() {
      return [];
    },
    async saveConflux() {},
    async getConflux() {
      return null;
    },
  };
}

// ─────────────────────── настройка уведомлений ───────────────────────

test('каждое событие знает свой триггер уведомлений', () => {
  assert.equal(triggerForEvent({ occasion: 'новая история' }), 'newStory');
  assert.equal(triggerForEvent({ occasion: 'угроза' }), 'threatFired');
  assert.equal(triggerForEvent({ occasion: 'угроза', surfaced: { id: 't1' } }), 'threatSurfaced');
  assert.equal(triggerForEvent({ occasion: 'разрешение' }), 'plotClosed');
  assert.equal(triggerForEvent({ occasion: 'дело', closed: true }), 'plotClosed');
  assert.equal(
    triggerForEvent({ occasion: 'дело', plotId: 'p1', outcome: { finish: 'fail' } }),
    'deedFailed',
  );
  assert.equal(triggerForEvent({ occasion: 'дело', plotId: 'p1', outcome: { finish: 'ok' } }), 'deedDone');
  assert.equal(triggerForEvent({ occasion: 'дело', outcome: { finish: 'ok' } }), 'errandDone');
  assert.equal(triggerForEvent({ occasion: 'доклад' }), 'priestReport');
});

// ─────────────────────────── рассказ события ───────────────────────────

test('событие рассказывается глашатаем и уходит в телефон', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const app = fakeApp();
  const runtime = heraldRuntime();
  const res = await deliverEvent({
    config,
    runtime,
    app,
    domain,
    world: makeWorld(),
    day: 120,
    event: { occasion: 'дело', plot, plotId: plot.id, fact: { id: 'f1', text: 'опора закреплена' } },
    log: silentLog,
  });
  assert.equal(res.pushed, true);
  assert.deepEqual(runtime.seen, ['herald']);
  assert.equal(app.said[0].kind, 'event');
  assert.equal(app.pushed[0].kind, 'event');
  assert.equal(app.pushed[0].chronicleId, 'f1');
  assert.equal(app.pushed[0].plotId, 'p1');
  assert.match(app.pushed[0].message, /опору закрепили/);
});

test('со снятой глушилкой отключённый повод всё равно доходит, но помечен', async () => {
  const domain = makeDomain();
  const notify = notifySettings(domain);
  notify.triggers.deedDone = false;
  const app = fakeApp();
  const res = await deliverEvent({
    config,
    runtime: heraldRuntime(),
    app,
    domain,
    world: makeWorld(),
    day: 120,
    event: { occasion: 'дело', plotId: 'p1', fact: { id: 'f1', text: 'опора закреплена' } },
    log: silentLog,
  });
  assert.equal(res.pushed, true);
  assert.equal(res.wouldMute, 'trigger_off', 'вердикт сохранён, чтобы измерить поток');
  assert.equal(app.said.length, 1, 'в разговоре запись остаётся');
  assert.equal(app.pushed.length, 1, 'телефон звонит');
});

test('сработавшую беду не глушит ни зазор, ни выключенный триггер', async () => {
  const domain = makeDomain();
  const notify = notifySettings(domain);
  notify.triggers.threatFired = false;
  markPushed(domain, 120);
  const app = fakeApp();
  const res = await deliverEvent({
    config,
    runtime: heraldRuntime('Северное крыло осело.'),
    app,
    domain,
    world: makeWorld(),
    day: 120,
    event: { occasion: 'угроза', plotId: 'p1', fact: { id: 'f2', text: 'крыло осело' } },
    log: silentLog,
  });
  assert.equal(notifySettings(domain).triggers.threatFired, true, 'триггер защищён');
  assert.equal(res.pushed, true);
  assert.equal(res.wouldMute, 'min_gap', 'зазор бы держал, но глушилка снята');
  assert.equal(app.said.length, 1);
  assert.equal(app.pushed.length, 1);
});

test('всплывшую беду жрец рассказывает без записи в хронике', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const app = fakeApp();
  const res = await deliverEvent({
    config,
    runtime: heraldRuntime('Опора трещит, покровитель.'),
    app,
    domain,
    world: makeWorld(),
    day: 120,
    event: { occasion: 'угроза', plot, plotId: plot.id, surfaced: { id: 't1', text: 'обвал крыла' } },
    log: silentLog,
  });
  assert.equal(res.pushed, true);
  assert.equal(app.pushed[0].chronicleId, null);
  assert.equal(app.pushed[0].threatId, 't1');
});

test('говорить нечего — глашатая не зовём', async () => {
  const runtime = heraldRuntime();
  const res = await deliverEvent({
    config,
    runtime,
    app: fakeApp(),
    domain: makeDomain(),
    world: makeWorld(),
    day: 1,
    event: { occasion: 'дело' },
    log: silentLog,
  });
  assert.equal(res.skipped, 'nothing_to_say');
  assert.deepEqual(runtime.seen, []);
});

// ──────────────────────────── шаг города ────────────────────────────

test('шаг разбирает дошедшее дело и ставит день', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const process = startDeed(
    { id: 'proc1', summary: 'укрепить опору', status: 'active', plotlineId: plot.id, plotEngagement: 'DIRECT' },
    { day: 100, judged: { durationBand: 'WEEKS', difficulty: 'PLAIN', objectiveDays: 20 } },
  );
  domain.state.pendingActions.push(process);
  plot.relatedProcessIds.push(process.id);
  const world = makeWorld();
  scheduleDeedJob(world, domain, process);

  const runtime = quietRuntime();
  const out = await stepDomain({
    config,
    runtime,
    domain,
    world,
    day: 130,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].occasion, 'дело');
  assert.equal(domain.state.lastDay, 130);
  assert.notEqual(process.status, 'active', 'дело закрыто исходом');
});

test('сановник ходит только в тишину и не чаще своего остывания', async () => {
  const domain = makeDomain();
  domain.state.lastStewardDay = 120;
  const runtime = { calls: [], async run(opts) { this.calls.push(opts.agentId); return { text: '' }; } };
  const out = await stepDomain({
    config,
    runtime,
    domain,
    world: makeWorld(),
    day: 130,
    log: silentLog,
  });
  assert.equal(out.events.length, 0);
  assert.equal(out.stewardAct, null);
  assert.deepEqual(runtime.calls, [], 'остывание не вышло — агента не зовём');
});

test('наказ жреца прилипает к событию шага', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  addPriestOrder(domain, { subject: 'как идут дела в порту', day: 0 });
  const process = startDeed(
    { id: 'proc1', summary: 'починить лоток', status: 'active', plotlineId: plot.id, plotEngagement: 'DIRECT' },
    { day: 100, judged: { durationBand: 'DAYS', difficulty: 'PLAIN', objectiveDays: 8 } },
  );
  domain.state.pendingActions.push(process);
  plot.relatedProcessIds.push(process.id);
  const world = makeWorld();
  scheduleDeedJob(world, domain, process);

  const out = await stepDomain({
    config,
    runtime: quietRuntime(),
    domain,
    world,
    day: 130,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(out.events[0].reportSubject, 'как идут дела в порту');
});

// ──────────────────────────── проход мира ────────────────────────────

test('проход мира считает день от часов и разбирает город', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const process = startDeed(
    { id: 'proc1', summary: 'укрепить опору', status: 'active', plotlineId: plot.id, plotEngagement: 'DIRECT' },
    { day: 0, judged: { durationBand: 'DAYS', difficulty: 'PLAIN', objectiveDays: 5 } },
  );
  domain.state.pendingActions.push(process);
  plot.relatedProcessIds.push(process.id);
  const world = makeWorld();
  scheduleDeedJob(world, domain, process);
  const storage = storageOf([domain], world);
  const app = fakeApp();

  const res = await runDayLoop({
    config,
    runtime: heraldRuntime(),
    storage,
    app,
    now: 10 * realMsPerGameDay(config),
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.day, 10);
  assert.equal(world.dayIndex, 10);
  assert.equal(res.results[0].events, 1);
  assert.equal(res.results[0].pushed, 1);
  assert.ok(storage.saved.includes('d1'));
});

test('ход правителя останавливает проход мира', async () => {
  const world = makeWorld();
  beginRulerTurn(world, Date.now());
  const storage = storageOf([makeDomain()], world);
  const res = await runDayLoop({
    config,
    runtime: heraldRuntime(),
    storage,
    app: fakeApp(),
    now: Date.now(),
    log: silentLog,
  });
  assert.equal(res.skipped, 'ruler_turn');
  assert.deepEqual(res.results, []);
});

test('удержанные часы останавливают проход мира', async () => {
  const world = makeWorld();
  holdClock(world, Date.now());
  const storage = storageOf([makeDomain()], world);
  const res = await runDayLoop({
    config,
    runtime: heraldRuntime(),
    storage,
    app: fakeApp(),
    now: Date.now(),
    log: silentLog,
  });
  assert.equal(res.skipped, 'clock_held');
  assert.deepEqual(res.results, []);
});

test('ручной проход идёт и при удержанных часах', async () => {
  const world = makeWorld();
  holdClock(world, Date.now());
  const storage = storageOf([makeDomain()], world);
  const res = await runDayLoop({
    config,
    runtime: heraldRuntime(),
    storage,
    app: fakeApp(),
    now: Date.now(),
    allowWhileHeld: true,
    log: silentLog,
  });
  assert.equal(res.skipped, undefined);
});

test('зависший ход снимается предохранителем, и мир идёт дальше', async () => {
  const now = Date.now();
  const world = makeWorld();
  beginRulerTurn(world, now - RULER_TURN_FAILSAFE_MS - 1000);
  const storage = storageOf([makeDomain()], world);
  const res = await runDayLoop({
    config,
    runtime: heraldRuntime(),
    storage,
    app: fakeApp(),
    now,
    log: silentLog,
  });
  assert.equal(res.skipped, undefined);
  assert.equal(world.turnStartedAt, null);
});

test('сопряжённый город идёт тем же дневным движком', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  const storage = storageOf([domain], world);
  storage.listConfluxes = async () => [
    { id: 'cf1', status: 'docked', domainIds: ['d1'] },
  ];
  const res = await runDayLoop({
    config,
    runtime: heraldRuntime(),
    storage,
    app: fakeApp(),
    now: 0,
    log: silentLog,
  });
  assert.equal(res.results[0].skipped, undefined);
  assert.equal(res.results[0].domainId, 'd1');
  assert.ok('events' in res.results[0]);
});

// ─────────────────────────── будильник ───────────────────────────

test('будильник просыпается к сроку ближайшего задания', () => {
  const world = makeWorld();
  const dayMs = realMsPerGameDay(null);
  scheduleJob(world, { domainId: 'd1', kind: 'threat_fire', dueDay: 30, payload: {} });
  const now = 20 * dayMs;
  // До срока десять игровых дней, но дольше верхней границы мы не спим.
  assert.equal(wakeDelayMs(world, { now }), MAX_WAKE_MS);
  assert.equal(
    wakeDelayMs(world, { now: 30 * dayMs - 30_000 }),
    30_000,
    'ближе к сроку — точная задержка',
  );
});

test('просроченное задание будит не мгновенно, а через нижнюю границу', () => {
  const world = makeWorld();
  scheduleJob(world, { domainId: 'd1', kind: 'process_finish', dueDay: 1, payload: {} });
  assert.equal(wakeDelayMs(world, { now: 999 * realMsPerGameDay(null) }), MIN_WAKE_MS);
});

test('пустая очередь не значит вечный сон', () => {
  assert.equal(wakeDelayMs(makeWorld(), { now: 0 }), MAX_WAKE_MS);
});

test('во время хода правителя будильник ждёт предохранитель', () => {
  const world = makeWorld();
  scheduleJob(world, { domainId: 'd1', kind: 'process_finish', dueDay: 0, payload: {} });
  beginRulerTurn(world, Date.now());
  assert.equal(wakeDelayMs(world, { now: Date.now() }), MAX_WAKE_MS);
});

test('удержанные часы не будят мир к сроку дел', () => {
  const world = makeWorld();
  scheduleJob(world, { domainId: 'd1', kind: 'process_finish', dueDay: 0, payload: {} });
  holdClock(world, Date.now());
  assert.equal(wakeDelayMs(world, { now: Date.now() }), MAX_WAKE_MS);
});
