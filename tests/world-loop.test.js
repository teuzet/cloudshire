import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEventFact,
  schedulePressureJob,
  ensurePlotObligations,
  closePlotWithJobs,
  resolveDeedEvent,
  fireThreatEvent,
  firePressureEvent,
  seedAttemptEvent,
  seedAppearEvent,
  attachReport,
  drainDomainJobs,
  armDomainSchedule,
  scheduleDeedJob,
  cancelDeedJobs,
} from '../src/game/worldLoop.js';
import { resetPressure } from '../src/game/pressure.js';
import { createThreat, attachThreat, liveThreats, findThreat } from '../src/game/threats.js';
import { startDeed } from '../src/game/deeds.js';
import { cityRules, markRuleDeed } from '../src/game/cityRules.js';
import { addPriestOrder } from '../src/game/priestOrders.js';
import { seedQueue, enqueueSeedRequest } from '../src/game/seedSchedule.js';
import { jobList, dueJobs } from '../src/game/scheduler.js';

const config = {
  stats: [{ id: 'prosperity' }, { id: 'security' }],
  tick: { plot: { roll: {} } },
};

function makeWorld() {
  return { id: 'w1', tickIndex: 4, dayIndex: 120, jobs: [] };
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
    endings: [{ id: 'e1', kind: 'BAD_ENDING', text: 'Северное крыло рушится вместе с людьми' }],
    ...extra,
  };
}

function makeDomain({ plots = [], processes = [] } = {}) {
  return {
    id: 'd1',
    name: 'Тихая Гряда',
    stats: { prosperity: 70, security: 55 },
    lore: [],
    officers: [],
    characters: [{ name: 'Малуша', dialogHistory: [] }],
    plotlines: plots,
    state: { pendingActions: processes, mana: 50, faith: 60, manaDay: 120 },
  };
}

/** Дело, привязанное к нити и уже дошедшее до срока. */
function attachDeed(domain, plot, extra = {}) {
  const process = startDeed(
    {
      id: 'proc1',
      summary: 'укрепить опору',
      status: 'active',
      linkedStats: ['prosperity'],
      plotlineId: plot.id,
      ...extra,
    },
    { day: 100, judged: { durationBand: 'WEEKS', difficulty: 'PLAIN', objectiveDays: 20 } },
  );
  domain.state.pendingActions.push(process);
  plot.relatedProcessIds.push(process.id);
  return process;
}

const silentLog = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** Рантайм, который никогда не зовут: проверяем, что движок считает сам. */
const noRuntime = null;

/**
 * Рантайм с одним живым агентом — хронистом. Остальные вызовы (автор угроз,
 * разбор) молча ничего не возвращают: движок обязан обойтись без них.
 */
function chronicleRuntime(text, calls = [], agentIds = []) {
  return {
    run: async (opts) => {
      if (
        opts.agentId !== 'chronicler' &&
        opts.agentId !== 'chronicleFinale' &&
        opts.agentId !== 'chronicleDeed' &&
        opts.agentId !== 'chronicleThreat' &&
        opts.agentId !== 'errandChronicler'
      ) {
        return {};
      }
      agentIds.push(opts.agentId);
      calls.push(opts.userMessages[0].content);
      await opts.tools[0].handler({ entry: text });
      return {};
    },
  };
}

// ───────────────────────────── запись хроники ─────────────────────────────

test('запись события помечена игровым днём и нитью', () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const fact = appendEventFact(domain, world, {
    text: 'Опора села ещё на палец',
    plotId: plot.id,
    day: 137,
  });
  assert.equal(fact.day, 137);
  assert.equal(fact.sourcePlotId, 'p1');
  assert.match(fact.gameDateLabel, /Год 1, месяц 5, день 18/);
  assert.equal(domain.lore.length, 1);
  assert.ok(plot.chronicleIds.includes(fact.id));
});

// ───────────────────────────── очередь угроз ─────────────────────────────

test('шкала встаёт в очередь на день заполнения', () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  resetPressure(plot, 120, null, () => 0);
  plot.pressure.fillDays = 40;
  const job = schedulePressureJob(world, domain, plot);
  assert.equal(job.kind, 'pressure_fire');
  assert.equal(job.dueDay, 160);
  assert.equal(job.payload.plotId, plot.id);
});

test('повторная постановка шкалы не плодит второе задание', () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  resetPressure(plot, 120, null, () => 0);
  plot.pressure.fillDays = 40;
  schedulePressureJob(world, domain, plot);
  plot.pressure.fillDays = 80;
  schedulePressureJob(world, domain, plot);
  const pending = jobList(world).filter((j) => j.state === 'pending' && j.kind === 'pressure_fire');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].dueDay, 200);
});

test('живая история без пула получает шкалу, но не выдумывает беды', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const created = await ensurePlotObligations({
    runtime: noRuntime,
    domain,
    world,
    plot,
    day: 120,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(created.length, 0);
  assert.equal(jobList(world).filter((j) => j.kind === 'pressure_fire').length, 1);
});

test('закрытие нити отменяет привязанные дела и освобождает сановника', () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  domain.officers = [{ id: 'off1', office: 'marshal', name: 'Орена', processId: 'proc-live' }];
  const world = makeWorld();
  const live = attachDeed(domain, plot, { id: 'proc-live', summary: 'охота на склоне', officerId: 'off1' });
  const paused = attachDeed(domain, plot, { id: 'proc-pause', summary: 'вывоз деревушки', status: 'paused' });
  const done = attachDeed(domain, plot, { id: 'proc-done', summary: 'уже кончилось', status: 'resolved' });
  const other = startDeed(
    { id: 'proc-other', summary: 'чинить свою стену', status: 'active', plotlineId: 'другая' },
    { day: 100, judged: { durationBand: 'WEEKS', difficulty: 'PLAIN', objectiveDays: 20 } },
  );
  domain.state.pendingActions.push(other);
  scheduleDeedJob(world, domain, live);
  scheduleDeedJob(world, domain, paused);
  closePlotWithJobs(domain, world, plot, { day: 140, reason: 'depth' });
  assert.equal(live.status, 'cancelled');
  assert.equal(live.cancelReason, 'история закрыта');
  assert.equal(paused.status, 'cancelled');
  assert.equal(done.status, 'resolved');
  assert.equal(other.status, 'active');
  assert.equal(domain.officers[0].processId, null);
  assert.equal(jobList(world).filter((j) => j.state === 'pending' && j.kind === 'process_finish').length, 0);
});

test('закрытие нити гасит её беды и задания', () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const t = attachThreat(plot, createThreat({ plot, text: 'обвал', band: 'WEEKS', day: 120, rng: () => 0.5 }));
  resetPressure(plot, 120, null, () => 0);
  schedulePressureJob(world, domain, plot);
  const fact = appendEventFact(domain, world, { text: 'кончилось', plotId: plot.id, day: 140 });
  closePlotWithJobs(domain, world, plot, { day: 140, reason: 'depth', fact });
  assert.equal(domain.plotlines.length, 0);
  assert.equal(findThreat(plot, t.id).status, 'cancelled');
  assert.equal(dueJobs(world, 9999).length, 0);
  assert.equal(fact.plotClosed, true);
});

// ───────────────────────────── исход дела ─────────────────────────────

test('DIRECT-успех добавляет глубину и пишет одну запись', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  attachDeed(domain, plot, { plotEngagement: 'DIRECT', difficulty: 'HARD', durationBand: 'SEASON' });
  const res = await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.occasion, 'дело');
  assert.equal(res.applied.alignment, 'DIRECT');
  assert.ok(plot.depth > 0, 'работа вложена');
  assert.equal(domain.lore.length, 1);
  assert.equal(domain.lore[0].day, 130);
  assert.equal(domain.lore[0].depthGain, plot.depth);
  assert.equal(domain.lore[0].woundBudget, undefined);
  assert.equal(domain.state.pendingActions[0].status, 'resolved');
});

test('DIRECT-успех при набранной глубине закрывает историю', async () => {
  const plot = makePlot({ depth: 2.8, maxDepth: 3 });
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  attachDeed(domain, plot, { plotEngagement: 'DIRECT', difficulty: 'HARD', durationBand: 'SEASON' });
  const res = await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.closed, true);
  assert.equal(plot.ending.kind, 'GOOD_ENDING');
  assert.equal(domain.plotlines.length, 0);
  assert.ok(domain.lore[0].completionBudget >= 1 && domain.lore[0].completionBudget <= 4);
  assert.equal(seedQueue(domain).length, 0);
});

test('DIRECT-провал стоит жизни, а не глубины', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot], processes: [] });
  domain.stats.prosperity = 5;
  const world = makeWorld();
  attachDeed(domain, plot, { plotEngagement: 'DIRECT', difficulty: 'EXTREME' });
  const res = await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.01,
    log: silentLog,
  });
  assert.equal(res.outcome.finish, 'fail');
  assert.equal(plot.depth, 0);
  assert.equal(plot.failCount, 0);
});

test('RELEVANT-успех снимает беду и оставляет шкалу', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat({ plot, text: 'обвал лестницы', band: 'SEASON', day: 100, rng: () => 0.5 }),
  );
  resetPressure(plot, 100, null, () => 0);
  schedulePressureJob(world, domain, plot);
  attachDeed(domain, plot, { plotEngagement: 'RELEVANT', threatId: threat.id, difficulty: 'PLAIN' });
  await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(findThreat(plot, threat.id).status, 'averted');
  assert.equal(liveThreats(plot).length, 0);
  assert.equal(jobList(world).filter((j) => j.state === 'pending' && j.kind === 'pressure_fire').length, 1);
});

test('DANGEROUS-крит роняет беду немедленно', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat({ plot, text: 'дом рухнет', band: 'YEAR', day: 100, rng: () => 0.5 }),
  );
  attachDeed(domain, plot, {
    plotEngagement: 'DANGEROUS',
    threatId: threat.id,
    difficulty: 'TRIVIAL',
    blessed: true,
  });
  const res = await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.99,
    log: silentLog,
  });
  assert.equal(res.outcome.finish, 'crit');
  assert.equal(findThreat(plot, threat.id).status, 'fired');
  assert.equal(domain.lore[0].woundBudget, 2);
  assert.equal(threat.statBudget, 2);
  assert.equal(domain.lore[0].depthGain, undefined);
  assert.equal(plot.failCount, 1);
});

test('запись о деле пишет хронист, а не шаблон движка', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  attachDeed(domain, plot, { plotEngagement: 'DIRECT', difficulty: 'PLAIN', goal: 'найти причину гула' });
  const calls = [];
  await resolveDeedEvent({
    config,
    runtime: chronicleRuntime('Ступени вскрыли и нашли старый водоотводный ход.', calls),
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(domain.lore[0].text, 'Ступени вскрыли и нашли старый водоотводный ход.');
  assert.equal(domain.lore[0].author, 'engine:deed');
  assert.equal(calls.length, 1, 'хрониста зовут ровно один раз на событие');
  assert.match(calls[0], /найти причину гула/);
  assert.match(calls[0], /не пиши, что вопрос закрыт/i, 'глубина ещё не набрана');
});

test('запись о деле не называет дело по имени, даже если модель молчит', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  attachDeed(domain, plot, {
    plotEngagement: 'DIRECT',
    difficulty: 'PLAIN',
    summary: 'Свести спорящих о воде',
    goal: 'помирить гряд-ников и лес-ников',
  });
  await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.5,
    log: silentLog,
  });
  const text = domain.lore[0].text;
  assert.doesNotMatch(text, /Свести спорящих о воде/, 'название дела — метагейм');
  assert.doesNotMatch(text, /«|»/);
  assert.match(text, /помирить гряд-ников/);
});

test('провал, переполнивший шкалу, пишет беду и называет дело причиной', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat({ plot, text: 'Пыль забьёт водосборный сток', stage: 0, final: false, day: 100 }),
  );
  resetPressure(plot, 130, null, () => 0);
  plot.pressure.value = 80;
  attachDeed(domain, plot, {
    plotEngagement: 'DIRECT',
    summary: 'укрепить опору',
    goal: 'удержать северное крыло',
  });
  const calls = [];
  const agentIds = [];
  await resolveDeedEvent({
    config,
    runtime: chronicleRuntime('Водосбор забило пылью после неудачного ремонта.', calls, agentIds),
    domain,
    world,
    day: 130,
    processId: 'proc1',
    forcedFinish: 'fail',
    log: silentLog,
  });
  assert.equal(findThreat(plot, threat.id).status, 'fired');
  assert.equal(plot.failCount, 1);
  assert.equal(domain.plotlines.length, 1);
  assert.deepEqual(agentIds, ['chronicleThreat']);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /укрепить опору/);
  assert.match(calls[0], /Пыль забьёт водосборный сток/);
  assert.match(calls[0], /ПРИВЕЛО К СОБЫТИЮ/);
  assert.match(calls[0], /История не закрыта/);
  assert.ok(calls[0].indexOf('укрепить опору') < calls[0].indexOf('Пыль забьёт'));
});

test('провал, сорвавший концовку, пишет её текст, а не другую развязку', async () => {
  const plot = makePlot({ failCount: 2, maxFails: 2, depth: 0 });
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat({ plot, text: 'Ночной выход обрушит лавовый склон', final: true, day: 100 }),
  );
  resetPressure(plot, 130, null, () => 0);
  plot.pressure.value = 90;
  attachDeed(domain, plot, {
    plotEngagement: 'DIRECT',
    summary: 'подготовить ночной выход',
    goal: 'дойти до логова',
  });
  const calls = [];
  const agentIds = [];
  const res = await resolveDeedEvent({
    config,
    runtime: chronicleRuntime('Ночной выход не дошёл, и склон обрушился.', calls, agentIds),
    domain,
    world,
    day: 130,
    processId: 'proc1',
    forcedFinish: 'fail',
    log: silentLog,
  });
  assert.equal(res.closed, true);
  assert.equal(plot.ending.kind, 'BAD_ENDING');
  assert.equal(findThreat(plot, threat.id).status, 'fired');
  assert.deepEqual(agentIds, ['chronicleFinale']);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /подготовить ночной выход/);
  assert.match(calls[0], /Ночной выход обрушит лавовый склон/);
  assert.match(calls[0], /ПРИВЕЛО К СОБЫТИЮ/);
  assert.match(calls[0], /GRAVITY: CRISIS/);
  assert.ok(calls[0].indexOf('подготовить ночной выход') < calls[0].indexOf('Ночной выход обрушит'));
});

function pickingRuntime({ neutralId, chronicle, calls = [], agentIds = [] }) {
  return {
    run: async (opts) => {
      agentIds.push(opts.agentId);
      calls.push(opts.userMessages[0].content);
      if (opts.agentId === 'neutralPick') {
        await opts.tools[0].handler({ threatId: neutralId });
        return {};
      }
      if (
        opts.agentId === 'chronicleFinale' ||
        opts.agentId === 'chronicleThreat' ||
        opts.agentId === 'chronicleDeed' ||
        opts.agentId === 'chronicler' ||
        opts.agentId === 'errandChronicler'
      ) {
        await opts.tools[0].handler({ entry: chronicle });
        return {};
      }
      return {};
    },
  };
}

test('нейтральная концовка — та плохая, которую выбрал агент, и хронист об этом знает', async () => {
  const plot = makePlot({ failCount: 2, maxFails: 2, depth: 1.6 });
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const harsh = attachThreat(
    plot,
    createThreat({ plot, text: 'Склон хоронит квартал вместе с людьми', final: true, day: 100 }),
  );
  const milder = attachThreat(
    plot,
    createThreat({ plot, text: 'Зверя уводят за стену, и северные дворы пустеют', final: true, day: 100 }),
  );
  resetPressure(plot, 130, null, () => 0);
  plot.pressure.value = 90;
  attachDeed(domain, plot, {
    plotEngagement: 'DIRECT',
    summary: 'удержать северные ворота',
    goal: 'не выпустить колонну',
  });
  const calls = [];
  const agentIds = [];
  const res = await resolveDeedEvent({
    config,
    runtime: pickingRuntime({
      neutralId: milder.id,
      chronicle: 'Зверя увели за стену, и северные дворы опустели.',
      calls,
      agentIds,
    }),
    domain,
    world,
    day: 130,
    processId: 'proc1',
    forcedFinish: 'fail',
    log: silentLog,
  });
  assert.equal(res.closed, true);
  assert.equal(plot.ending.kind, 'NEUTRAL_ENDING');
  assert.equal(milder.status, 'fired');
  assert.equal(harsh.status, 'cancelled');
  assert.deepEqual(agentIds, ['neutralPick', 'chronicleFinale']);
  assert.match(calls[0], /Склон хоронит квартал/);
  assert.match(calls[0], /Зверя уводят за стену/);
  assert.match(calls[0], /самую хорошую из плохих/);
  const finale = calls[1];
  assert.match(finale, /Это нейтральная концовка/);
  assert.match(finale, /Зверя уводят за стену/);
  assert.match(finale, /удержать северные ворота/);
  assert.doesNotMatch(finale, /Склон хоронит квартал/);
});

test('шкала на нейтральной концовке зовёт того же агента, а не жребий', async () => {
  const plot = makePlot({ failCount: 2, maxFails: 2, depth: 2 });
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const harsh = attachThreat(
    plot,
    createThreat({ plot, text: 'Обвал засыпает террасы', final: true, day: 100 }),
  );
  const milder = attachThreat(
    plot,
    createThreat({ plot, text: 'Стадо уводят и больше не пасут у склона', final: true, day: 100 }),
  );
  resetPressure(plot, 130, null, () => 0);
  plot.pressure.value = 100;
  const calls = [];
  const agentIds = [];
  const res = await firePressureEvent({
    runtime: pickingRuntime({
      neutralId: milder.id,
      chronicle: 'Стадо увели, и у склона больше не пасли.',
      calls,
      agentIds,
    }),
    domain,
    world,
    day: 130,
    plot,
    rng: () => 0,
    log: silentLog,
  });
  assert.equal(res.closed, true);
  assert.equal(res.endingKind, 'NEUTRAL_ENDING');
  assert.equal(milder.status, 'fired');
  assert.equal(harsh.status, 'cancelled');
  assert.deepEqual(agentIds, ['neutralPick', 'chronicleFinale']);
  assert.match(calls[1], /Это нейтральная концовка/);
  assert.match(calls[1], /Стадо уводят/);
});

test('сработавшая беда ложится в хронику прошедшим временем', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat({ plot, text: 'Пыль забьёт водосборный сток', band: 'WEEKS', day: 100, rng: () => 0.5 }),
  );
  const calls = [];
  await fireThreatEvent({
    runtime: chronicleRuntime('Водосборный сток у западных каменоломен забило известковой пылью.', calls),
    domain,
    world,
    day: 140,
    plotId: plot.id,
    threatId: threat.id,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(domain.lore[0].text, 'Водосборный сток у западных каменоломен забило известковой пылью.');
  assert.match(calls[0], /В БУДУЩЕМ ВРЕМЕНИ/);
  assert.match(calls[0], /Пыль забьёт водосборный сток/);
});

test('принудительный исход ставится как сказали, без броска', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  domain.stats.prosperity = 95;
  const world = makeWorld();
  attachDeed(domain, plot, { plotEngagement: 'DIRECT', difficulty: 'TRIVIAL' });
  const res = await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'proc1',
    rng: () => 0.99,
    forcedFinish: 'fail',
    log: silentLog,
  });
  assert.equal(res.outcome.finish, 'fail');
  assert.equal(plot.failCount, 0);
  assert.equal(plot.depth, 0);
  assert.equal(domain.state.pendingActions[0].status, 'failed');
});

test('принудительный исход снимает паузу', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const process = attachDeed(domain, plot, { plotEngagement: 'DIRECT' });
  process.status = 'paused';
  const res = await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: process.id,
    forcedFinish: 'ok',
    log: silentLog,
  });
  assert.equal(res.skipped, undefined);
  assert.equal(res.outcome.finish, 'ok');
  assert.equal(process.status, 'resolved');
});

test('дело, которого нет или которое не идёт, пропускается', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const gone = await resolveDeedEvent({ config, domain, world, day: 130, processId: 'нет', log: silentLog });
  assert.equal(gone.skipped, 'not_found');
  const p = attachDeed(domain, plot);
  p.status = 'paused';
  const paused = await resolveDeedEvent({ config, domain, world, day: 130, processId: p.id, log: silentLog });
  assert.equal(paused.skipped, 'not_active:paused');
  assert.equal(domain.lore.length, 0, 'запись о паузе не пишется');
});

test('дело о постоянном порядке кладёт след в изменения города, а не в глубину', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  const process = markRuleDeed(
    startDeed({ id: 'proc1', summary: 'объявить удвоенную подать', status: 'active', linkedStats: ['prosperity'] }, {
      day: 100,
      judged: { durationBand: 'DAYS', difficulty: 'PLAIN', objectiveDays: 10 },
    }),
    { text: 'Подать удвоена' },
  );
  domain.state.pendingActions.push(process);
  const res = await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 110,
    processId: 'proc1',
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.rule.applied, true);
  assert.equal(cityRules(domain)[0].text, 'Подать удвоена');
  assert.match(domain.lore[0].text, /Подать удвоена/);
  assert.equal(domain.lore[0].author, 'engine:rule');
});

test('завершённое поручение само историю не сеет', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  const process = startDeed(
    {
      id: 'err1',
      summary: 'белый обелиск',
      goal: 'поставить камень',
      detail: 'на площади',
      status: 'active',
    },
    { day: 100, judged: { durationBand: 'YEARS', difficulty: 'SEVERE', objectiveDays: 360 } },
  );
  domain.state.pendingActions.push(process);
  await resolveDeedEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 130,
    processId: 'err1',
    forcedFinish: 'crit',
    rng: () => 0,
    log: silentLog,
  });
  assert.equal(seedQueue(domain).length, 0);
  assert.equal(jobList(world).some((j) => j.kind === 'seed_appear'), false);
});

// ───────────────────────────── угроза сработала ─────────────────────────────

test('срабатывание беды пишет её текст и тратит жизнь', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat({ plot, text: 'Лестница северного крыла обвалилась', band: 'WEEKS', day: 100, rng: () => 0.5 }),
  );
  const res = await fireThreatEvent({
    runtime: noRuntime,
    domain,
    world,
    day: 140,
    plotId: plot.id,
    threatId: threat.id,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.occasion, 'угроза');
  assert.equal(plot.failCount, 1);
  assert.equal(domain.lore[0].text, 'Лестница северного крыла обвалилась');
  assert.equal(domain.lore[0].day, 140);
  assert.equal(domain.lore[0].woundBudget, 2);
  assert.equal(domain.lore[0].statPocket, 'threat');
});

test('последняя жизнь кончилась — история закрыта плохой концовкой', async () => {
  const plot = makePlot({ failCount: 2, maxFails: 2 });
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat({
      plot,
      text: 'Северное крыло рухнет на мостки',
      band: 'WEEKS',
      day: 100,
      endingId: 'e1',
      rng: () => 0.5,
    }),
  );
  const calls = [];
  const agentIds = [];
  const res = await fireThreatEvent({
    runtime: chronicleRuntime('Северное крыло рухнуло, и с ним люди.', calls, agentIds),
    domain,
    world,
    day: 140,
    plotId: plot.id,
    threatId: threat.id,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.closed, true);
  assert.equal(res.occasion, 'развязка');
  assert.equal(plot.ending.kind, 'BAD_ENDING');
  assert.equal(domain.lore[0].woundBudget, 2);
  assert.equal(domain.lore[0].plotClosed, true);
  assert.equal(domain.lore[0].statPocket, 'ending');
  assert.equal(domain.plotlines.length, 0);
  assert.deepEqual(agentIds, ['chronicleFinale'], 'развязку пишет финальный агент, не хронист');
  assert.match(calls[0], /Северное крыло рухнет на мостки/);
  assert.match(calls[0], /утратой/);
  assert.match(calls[0], /до 900 символов/);
});

test('концовочная беда берёт минус масштаба истории', async () => {
  const plot = makePlot({ failCount: 2, maxFails: 2 });
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const threat = attachThreat(
    plot,
    createThreat(plot, { text: 'Северное крыло рухнет на мостки', final: true, day: 100 }),
  );
  const res = await fireThreatEvent({
    runtime: noRuntime,
    domain,
    world,
    day: 140,
    plotId: plot.id,
    threatId: threat.id,
    rng: () => 0,
    log: silentLog,
  });
  assert.equal(res.closed, true);
  assert.equal(domain.lore[0].woundBudget, 4);
  assert.equal(threat.statBudget, 4);
});

test('сработавшая беда снимает остальные беды стадии', async () => {
  const plot = makePlot({ gravity: 'RUPTURE', maxFails: 3 });
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const fired = attachThreat(
    plot,
    createThreat({ plot, text: 'обвал', band: 'WEEKS', day: 100, rng: () => 0.5 }),
  );
  const survivor = attachThreat(
    plot,
    createThreat({ plot, text: 'фундамент', band: 'SEASON', day: 100, rng: () => 0.5 }),
  );
  await fireThreatEvent({
    runtime: noRuntime,
    domain,
    world,
    day: 140,
    plotId: plot.id,
    threatId: fired.id,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(survivor.status, 'cancelled');
  assert.equal(plot.stage, 1);
});

test('непоследняя беда историю не закрывает', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const resolution = attachThreat(
    plot,
    createThreat({ plot, text: 'Трещина перестала расти сама', day: 100 }),
  );
  const res = await fireThreatEvent({
    runtime: noRuntime,
    domain,
    world,
    day: 200,
    plotId: plot.id,
    threatId: resolution.id,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.closed, false);
  assert.equal(plot.failCount, 1);
});

test('беда закрытой или пропавшей нити не срабатывает', async () => {
  const world = makeWorld();
  const domain = makeDomain({ plots: [] });
  const res = await fireThreatEvent({
    domain,
    world,
    day: 140,
    plotId: 'p1',
    threatId: 'thr1',
    log: silentLog,
  });
  assert.equal(res.skipped, 'plot_gone');
});

// ───────────────────────────── посев ─────────────────────────────

test('попытка посева всегда ставит следующую попытку', () => {
  const domain = makeDomain();
  const world = makeWorld();
  seedAttemptEvent({ config, domain, world, day: 120, rng: () => 0.999, log: silentLog });
  const attempts = jobList(world).filter((j) => j.kind === 'seed_attempt' && j.state === 'pending');
  assert.equal(attempts.length, 1);
  assert.ok(attempts[0].dueDay >= 120 + 15);
  assert.ok(attempts[0].dueDay <= 120 + 20);
});

test('удачная попытка ставит появление в тот же день и двигает температуру зерна', () => {
  const domain = makeDomain();
  const world = makeWorld();
  domain.state.gravitySchedule = ['SITUATION'];
  domain.state.gravityScheduleAt = 0;
  const decision = seedAttemptEvent({ config, domain, world, day: 120, rng: () => 0, log: silentLog });
  assert.equal(decision.seed, true);
  assert.equal(decision.gravity, 'SITUATION');
  assert.equal(decision.source, 'genesis');
  assert.equal(seedQueue(domain).length, 1);
  assert.equal(seedQueue(domain)[0].appearDay, 120);
  const appear = jobList(world).filter((j) => j.kind === 'seed_appear');
  assert.equal(appear.length, 1);
  assert.equal(appear[0].dueDay, 120);
  assert.equal(domain.state.seedTemp.genesis, 0);
  assert.equal(domain.state.seedTemp.void, 2);
  assert.equal(domain.state.gravityScheduleAt, 1);
});

test('следующий масштаб не сеется, пока под него нет слотов', () => {
  const plots = [makePlot({ id: 'p1', gravity: 'CRISIS', maxFails: 3 })];
  const domain = makeDomain({ plots });
  const world = makeWorld();
  domain.state.gravitySchedule = ['EPISODE'];
  domain.state.gravityScheduleAt = 0;
  const decision = seedAttemptEvent({ config, domain, world, day: 120, rng: () => 0, log: silentLog });
  assert.equal(decision.seed, false);
  assert.equal(decision.reason, 'slots');
  assert.equal(seedQueue(domain).length, 0);
  assert.equal(domain.state.gravityScheduleAt, 0);
  assert.equal(domain.state.seedTemp.genesis, 1);
});

test('полная доска переносит появление, а не выбрасывает заявку', async () => {
  const plots = [1, 2, 3, 4].map((i) => makePlot({ id: `p${i}` }));
  const domain = makeDomain({ plots });
  const world = makeWorld();
  const req = enqueueSeedRequest(domain, { source: 'void', day: 120, delayDays: 0 });
  const res = await seedAppearEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 120,
    requestId: req.id,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.skipped, 'board_full');
  assert.equal(res.postponed, true);
  assert.equal(seedQueue(domain).length, 1, 'заявка ждёт, а не гибнет');
  assert.ok(seedQueue(domain)[0].appearDay > 120);
});

test('заявка старше полутора лет выбрасывается', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  const req = enqueueSeedRequest(domain, { source: 'void', day: 0, delayDays: 0 });
  const res = await seedAppearEvent({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 800,
    requestId: req.id,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(res.skipped, 'too_old');
  assert.equal(seedQueue(domain).length, 0);
});

// ───────────────────────────── доклад ─────────────────────────────

test('доклад по наказу едет попутно с событием, а не по расписанию', () => {
  const domain = makeDomain();
  const { order } = addPriestOrder(domain, { subject: 'как идут дела в порту', day: 100 });
  const event = { occasion: 'дело', fact: { text: 'каменщики закрепили опору' } };
  attachReport(domain, event, { day: 130 });
  assert.equal(event.reportSubject, 'как идут дела в порту');
  assert.equal(event.reportOrderId, order.id);
  assert.equal(order.lastDay, 130);
  assert.equal(
    jobList(domain.world || { jobs: [] }).length,
    0,
    'наказ не заводит собственных заданий: срока у него нет',
  );
});

test('второе событие подряд ту же тему не поднимает', () => {
  const domain = makeDomain();
  addPriestOrder(domain, { subject: 'порт', day: 100 });
  const first = { occasion: 'дело', fact: { text: 'первое' } };
  const second = { occasion: 'дело', fact: { text: 'второе' } };
  attachReport(domain, first, { day: 130 });
  attachReport(domain, second, { day: 131 });
  assert.equal(first.reportSubject, 'порт');
  assert.equal(second.reportSubject, undefined);
});

// ───────────────────────────── слив событий ─────────────────────────────

test('слив разбирает просроченное и не трогает будущее', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const process = attachDeed(domain, plot, { plotEngagement: 'DIRECT', difficulty: 'PLAIN' });
  scheduleDeedJob(world, domain, process);
  const later = attachThreat(
    plot,
    createThreat({ plot, text: 'потом', day: 120 }),
  );
  resetPressure(plot, 120, null, () => 0);
  plot.pressure.fillDays = 100;
  schedulePressureJob(world, domain, plot);

  const events = await drainDomainJobs({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 125,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(events.length, 1, 'сработало только дело');
  assert.equal(events[0].occasion, 'дело');
  assert.equal(findThreat(plot, later.id).status, 'live');
});

test('шкала до срока не всплывает', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const hidden = attachThreat(plot, createThreat(plot, { text: 'просадка', day: 100 }));
  resetPressure(plot, 100, null, () => 0);
  plot.pressure.fillDays = 80;
  schedulePressureJob(world, domain, plot);
  const events = await drainDomainJobs({
    config,
    runtime: noRuntime,
    domain,
    world,
    day: 140,
    rng: () => 0.5,
    log: silentLog,
  });
  assert.equal(hidden.status, 'live');
  assert.equal(events.some((e) => e.occasion === 'угроза'), false);
});

test('слив начисляет ману за прошедшие дни', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  await drainDomainJobs({ config, domain, world, day: 300, rng: () => 0.5, log: silentLog });
  assert.ok(domain.state.mana > 50, 'мана приходит непрерывно, а не раз в тик');
  assert.equal(domain.state.manaDay, 300);
});

test('брошенная пауза истлевает при сливе', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  domain.state.pendingActions.push({ id: 'old', summary: 'забытое', status: 'paused', pausedDay: 100 });
  await drainDomainJobs({ config, domain, world, day: 200, rng: () => 0.5, log: silentLog });
  assert.equal(domain.state.pendingActions[0].status, 'expired');
});

test('пауза от наказа не истлевает молча', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  domain.state.pendingActions.push({
    id: 'held',
    summary: 'отложено наказом',
    status: 'paused',
    pausedDay: 100,
    pausedBy: 'order',
  });
  await drainDomainJobs({ config, domain, world, day: 200, rng: () => 0.5, log: silentLog });
  assert.equal(domain.state.pendingActions[0].status, 'paused');
});

test('слив не зацикливается на задании, которое падает', async () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const boom = {
    run: async () => {
      throw new Error('модель отвалилась');
    },
  };
  const threat = attachThreat(plot, createThreat(plot, { text: 'обвал', day: 100 }));
  resetPressure(plot, 100, null, () => 0);
  plot.pressure.fillDays = 10;
  schedulePressureJob(world, domain, plot);
  const events = await drainDomainJobs({
    config,
    runtime: boom,
    domain,
    world,
    day: 120,
    rng: () => 0.5,
    limit: 3,
    log: silentLog,
  });
  assert.ok(Array.isArray(events));
});

// ───────────────────────────── заводка домена ─────────────────────────────

test('заводка ставит попытку посева и обязательства живым историям', async () => {
  const plot = makePlot();
  const errand = { id: 'p2', type: 'errand', title: 'Поручение' };
  const domain = makeDomain({ plots: [plot, errand] });
  const world = makeWorld();
  await armDomainSchedule({ runtime: noRuntime, domain, world, day: 120, rng: () => 0.5, log: silentLog });
  assert.equal(jobList(world).filter((j) => j.kind === 'seed_attempt').length, 1);
  assert.equal(liveThreats(plot).length, 0);
  assert.equal(jobList(world).filter((j) => j.kind === 'pressure_fire').length, 1);
  assert.equal(domain.plotlines.some((p) => p.id === 'p2'), false, 'поручение не карточка');
});

test('повторная заводка не плодит вторую попытку посева', async () => {
  const domain = makeDomain();
  const world = makeWorld();
  await armDomainSchedule({ runtime: noRuntime, domain, world, day: 120, rng: () => 0.5, log: silentLog });
  await armDomainSchedule({ runtime: noRuntime, domain, world, day: 121, rng: () => 0.5, log: silentLog });
  assert.equal(jobList(world).filter((j) => j.kind === 'seed_attempt' && j.state === 'pending').length, 1);
});

test('отменённое дело уходит из очереди', () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const process = attachDeed(domain, plot);
  scheduleDeedJob(world, domain, process);
  cancelDeedJobs(world, process.id);
  assert.equal(dueJobs(world, 9999).length, 0);
});

test('повторная постановка дела не оставляет двух заданий', () => {
  const plot = makePlot();
  const domain = makeDomain({ plots: [plot] });
  const world = makeWorld();
  const process = attachDeed(domain, plot);
  scheduleDeedJob(world, domain, process);
  process.dueDay += 30;
  scheduleDeedJob(world, domain, process);
  const pending = jobList(world).filter((j) => j.state === 'pending' && j.kind === 'process_finish');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].dueDay, process.dueDay);
});
