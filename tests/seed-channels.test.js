import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { normalizeDomain } from '../src/game/models.js';
import {
  yearChronicleGrain,
  pickErrandGrain,
  decideMonthSeed,
  applyMonthSeedTemps,
  pickWorldGravity,
} from '../src/game/seedChannels.js';

const config = loadConfig();

function domain(stories, extra = {}) {
  return normalizeDomain({
    id: 'domain_t',
    name: 'Тест',
    createdTick: 0,
    cityBrief: 'Город на уступе.',
    plotlines: stories.map((title, i) => ({
      id: `plot_${i}`,
      title,
      kind: 'story',
      status: 'open',
    })),
    lore: extra.lore || [],
    state: { seedTemp: extra.seedTemp, pendingActions: [] },
  });
}

test('старый сейв 5/5/5 поднимает поручение до 10', () => {
  const d = domain(['Смола', 'Закалка'], { seedTemp: { chronicle: 5, void: 5, errand: 5 } });
  assert.deepEqual(d.state.seedTemp, { chronicle: 5, void: 5, errand: 10 });
});

test('хроника года выкидывает записи живых историй', () => {
  const d = domain(['Смола'], {
    lore: [
      { tags: ['chronicle'], tick: 10, text: 'Живая', relatedPlotlineIds: ['plot_0'] },
      { tags: ['chronicle'], tick: 10, text: 'Свободная', relatedPlotlineIds: ['plot_old'] },
      { tags: ['chronicle'], tick: 1, text: 'Старая', relatedPlotlineIds: [] },
    ],
  });
  const grain = yearChronicleGrain(d, { tickIndex: 14 });
  assert.deepEqual(grain.map((f) => f.text), ['Свободная']);
});

test('из закрытых дел берём самое долгое, при равенстве — крит', () => {
  const picked = pickErrandGrain([
    { finished: true, summary: 'Короткое', objectiveMonths: 2, finish: 'crit' },
    { finished: true, summary: 'Долгое', objectiveMonths: 6, finish: 'fail' },
    { finished: true, summary: 'Тоже долгое', objectiveMonths: 6, finish: 'ok' },
    { finished: false, summary: 'Ещё идёт', objectiveMonths: 12 },
  ]);
  assert.equal(picked.summary, 'Тоже долгое');
});

test('две живые истории: мир может сеять, три — только поручение', () => {
  const two = domain(['А', 'Б']);
  const hit = decideMonthSeed({
    domain: two,
    world: { tickIndex: 8 },
    config,
    rng: () => 0,
  });
  assert.ok(hit.source === 'void' || hit.source === 'chronicle');

  const three = domain(['А', 'Б', 'В']);
  const silent = decideMonthSeed({
    domain: three,
    world: { tickIndex: 8 },
    config,
    processOutcomes: [],
    rng: () => 0,
  });
  assert.equal(silent.source, null);
  assert.equal(silent.events.chronicle, 'idle');
  assert.equal(silent.events.void, 'idle');

  const withErrand = decideMonthSeed({
    domain: three,
    world: { tickIndex: 8 },
    config,
    processOutcomes: [
      { finished: true, summary: 'Мост', objectiveMonths: 4, finish: 'ok', processId: 'act_1' },
    ],
    rng: () => 0,
  });
  assert.equal(withErrand.source, 'errand');
});

test('поручение важнее пустоты, если оба выпали', () => {
  const d = domain(['А']);
  const decision = decideMonthSeed({
    domain: d,
    world: { tickIndex: 4 },
    config,
    processOutcomes: [
      { finished: true, summary: 'Ров', objectiveMonths: 3, finish: 'ok', processId: 'act_1' },
    ],
    rng: () => 0,
  });
  assert.equal(decision.source, 'errand');
});

test('пустая доска сеет даже если броски не выпали', () => {
  const d = domain([]);
  const decision = decideMonthSeed({
    domain: d,
    world: { tickIndex: 2 },
    config,
    rng: () => 0.99,
  });
  assert.ok(decision.source === 'void' || decision.source === 'chronicle');
  assert.equal(decision.events[decision.source], 'seed');
});

test('четыре истории — доска полна, никто не сеет', () => {
  const d = domain(['1', '2', '3', '4']);
  const decision = decideMonthSeed({
    domain: d,
    world: { tickIndex: 8 },
    config,
    processOutcomes: [
      { finished: true, summary: 'Ров', objectiveMonths: 6, finish: 'crit', processId: 'act_1' },
    ],
    rng: () => 0,
  });
  assert.equal(decision.source, null);
});

test('после посева температура канала падает, остальные копят', () => {
  const d = domain(['А', 'Б']);
  assert.equal(d.state.seedTemp.errand, 10);
  applyMonthSeedTemps(d, { chronicle: 'idle', void: 'seed', errand: 'idle' }, config);
  assert.equal(d.state.seedTemp.chronicle, 6);
  assert.equal(d.state.seedTemp.void, 0);
  assert.equal(d.state.seedTemp.errand, 10);
});

test('gravity мира в день 0 не застревает на ситуации', () => {
  const seen = new Set();
  for (let i = 0; i < 80; i += 1) {
    seen.add(pickWorldGravity({ createdTick: 0 }, { tickIndex: 3 }, () => i / 80));
  }
  assert.ok(seen.has('SITUATION'));
  assert.ok(seen.has('EPISODE'));
});
