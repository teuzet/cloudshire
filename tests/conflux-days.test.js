import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfluxRecord, beginConfluxOwnership, dockConfluxNow, schedulePairJobs, monthsUntilDock, abortCrossIslandDeeds, undockConfluxNow, confluxSummary } from '../src/game/conflux.js';
import { hoursToGameDays, pickPrepDelayHours, confluxConfig, remainingDockDays, rollConfluxSpan, stampGenesisConfluxBan, confluxDue } from '../src/game/confluxTime.js';
import { seedPartingClock, findPartingThreat, PARTING_EVENT } from '../src/game/confluxBoard.js';
import { hourInTimeZone, noteRulerActivity, emptyActivity } from '../src/game/activity.js';
import { inQuietHours, setQuietHours, pushVerdict } from '../src/game/notify.js';
import { applyCrossIslandJudged, secretRevealTexts, isCrossIslandDeed, deedMentionsPartner, isConflictOfInterestDeed } from '../src/game/deedConflux.js';
import { takeDomainBoardIntoConflux, overlayConfluxView, stripConfluxView } from '../src/game/confluxBoard.js';
import { createPlotline } from '../src/game/plotlines.js';
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
      contactSeedAtFraction: 0.05,
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

test('сводка пары считает остаток в днях, а не в месяцах', () => {
  const c = createConfluxRecord({
    domainIds: ['a', 'b'],
    world: world(10),
    prepStartDay: 10,
    dockStartDay: 40,
    dockEndDay: 100,
  });
  const approaching = confluxSummary(c, world(20), {}, 20);
  assert.equal(approaching.daysUntilDock, 20);
  assert.equal(approaching.remainingDockDays, 20);
  assert.equal(approaching.dockSpanDays, 60);
  c.status = 'docked';
  const docked = confluxSummary(c, world(50), {}, 50);
  assert.equal(docked.daysUntilDock, 0);
  assert.equal(docked.daysUntilUndock, 50);
  assert.equal(docked.remainingDockDays, 50);
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
  assert.equal(c.partingDueDay, 180);
  assert.equal(findPartingThreat(c)?.dueDay, 180);
  assert.match(a.lore[0].text, /Берил/);
  assert.match(a.lore[0].text, /90 дн/);
  assert.doesNotMatch(a.lore[0].text, /~\d/);
  assert.doesNotMatch(a.lore[0].text, /слух|примета/);
});

test('свежий город не идёт в матчмейк четыре часа', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const d = { id: 'fresh' };
  stampGenesisConfluxBan(d, { config, now });
  assert.equal(confluxDue(d, now), false);
  assert.equal(confluxDue(d, now + 3 * 3600 * 1000), false);
  assert.equal(confluxDue(d, now + 4 * 3600 * 1000), true);
});

test('стыковка не вешает нить: часы расставания на объекте пары', async () => {
  const w = world(100);
  const a = city('a', 'Астра');
  const b = city('b', 'Берил');
  const c = createConfluxRecord({
    domainIds: ['a', 'b'],
    world: w,
    prepStartDay: 10,
    dockStartDay: 100,
    dockEndDay: 190,
  });
  beginConfluxOwnership({ a, b, conflux: c, world: w, config });
  const out = await dockConfluxNow({
    config,
    runtime: null,
    conflux: c,
    domains: [a, b],
    world: w,
    day: 100,
  });
  assert.equal(c.container, null);
  assert.equal(c.partingDueDay, 190);
  assert.equal(findPartingThreat(c)?.dueDay, 190);
  assert.ok(out.contact?.description);
  assert.ok(c.passage?.text);
  assert.match(a.lore.map((f) => f.text).join('\n'), /Берил|проход|сошл/i);
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

test('дело с целью за проходом — через проход, нить пары сама по себе — нет', () => {
  const conflux = {
    status: 'docked',
    domainIds: ['a', 'b'],
    containerPlotId: 'plot_pair',
    container: { id: 'plot_pair' },
  };
  assert.equal(isCrossIslandDeed({ targetDomainId: 'b' }, conflux, 'a'), true);
  assert.equal(isCrossIslandDeed({ crossIsland: true }, conflux, 'a'), true);
  assert.equal(isCrossIslandDeed({ plotlineId: 'plot_pair', confluxId: 'cf1' }, conflux, 'a'), false);
  assert.equal(isCrossIslandDeed({ confluxId: 'cf1' }, conflux, 'a'), false);
});

test('конфликт интересов читается из текста и из решения оценщика, не из id города', () => {
  assert.equal(deedMentionsPartner('Ночное нападение на Аллерию', 'Аллерия'), true);
  assert.equal(deedMentionsPartner('Починить северную стену', 'Аллерия'), false);
  assert.equal(
    isConflictOfInterestDeed({
      judged: { crossIsland: true },
      process: { summary: 'Починить стену' },
      partnerName: 'Аллерия',
    }),
    true,
  );
  assert.equal(
    isConflictOfInterestDeed({
      judged: { crossIsland: false },
      process: { summary: 'Ночное нападение на Аллерию' },
      partnerName: 'Аллерия',
    }),
    true,
  );
  assert.equal(
    isConflictOfInterestDeed({
      judged: { crossIsland: false },
      process: { summary: 'Починить северную стену' },
      partnerName: 'Аллерия',
    }),
    false,
  );
});

test('штурм сравнивает профильный стат дела с обороной соседа', () => {
  const conflux = { status: 'docked', dockEndDay: 400, domainIds: ['a', 'b'] };
  const strong = applyCrossIslandJudged(
    { durationBand: 'WEEKS', difficulty: 'HARD', opposedStat: 'security' },
    {
      process: { linkedStats: ['security'] },
      actor: { stats: { security: 42, prosperity: 80 } },
      target: { id: 'b', stats: { security: 77, prosperity: 20 } },
      conflux,
      day: 10,
      config,
      rng: () => 0,
    },
  );
  assert.equal(strong.error, null);
  assert.equal(strong.judged.durationBand, 'SEASON');
  assert.equal(strong.judged.difficulty, 'SEVERE');

  const weak = applyCrossIslandJudged(
    { durationBand: 'WEEKS', difficulty: 'HARD', opposedStat: 'security' },
    {
      process: { linkedStats: ['security'] },
      actor: { stats: { security: 77, prosperity: 20 } },
      target: { id: 'b', stats: { security: 42, prosperity: 80 } },
      conflux,
      day: 10,
      config,
      rng: () => 0,
    },
  );
  assert.equal(weak.judged.durationBand, 'DAYS');
  assert.equal(weak.judged.difficulty, 'PLAIN');
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

test('оверлей больше не кладёт карточку пары на доску города', () => {
  const a = city('a', 'Астра');
  const plot = createPlotline({ title: 'Своё', kind: 'story' });
  a.plotlines = [plot];
  const c = { id: 'cf', domainIds: ['a', 'b'], container: null, plotlines: [] };
  overlayConfluxView(a, c);
  assert.equal(a.plotlines.length, 1);
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

test('естественное окно — подготовка 1–3 месяца и стыковка 3–6', () => {
  const span = rollConfluxSpan(
    { tick: { conflux: { prepDaysMin: 30, prepDaysMax: 90, dockDaysMin: 90, dockDaysMax: 180 } } },
    () => 0,
  );
  assert.equal(span.prepDays, 30);
  assert.equal(span.dockDays, 90);
  const hi = rollConfluxSpan(
    { tick: { conflux: { prepDaysMin: 30, prepDaysMax: 90, dockDaysMin: 90, dockDaysMax: 180 } } },
    () => 0.999,
  );
  assert.equal(hi.prepDays, 90);
  assert.equal(hi.dockDays, 180);
});

test('конфиг сопряжения читает каденцию и сроки в днях', () => {
  const cfg = confluxConfig(config);
  assert.equal(cfg.cadenceHours, 48);
  assert.equal(cfg.crossIslandSpeedup, 2);
  assert.equal(cfg.contactSeedAtFraction, 0.05);
  assert.ok(cfg.prepDaysMin >= 1);
  assert.ok(cfg.dockDaysMin >= 1);
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

test('дело без флага, но с needsPassage, обрывается при расставании', () => {
  const a = city('a', 'Астра');
  const officer = a.officers[0];
  const process = {
    id: 'act_def',
    summary: 'Подготовить оборону к сопряжению с Берил',
    status: 'active',
    officerId: officer.id,
    needsPassage: true,
  };
  a.state.pendingActions = [process];
  bindOfficerProcess(a, officer, process);
  abortCrossIslandDeeds(a, { day: 10, reason: 'undock' });
  assert.equal(process.finishKind, 'abort');
  assert.equal(officer.processId, null);
});

test('расставание: судьба оборванного дела попадает в большую хронику, архив остаётся', async () => {
  const w = world(100);
  w.gameDate = { label: 'Год 1, месяц 4, день 10' };
  const a = city('a', 'Астра');
  const b = city('b', 'Берил');
  a.stats = { security: 40, prosperity: 40 };
  b.stats = { security: 40, prosperity: 40 };
  const c = createConfluxRecord({
    domainIds: ['a', 'b'],
    world: w,
    prepStartDay: 0,
    dockStartDay: 10,
    dockEndDay: 100,
  });
  c.status = 'docked';
  c.container = null;
  seedPartingClock(c, { dockEndDay: 100 });
  c.forecast = { a: 'Астра в руинах.', b: 'Берил уходит с добычей.', neutral: 'Один берег занял другой.' };
  const officer = a.officers[0];
  const process = {
    id: 'act_x',
    crossIsland: true,
    status: 'active',
    officerId: officer.id,
    summary: 'Маршал у прохода',
    abortOutcome: 'успеть вернуться с тем, что вынесли',
  };
  a.state.pendingActions = [process];
  bindOfficerProcess(a, officer, process);
  let seen = '';
  const runtime = {
    async run({ tools, userMessages, agentId }) {
      const text = userMessages?.map((m) => m.content).join('\n') || '';
      if (agentId === 'undockChronicle') {
        seen = text;
        const submit = tools.find((t) => t.name === 'submit_undock');
        await submit.handler({
          text:
            'Астра и Берил разошлись в небе: чужой край ушёл в даль, пути больше нет. ' +
            'Маршал Астры успел вернуться с тем, что вынесли с прохода. Астра в руинах.',
        });
      }
    },
  };
  await undockConfluxNow({ runtime, conflux: c, domains: [a, b], world: w, day: 100, config, rng: () => 0 });
  assert.match(seen, /Маршал у прохода/);
  assert.equal(c.status, 'ended');
  assert.ok((c.lore || []).some((f) => /разошлись/.test(f.text)));
  assert.equal(c.container, null);
  assert.equal(process.finishKind, 'abort');
  assert.ok((w.jobs || []).some((j) => j.kind === 'seed_appear'));
});

test('кристаллизации контейнера больше нет', async () => {
  const c = createConfluxRecord({
    domainIds: ['a', 'b'],
    world: world(),
    prepStartDay: 0,
    dockStartDay: 90,
    dockEndDay: 180,
  });
  c.container = null;
  c.status = 'docked';
  const out = await crystallizeContainer({
    runtime: null,
    conflux: c,
    domains: [city('a', 'Астра'), city('b', 'Берил')],
    world: world(),
    day: 90,
  });
  assert.equal(out, null);
  assert.equal(c.container, null);
});

test('часы расставания — поле пары, не угроза-сюжет', () => {
  const c = createConfluxRecord({
    domainIds: ['a', 'b'],
    world: world(),
    prepStartDay: 0,
    dockStartDay: 90,
    dockEndDay: 180,
  });
  c.container = { id: 'old', endings: [{ id: 'end_0', kind: 'GOOD_ENDING', text: 'договор' }] };
  const clock = seedPartingClock(c, { dockEndDay: 180 });
  assert.equal(clock, 180);
  assert.equal(c.partingDueDay, 180);
  assert.equal(findPartingThreat(c).eventKind, PARTING_EVENT);
  assert.equal(findPartingThreat(c).dueDay, 180);
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
