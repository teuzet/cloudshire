import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastPairChronicleDay,
  attemptPairSilence,
  ensurePairState,
  refreshPairForecast,
} from '../src/game/confluxForecast.js';
import { appendPairEntry, PLACE_PAIR } from '../src/game/confluxCanon.js';
import { overlayConfluxView, stripConfluxView } from '../src/game/confluxBoard.js';

function city(id, name) {
  return { id, name, lore: [], plotlines: [] };
}

function pair(extra = {}) {
  const a = city('a', 'Аллерия');
  const b = city('b', 'Керсай');
  const conflux = {
    id: 'cf1',
    status: 'docked',
    domainIds: ['a', 'b'],
    dockedDay: 100,
    lore: [],
    ...extra,
  };
  ensurePairState(conflux);
  return { a, b, conflux };
}

test('прогноз переписывается на каждой записи пары', async () => {
  const { a, b, conflux } = pair();
  const world = { gameDate: { label: 'Год 1, месяц 4, день 10' }, jobs: [] };
  appendPairEntry(conflux, world, { text: 'Керсай занял проход.', place: PLACE_PAIR, day: 100 });
  const runtime = {
    async run({ tools, agentId }) {
      assert.equal(agentId, 'confluxForecast');
      const submit = tools.find((t) => t.name === 'submit_forecast');
      await submit.handler({
        forecasts: [
          { domainId: 'a', text: 'Аллерия остаётся под чужой стражей.' },
          { domainId: 'b', text: 'Керсай удерживает взятое.' },
        ],
        neutral: 'Один берег занял другой.',
      });
    },
  };
  await refreshPairForecast({ runtime, conflux, domains: [a, b], world });
  assert.match(conflux.forecast.a, /под чужой/);
  assert.match(conflux.forecast.b, /удерживает/);
  assert.match(conflux.forecast.neutral, /занял/);
  appendPairEntry(conflux, world, { text: 'Стража Керсая ушла с площади.', place: 'a', day: 110 });
  const runtime2 = {
    async run({ tools }) {
      const submit = tools.find((t) => t.name === 'submit_forecast');
      await submit.handler({
        forecasts: [
          { domainId: 'a', text: 'Аллерия снова своя, но в руинах.' },
          { domainId: 'b', text: 'Керсай уходит ни с чем.' },
        ],
        neutral: 'Захват не удержался.',
      });
    },
  };
  await refreshPairForecast({ runtime: runtime2, conflux, domains: [a, b], world });
  assert.match(conflux.forecast.a, /руинах/);
  assert.match(conflux.forecast.neutral, /не удержался/);
});

test('оверлей не кладёт карточку пары на доску города', () => {
  const { a, b, conflux } = pair();
  conflux.synopsis.a = 'Нас заняли с прохода.';
  overlayConfluxView(a, conflux, b);
  assert.equal(a.plotlines.filter((p) => p.type === 'conflux').length, 0);
  stripConfluxView(a);
  assert.equal(a.plotlines.length, 0);
});

test('тишина без нити не вешает угрозу', () => {
  const { conflux } = pair();
  const world = { jobs: [] };
  const cfg = { tick: { conflux: { quietSilenceDays: 21, quietChance: 1, quietCooldownDays: 10 } } };
  const silent = attemptPairSilence({
    conflux,
    world,
    day: 130,
    config: cfg,
    rng: () => 0,
  });
  assert.equal(silent.skipped, 'no_plot_threats');
  assert.equal(silent.threat, undefined);

  appendPairEntry(conflux, { gameDate: { label: 'x' } }, { text: 'На проходе снова люди.', place: PLACE_PAIR, day: 131 });
  const busy = attemptPairSilence({
    conflux,
    world,
    day: 132,
    config: cfg,
    rng: () => 0,
  });
  assert.equal(busy.skipped, 'active');
});

test('lastPairChronicleDay не считает замороженный синопсис', () => {
  const conflux = { lore: [] };
  appendPairEntry(conflux, { gameDate: { label: 'a' } }, {
    text: 'Что случилось в этой истории на данный момент: твари у кромки.',
    place: 'a',
    day: 50,
    frozen: true,
  });
  appendPairEntry(conflux, { gameDate: { label: 'b' } }, { text: 'Твари перешли проход.', place: PLACE_PAIR, day: 80 });
  assert.equal(lastPairChronicleDay(conflux), 80);
});
