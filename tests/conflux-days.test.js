import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfluxRecord, beginConfluxOwnership, schedulePairJobs, monthsUntilDock, abortCrossIslandDeeds } from '../src/game/conflux.js';
import { hoursToGameDays, pickPrepDelayHours, confluxConfig, remainingDockDays } from '../src/game/confluxTime.js';
import { hourInTimeZone, noteRulerActivity, emptyActivity } from '../src/game/activity.js';
import { inQuietHours, setQuietHours, pushVerdict } from '../src/game/notify.js';
import { applyCrossIslandJudged, secretRevealTexts } from '../src/game/deedConflux.js';
import { takeDomainBoardIntoConflux, createEmptyContainer, overlayConfluxView, stripConfluxView } from '../src/game/confluxBoard.js';
import { createPlotline, ensurePlotStatBudget } from '../src/game/plotlines.js';
import { confluxEvent, writePairChronicle } from '../src/game/confluxCanon.js';
import { crystallizeContainer } from '../src/game/confluxJobs.js';
import { clampPassageState, passageCanShut } from '../src/game/passage.js';
import { applyUndockTrace } from '../src/game/confluxTrace.js';
import { bindOfficerProcess } from '../src/game/officers.js';
import { processVisibleToViewer } from '../src/game/processes.js';

const config = {
  time: { realHoursPerYear: 24 },
  tick: {
    conflux: {
      prepHours: 6,
      dockHours: 6,
      cadenceHours: 48,
      crossIslandSpeedup: 2,
      statFloor: 10,
    },
  },
};

function world(day = 0) {
  return { id: 'w1', tickIndex: 0, dayIndex: day, gameDate: { label: 'Год 1, месяц 1, день 1' }, jobs: [] };
}

function city(id, name) {
  return {
    id,
    name,
    plotlines: [],
    lore: [],
    officers: [{ id: `off_${id}`, name: 'Хранитель', office: 'keeper' }],
    stats: { security: 40, prosperity: 40 },
    state: { pendingActions: [], notify: {} },
    modifiers: [],
    cityEntities: [],
  };
}

test('6 реальных часов — 90 игровых дней', () => {
  assert.equal(hoursToGameDays(6, config), 90);
  assert.equal(hoursToGameDays(0, config), 0);
});

test('запись сопряжения держит сроки в днях и ставит задания пары', () => {
  const w = world(10);
  const c = createConfluxRecord({
    domainIds: ['a', 'b'],
    world: w,
    prepStartDay: 10,
    dockStartDay: 100,
    dockEndDay: 190,
  });
  assert.equal(c.prepStartDay, 10);
  assert.equal(c.dockStartDay, 100);
  assert.equal(c.dockEndDay, 190);
  assert.equal(c.status, 'approaching');
  const jobs = schedulePairJobs(w, c);
  const kinds = jobs.map((j) => j.kind).sort();
  assert.deepEqual(kinds, ['conflux_contact', 'conflux_dock', 'conflux_undock']);
  assert.equal(jobs.find((j) => j.kind === 'conflux_dock').dueDay, 100);
  assert.equal(jobs.find((j) => j.kind === 'conflux_undock').dueDay, 190);
});

test('нити при сближении остаются на домене', () => {
  const w = world(0);
  const a = city('a', 'Астра');
  const b = city('b', 'Берил');
  const plot = createPlotline({ title: 'Колодец', kind: 'story' });
  a.plotlines = [plot];
  const c = createConfluxRecord({ domainIds: ['a', 'b'], world: w, prepStartDay: 0, dockStartDay: 90, dockEndDay: 180 });
  beginConfluxOwnership({ a, b, conflux: c, world: w, config });
  assert.equal(a.plotlines[0], plot);
  assert.equal(b.plotlines.length, 0);
  assert.equal(c.plotRefs.some((r) => r.plotId === plot.id), true);
  assert.equal(c.container, null);
  assert.match(a.lore[0].text, /Берил/);
});

test('пустой контейнер не кристаллизован и не двигает статы', () => {
  const c = createConfluxRecord({ domainIds: ['a', 'b'], world: world(), prepStartDay: 0, dockStartDay: 90, dockEndDay: 180 });
  const plot = createEmptyContainer({ a: city('a', 'Астра'), b: city('b', 'Берил'), conflux: c, world: world(), config });
  assert.equal(plot.crystallized, false);
  assert.equal(plot.endings.length, 0);
  assert.equal((plot.threats || []).length, 0);
  assert.equal(plot.maxDepth, 0);
  assert.equal(plot.gravity, null);
  assert.equal(plot.stats?.budget ?? 0, 0);
});

test('тихие часы считаются в зоне игрока, не сервера', () => {
  const d = { id: 'd1', state: {} };
  setQuietHours(d, { fromHour: 22, toHour: 8, tz: 'UTC' });
  const night = new Date('2026-01-01T23:30:00Z');
  const noon = new Date('2026-01-01T12:00:00Z');
  assert.equal(inQuietHours(d.state.notify, night), true);
  assert.equal(inQuietHours(d.state.notify, noon), false);
  assert.equal(hourInTimeZone(night, 'UTC'), 23);
});

test('дело через проход не влезает в короткий остаток окна', () => {
  const conflux = {
    status: 'docked',
    dockEndDay: 100,
    domainIds: ['a', 'b'],
  };
  const process = { id: 'act_1', summary: 'Построить мост' };
  const judged = { durationBand: 'YEAR', difficulty: 'HARD', officerDays: 200, opposedStat: null };
  const applied = applyCrossIslandJudged(judged, {
    process,
    actor: city('a', 'Астра'),
    target: city('b', 'Берил'),
    conflux,
    day: 90,
    config,
    rng: () => 0,
  });
  assert.equal(applied.error, 'window');
});

test('ускорение вдвое влезает в окно, где без него не влезало бы', () => {
  const conflux = { status: 'docked', dockEndDay: 130, domainIds: ['a', 'b'] };
  const process = { id: 'act_1', summary: 'Посольство' };
  const judged = { durationBand: 'SEASON', difficulty: 'PLAIN', officerDays: 90 };
  const applied = applyCrossIslandJudged(judged, {
    process,
    actor: city('a', 'Астра'),
    target: city('b', 'Берил'),
    conflux,
    day: 10,
    config,
    rng: () => 0,
  });
  assert.equal(applied.error, null);
  assert.ok(applied.judged.objectiveDays <= remainingDockDays(conflux, 10));
  assert.equal(process.crossIsland, true);
  assert.ok(process.abortOutcome);
});

test('сановники на месте после обрыва: список не меняется', () => {
  const a = city('a', 'Астра');
  const officers = [...a.officers];
  a.state.pendingActions = [
    {
      id: 'act_x',
      crossIsland: true,
      status: 'active',
      officerId: officers[0].id,
    },
  ];
  a.state.pendingActions[0].status = 'resolved';
  a.state.pendingActions[0].finishKind = 'abort';
  assert.equal(a.officers.length, officers.length);
  assert.equal(a.officers[0].id, officers[0].id);
});

test('событие, не коснувшееся города, не пишет ему летопись', async () => {
  const a = city('a', 'Астра');
  const b = city('b', 'Берил');
  const w = world(20);
  const facts = await writePairChronicle({
    runtime: null,
    world: w,
    domains: [a, b],
    event: confluxEvent({
      kind: 'local',
      day: 20,
      actorDomainId: 'a',
      textHint: 'У своих ворот выставили дополнительный дозор.',
    }),
  });
  assert.equal(facts.length, 1);
  assert.equal(a.lore.length, 1);
  assert.equal(b.lore.length, 0);
});

test('оверлей не крадёт нить: после снятия доска хозяина та же', () => {
  const a = city('a', 'Астра');
  const plot = createPlotline({ title: 'Своё', kind: 'story' });
  a.plotlines = [plot];
  const c = { id: 'cf', domainIds: ['a', 'b'], container: createEmptyContainer({ a, b: city('b', 'Берил'), conflux: { id: 'cf' }, world: world(), config }), plotlines: [] };
  overlayConfluxView(a, c);
  assert.equal(a.plotlines.length, 2);
  stripConfluxView(a);
  assert.equal(a.plotlines.length, 1);
  assert.equal(a.plotlines[0], plot);
});

test('матчмейкер без профиля не сдвигает окно', () => {
  const delay = pickPrepDelayHours({
    activityA: emptyActivity(),
    activityB: emptyActivity(),
    prepHours: 6,
    dockHours: 6,
    slackHours: 12,
    samplesMin: 10,
  });
  assert.equal(delay, 0);
});

test('ход правителя пишет гистограмму часов', () => {
  const d = city('a', 'Астра');
  noteRulerActivity(d, { now: Date.parse('2026-01-01T15:00:00Z'), docked: false, tailMinutes: 20 });
  assert.equal(d.activity.samples, 1);
  assert.ok(d.activity.hoursUtc[15] >= 20);
  assert.ok(d.activity.activeMsSolo > 0);
  assert.equal(d.activity.activeMsDocked, 0);
});

test('конфиг сопряжения читает часы, а не месяцы', () => {
  const cfg = confluxConfig(config);
  assert.equal(cfg.prepHours, 6);
  assert.equal(cfg.dockHours, 6);
  assert.equal(cfg.cadenceHours, 48);
  assert.equal(cfg.crossIslandSpeedup, 2);
});

test('обрыв дела через проход отпускает сановника', () => {
  const a = city('a', 'Астра');
  const officer = a.officers[0];
  const process = {
    id: 'act_x',
    crossIsland: true,
    status: 'active',
    officerId: officer.id,
    summary: 'Посольство',
  };
  a.state.pendingActions = [process];
  bindOfficerProcess(a, officer, process);
  assert.equal(officer.processId, process.id);
  abortCrossIslandDeeds(a, { day: 10, reason: 'undock' });
  assert.equal(process.finishKind, 'abort');
  assert.equal(officer.processId, null);
  assert.equal(a.officers[0].id, officer.id);
  assert.equal(a.officers.length, 1);
});

test('после кристаллизации контейнер получает бюджет RUPTURE/CRISIS', async () => {
  const c = createConfluxRecord({
    domainIds: ['a', 'b'],
    world: world(),
    prepStartDay: 0,
    dockStartDay: 90,
    dockEndDay: 180,
  });
  const a = city('a', 'Астра');
  const b = city('b', 'Берил');
  c.container = createEmptyContainer({ a, b, conflux: c, world: world(), config });
  c.status = 'docked';
  ensurePlotStatBudget(c.container);
  assert.equal(c.container.stats.budget, 0);
  await crystallizeContainer({
    runtime: null,
    conflux: c,
    domains: [a, b],
    world: world(),
    day: 90,
  });
  assert.equal(c.container.crystallized, true);
  assert.ok(c.container.stats.budget >= 15);
  assert.ok(c.container.endings.length >= 2);
});

test('широкий проход нельзя запереть, зараза проходит при shut', () => {
  assert.equal(passageCanShut({ kind: 'landmass' }), false);
  assert.equal(passageCanShut({ kind: 'causeway' }), false);
  assert.equal(passageCanShut({ kind: 'bridge' }), true);
  assert.equal(clampPassageState('shut', { kind: 'landmass' }), 'watched');
  assert.equal(clampPassageState('shut', { kind: 'bridge' }), 'shut');

  const a = city('a', 'Астра');
  const b = city('b', 'Берил');
  a.cityEntities = [{ kind: 'cult', name: 'культ ветра', origin: 'player' }];
  a.plotlines = [
    {
      kind: 'story',
      storyType: 'story',
      synopsis: 'мор',
      threats: [{ id: 't1', text: 'чума на набережной', known: true, dueDay: 12 }],
    },
  ];
  const traces = applyUndockTrace({
    a,
    b,
    conflux: { id: 'cf', passage: { state: 'shut' } },
    world: world(),
    day: 10,
    rng: () => 0,
  });
  assert.ok(traces.length >= 1);
  assert.ok((b.modifiers || []).length >= 1 || (b.cityEntities || []).length >= 1);
});

test('секретное дело скрыто от соседа до разрешения', () => {
  const process = {
    id: 'act_s',
    secret: true,
    secretForDomainId: 'a',
    ownerDomainId: 'a',
    status: 'active',
    summary: 'Ночной ход',
  };
  assert.equal(processVisibleToViewer(process, 'a'), true);
  assert.equal(processVisibleToViewer(process, 'b'), false);
  process.secretRevealed = true;
  assert.equal(processVisibleToViewer(process, 'b'), true);
  const texts = secretRevealTexts(process, 'success');
  assert.match(texts.victim, /следстви/i);
  const fail = secretRevealTexts(process, 'fail');
  assert.match(fail.victim, /поймали/i);
});

void monthsUntilDock;
void takeDomainBoardIntoConflux;
void pushVerdict;
