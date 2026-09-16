import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastPairChronicleDay,
  attemptPairSilence,
  silenceThreatId,
  SILENCE_THREAT_TEXT,
  ensurePairState,
  refreshPairForecast,
} from '../src/game/confluxForecast.js';
import { appendPairEntry, PLACE_PAIR } from '../src/game/confluxCanon.js';
import { overlayConfluxView, stripConfluxView, createEmptyContainer } from '../src/game/confluxBoard.js';
import { createPlotline } from '../src/game/plotlines.js';
import { liveThreats, findThreat } from '../src/game/threats.js';
import { resyncThreatJobs } from '../src/game/worldLoop.js';

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
  conflux.container = createEmptyContainer({ a, b, conflux, world: { tickIndex: 0 }, config: {} });
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

test('карточка нити пары показывает синопсис своего города, а концовок у пары нет', () => {
  const { a, b, conflux } = pair();
  // Сейв времён исходов «по номеру в массиве»: нормализация доски их снимает.
  conflux.container.endings = [{ id: 'end_0', kind: 'GOOD_ENDING', text: 'Временный договор о проходе' }];
  conflux.container.synopsis = 'Нейтрально: город взят.';
  conflux.synopsis.a = 'Нас заняли с прохода.';
  conflux.synopsis.b = 'Мы взяли соседний берег.';
  overlayConfluxView(a, conflux, b);
  const card = a.plotlines.find((p) => p.type === 'conflux');
  assert.equal(card.synopsis, 'Нас заняли с прохода.');
  assert.deepEqual(card.endings, []);
  assert.equal(conflux.container.synopsis, 'Нейтрально: город взят.');
  assert.deepEqual(conflux.container.endings, []);
  stripConfluxView(a);
  assert.equal(a.plotlines.length, 0);
});

test('тишина: пара без пересечений получает попытку, живой поток — нет', () => {
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
  assert.ok(silent.threat);
  assert.equal(silent.threat.id, silenceThreatId(conflux.id));
  assert.equal(silent.threat.text, SILENCE_THREAT_TEXT);
  assert.equal(liveThreats(conflux.container).length, 1);

  appendPairEntry(conflux, { gameDate: { label: 'x' } }, { text: 'На проходе снова люди.', place: PLACE_PAIR, day: 131 });
  const busy = attemptPairSilence({
    conflux,
    world,
    day: 132,
    config: cfg,
    rng: () => 0,
  });
  assert.equal(busy.skipped, 'active');
  assert.equal(findThreat(conflux.container, silenceThreatId(conflux.id)).status, 'dropped');
});

test('часы существующей угрозы тишины не переназначаются', () => {
  const { a, conflux } = pair();
  const world = { jobs: [] };
  const cfg = { tick: { conflux: { quietSilenceDays: 5, quietChance: 1, quietCooldownDays: 10 } } };
  const first = attemptPairSilence({ conflux, world, day: 120, config: cfg, rng: () => 0 });
  const due = first.threat.dueDay;
  resyncThreatJobs(world, a, conflux.container);
  const jobs1 = (world.jobs || []).filter((j) => j.kind === 'threat_fire' && j.state === 'pending');
  assert.equal(jobs1.length, 1);
  const again = attemptPairSilence({ conflux, world, day: 140, config: cfg, rng: () => 0 });
  assert.equal(again.skipped, 'already');
  assert.equal(findThreat(conflux.container, silenceThreatId(conflux.id)).dueDay, due);
  resyncThreatJobs(world, a, conflux.container);
  const jobs2 = (world.jobs || []).filter((j) => j.kind === 'threat_fire' && j.state === 'pending');
  assert.equal(jobs2.length, 1);
  assert.equal(jobs2[0].dueDay, due);
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

void createPlotline;
