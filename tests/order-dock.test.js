import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlotline } from '../src/game/plotlines.js';
import { markOrderFired } from '../src/game/orders.js';
import { canStartProcess } from '../src/game/processes.js';
import { startDockOrderProcess, fireConfluxDockOrder, mainConfluxPlot } from '../src/game/orderDock.js';

const config = {
  stats: [{ id: 'knowledge' }, { id: 'influence' }, { id: 'security' }],
  tick: { maxActiveProcesses: 2, plot: {} },
};

function world() {
  return { tickIndex: 12, gameDate: { label: 'Год 2, месяц 4' } };
}

function domainWithOrder(extra = {}) {
  const order = createPlotline({
    title: 'Делегация учёных',
    synopsis: 'На каждую встречу шлют учёных.',
    orderText: 'При каждом сопряжении слать учёных',
    kind: 'order',
    fireOn: 'conflux_dock',
    relatedStats: ['knowledge'],
  });
  return {
    id: 'city_a',
    name: 'Аллерия',
    lore: [],
    characters: [{ id: 'ch_1', name: 'Сатра' }],
    plotlines: [order],
    state: {
      modifiers: [],
      pendingActions: extra.processes || [],
    },
    stats: { knowledge: 60 },
    ...extra,
    plotlines: extra.plotlines || [order],
  };
}

function confluxWithMain() {
  const main = createPlotline({
    title: 'Встреча островов',
    kind: 'story',
    isMainConflux: true,
    shared: true,
    hostDomainId: 'city_a',
    concernsDomainIds: ['city_a', 'city_b'],
  });
  main.isMainConflux = true;
  return {
    id: 'cf_1',
    status: 'docked',
    domainIds: ['city_a', 'city_b'],
    mainPlotId: main.id,
    plotlines: [main],
    processes: [],
    lore: [],
  };
}

test('mainConfluxPlot берёт нить по mainPlotId', () => {
  const c = confluxWithMain();
  assert.equal(mainConfluxPlot(c).id, c.mainPlotId);
  assert.equal(mainConfluxPlot(c).isMainConflux, true);
});

test('стык заводит дело на главной нити и не дублирует его', () => {
  const domain = domainWithOrder();
  const order = domain.plotlines[0];
  const conflux = confluxWithMain();
  const partner = { id: 'city_b', name: 'Ксарет' };
  const first = startDockOrderProcess(domain, order, { conflux, partner, config, months: 2 });
  assert.equal(first.ok, true);
  assert.equal(first.process.confluxId, 'cf_1');
  assert.equal(first.process.ownerDomainId, 'city_a');
  assert.equal(first.process.sourceOrderId, order.id);
  assert.equal(first.process.plotlineId, conflux.mainPlotId);
  assert.ok(conflux.plotlines[0].relatedProcessIds.includes(first.process.id));
  assert.equal(domain.state.pendingActions.length, 1);
  assert.equal(first.process.slotless, true);
  assert.equal(canStartProcess(domain, config).ok, true);
  assert.equal(canStartProcess(domain, config).active, 0);
  const again = startDockOrderProcess(domain, order, { conflux, partner, config, months: 2 });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_acting');
  assert.equal(domain.state.pendingActions.length, 1);
});

test('стык заводит дело мимо лимита слотов и слот игрока не занимает', () => {
  const processes = [
    { id: 'act_1', summary: 'Стена', status: 'active' },
    { id: 'act_2', summary: 'Канал', status: 'active' },
    { id: 'act_3', summary: 'Склад', status: 'active' },
    { id: 'act_4', summary: 'Дозор', status: 'active' },
  ];
  const officers = ['treasurer', 'marshal', 'keeper', 'chancellor'].map((office, i) => ({
    id: `off_${i + 1}`,
    office,
    name: office,
    processId: processes[i].id,
  }));
  const domain = domainWithOrder({ processes, officers });
  const order = domain.plotlines[0];
  const conflux = confluxWithMain();
  const result = startDockOrderProcess(domain, order, {
    conflux,
    partner: { name: 'Ксарет' },
    config,
    months: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.process.slotless, true);
  assert.equal(domain.state.pendingActions.length, 5);
  assert.equal(canStartProcess(domain, config).ok, false);
  assert.equal(canStartProcess(domain, config).active, 4);
});

test('fireConfluxDockOrder пишет хронику, дело и отмечает стык', async () => {
  const domain = domainWithOrder();
  const order = domain.plotlines[0];
  const conflux = confluxWithMain();
  const partner = { id: 'city_b', name: 'Ксарет' };
  const runtime = {
    async run({ tools }) {
      const duration = tools.find((t) => t.name === 'submit_duration');
      if (duration) {
        await duration.handler({ months: 2 });
        return;
      }
      const chron = tools.find((t) => t.name === 'submit_order_chronicle');
      if (chron) {
        await chron.handler({ entry: 'К Ксарету ушли писцы с образцами трав.' });
      }
    },
  };
  const result = await fireConfluxDockOrder({
    config,
    runtime,
    domain,
    world: world(),
    plot: order,
    conflux,
    partner,
  });
  assert.ok(result.fact);
  assert.match(result.fact.text, /писцы|Ксарет/);
  assert.equal(result.process.summary, 'Делегация учёных');
  assert.equal(order.lastFiredConfluxId, 'cf_1');
  assert.ok(conflux.plotlines[0].chronicleIds.includes(result.fact.id));
  assert.ok(result.fact.relatedPlotlineIds.includes(conflux.mainPlotId));
});

test('при полном лимите всё равно дело и хроника', async () => {
  const domain = domainWithOrder({
    processes: [
      { id: 'act_1', summary: 'Стена', status: 'active' },
      { id: 'act_2', summary: 'Канал', status: 'active' },
    ],
  });
  const order = domain.plotlines[0];
  const conflux = confluxWithMain();
  const result = await fireConfluxDockOrder({
    config,
    runtime: null,
    domain,
    world: world(),
    plot: order,
    conflux,
    partner: { name: 'Ксарет' },
  });
  assert.equal(result.refused, null);
  assert.ok(result.process);
  assert.equal(result.process.slotless, true);
  assert.match(result.fact.text, /Делегация|отправили|учёных/i);
  assert.equal(order.lastFiredConfluxId, 'cf_1');
  markOrderFired(order, 12, { confluxId: 'cf_1' });
  assert.equal(order.lastFiredConfluxId, 'cf_1');
});
