import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorldFromConfig, createCharacterRecord, formatCastForPrompt, firstMentionHintForSpeech } from '../src/game/models.js';
import { takeName, takeNameAtRandom, offerNames, bindCharacterNames, seedWorldNamePool } from '../src/game/names.js';
import {
  defaultNewsSchedule,
  normalizeNewsSchedule,
  shouldSendTickNews,
  setNewsSchedule,
  splitTickNews,
} from '../src/game/newsSchedule.js';
import { pauseProcess, resumeProcess, applyEngineProgress, normalizeProcess } from '../src/game/processes.js';
import { resolveConfluxSharedMonth } from '../src/game/confluxMonth.js';
import { createPlotline } from '../src/game/plotlines.js';
import { ageDomainPeople } from '../src/game/ages.js';

test('пул имён копируется в мир и вынимается', () => {
  const world = createWorldFromConfig({ world: { id: 't', name: 'Т' } });
  assert.ok(world.namePool.female.length > 50);
  assert.ok(world.namePool.male.length > 50);
  const a = takeName(world, 'female');
  const b = takeName(world, 'female');
  assert.notEqual(a, b);
  assert.ok(!world.namePool.female.includes(a));
});

test('случайное имя не всегда с головы пула', () => {
  const world = { namePool: { female: ['Айра', 'Найра', 'Севра'], male: ['Кален'] } };
  seedWorldNamePool(world);
  const name = takeNameAtRandom(world, 'female', null, () => 0.9);
  assert.equal(name, 'Севра');
  assert.equal(world.namePool.female.length, 2);
  assert.ok(!world.namePool.female.includes('Севра'));
});

test('агент берёт предложенное имя, чужое заменяем в тексте', () => {
  const world = { namePool: { female: ['Айра', 'Найра'], male: ['Кален'] } };
  seedWorldNamePool(world);
  const offered = offerNames(world, { female: 2, male: 1 });
  const people = [{ name: 'Иван', gender: 'male' }];
  const bound = bindCharacterNames(world, people, {
    offered,
    texts: ['Иван вышел к краю.'],
  });
  assert.equal(bound.list[0].name, 'Кален');
  assert.match(bound.texts[0], /Кален/);
  assert.doesNotMatch(bound.texts[0], /Иван/);
});

test('расписание писем: массив месяцев и critical в поле хроники', () => {
  const domain = { state: {} };
  setNewsSchedule(domain, { months: [1, 4, 8], alsoOnCritical: true, detail: 'essence' });
  const sched = normalizeNewsSchedule(domain.state.newsSchedule);
  assert.deepEqual(sched.months, [1, 4, 8]);
  assert.equal(shouldSendTickNews(domain, { month: 4 }, []), true);
  assert.equal(shouldSendTickNews(domain, { month: 2 }, []), false);
  assert.equal(
    shouldSendTickNews(domain, { month: 2 }, [{ importance: 'critical', text: 'беда' }]),
    true,
  );
  assert.equal(shouldSendTickNews(domain, { month: 2 }, [{ importance: 'minor' }]), false);
  const def = defaultNewsSchedule();
  assert.equal(def.months.length, 12);
  assert.equal(def.detail, 'essence');
  assert.equal(def.clickbait, true);
  assert.equal(def.ask, true);
  assert.equal(splitTickNews('Первый абзац достаточно длинный.\n\nВторой абзац тоже не короткий.').length, 2);
});

test('пауза не тикает и не занимает слот', () => {
  const process = normalizeProcess({
    id: 'act_1',
    summary: 'Розыск',
    detail: 'Искать на рынке.',
    expectedMonths: 3,
    monthsLeft: 2,
    monthsDone: 1,
    status: 'active',
    linkedStats: ['knowledge'],
  });
  assert.equal(pauseProcess(process).ok, true);
  assert.equal(process.status, 'paused');
  const domain = {
    stats: { knowledge: 50 },
    state: { pendingActions: [process] },
  };
  const outcomes = applyEngineProgress(domain, [{ processId: 'act_1', kind: 'normal', advance: 1 }]);
  assert.equal(outcomes.length, 0);
  assert.equal(process.monthsLeft, 2);
  const resumed = resumeProcess(process, domain, { tick: { maxActiveProcesses: 3 } });
  assert.equal(resumed.ok, true);
  assert.equal(process.status, 'active');
});

test('часы нитей сопряжения тикают даже без shared', async () => {
  const local = createPlotline({ title: 'Чужая печать', kind: 'story', maxAgeMonths: 8 });
  local.shared = false;
  local.concernsDomainIds = ['a'];
  const conflux = {
    id: 'c1',
    domainIds: ['a', 'b'],
    status: 'approaching',
    plotlines: [local],
    processes: [],
    lore: [],
    awareness: {},
    knownLoreIds: {},
  };
  await resolveConfluxSharedMonth({
    config: { tick: { plot: { temperature: { decayPerTick: 8 } } } },
    runtime: { run: async () => ({}) },
    conflux,
    domains: [
      { id: 'a', name: 'А', lore: [], stats: {} },
      { id: 'b', name: 'Б', lore: [], stats: {} },
    ],
    world: { tickIndex: 3, gameDate: { label: 'Год 1, месяц 3' } },
  });
  assert.equal(conflux.plotlines[0].ageMonths, 1);
});

test('пустой пол имён сразу наполняется из файла, чужой пол не трогаем', () => {
  const world = { namePool: { female: ['Айра'], male: ['Кален'] } };
  assert.equal(takeName(world, 'female'), 'Айра');
  const next = takeName(world, 'female');
  assert.ok(next);
  assert.notEqual(next, 'Кален');
  assert.equal(world.namePool.male[0], 'Кален');
  assert.ok(world.namePool.female.length > 10);
});

test('персонажу ставится возраст и месяц рождения, в свой месяц год прибавляется', () => {
  const world = { tickIndex: 4, gameDate: { year: 1, month: 4, label: 'Год 1, месяц 4' } };
  const person = createCharacterRecord({
    id: 'lore_1',
    name: 'Айра',
    role: 'ткачиха',
    gender: 'female',
    ageYears: 34,
    world,
  });
  person.birthMonth = 5;
  person.agedInYear = 0;
  assert.equal(person.ageYears, 34);
  assert.match(formatCastForPrompt([person]), /34 лет/);
  assert.match(formatCastForPrompt([person]), /ткачиха/);
  ageDomainPeople({ lore: [person], characters: [] }, world);
  assert.equal(person.ageYears, 34);
  world.gameDate = { year: 1, month: 5, label: 'Год 1, месяц 5' };
  ageDomainPeople({ lore: [person], characters: [] }, world);
  assert.equal(person.ageYears, 35);
  ageDomainPeople({ lore: [person], characters: [] }, world);
  assert.equal(person.ageYears, 35);
  assert.match(firstMentionHintForSpeech(), /впервые/);
});
