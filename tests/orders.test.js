import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueOrderRequest,
  listStandingOrders,
  orderWantsTick,
  pickOrderOutcome,
  planOrderTicks,
  markOrderFired,
  normalizeOrders,
  expireTimedOrders,
  parseOrderDuration,
} from '../src/game/orders.js';
import { resolvePendingOrders } from '../src/game/orderSmith.js';
import { plotConfig, liveStoryImportance, countOpen, normalizePlotlines } from '../src/game/plotlines.js';
import { normalizeDomain } from '../src/game/models.js';

function cfg() {
  return plotConfig({
    tick: { plot: { board: { maxOpen: 5, targetImportance: 100, seedMaxChance: 0.5 }, beats: { baseChance: 0.15 } } },
  });
}

test('заявка на указ не пишет модификатор сразу', () => {
  const domain = { state: { modifiers: [], pendingOrderRequests: [] }, plotlines: [] };
  const { request, created } = queueOrderRequest(domain, {
    action: 'create',
    text: 'Выбирать избранного раз в два месяца',
    by: 'Сатра',
    tick: 3,
  });
  assert.equal(created, true);
  assert.equal(domain.state.modifiers.length, 0);
  assert.equal(domain.state.pendingOrderRequests.length, 1);
  assert.equal(request.action, 'create');
  const listed = listStandingOrders(domain);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].pending, 'create');
});

test('повтор той же формулировки обновляет заявку, не плодит вторую', () => {
  const domain = { state: { modifiers: [], pendingOrderRequests: [] }, plotlines: [] };
  queueOrderRequest(domain, { action: 'create', text: 'Налоги вдвое', tick: 1 });
  const again = queueOrderRequest(domain, { action: 'create', text: 'Налоги вдвое', tick: 1 });
  assert.equal(again.created, false);
  assert.equal(domain.state.pendingOrderRequests.length, 1);
});

test('отмена заявки на ещё не вступивший указ снимает её сразу', () => {
  const domain = { state: { modifiers: [], pendingOrderRequests: [] }, plotlines: [] };
  const { request } = queueOrderRequest(domain, { action: 'create', text: 'Комендантский час', tick: 1 });
  const undone = queueOrderRequest(domain, { action: 'revoke', orderId: request.id, tick: 1 });
  assert.equal(undone.cancelled, true);
  assert.equal(domain.state.pendingOrderRequests.length, 0);
});

test('старый модификатор без нити становится заявкой adopt', () => {
  const domain = {
    state: {
      modifiers: [{ id: 'mod_old', text: 'Налоги вдвое', kind: 'order' }],
      pendingOrderRequests: [],
    },
    plotlines: [],
  };
  normalizeOrders(domain);
  assert.equal(domain.state.pendingOrderRequests.length, 1);
  assert.equal(domain.state.pendingOrderRequests[0].action, 'adopt');
  assert.equal(domain.state.pendingOrderRequests[0].orderId, 'mod_old');
});

test('агент порядка по заявке создаёт пару модификатор+нить даже без runtime', async () => {
  const domain = normalizeDomain({
    id: 'd1',
    name: 'Саркум',
    description: 'Город у края.',
    state: { modifiers: [], pendingOrderRequests: [] },
    plotlines: [],
  });
  queueOrderRequest(domain, {
    action: 'create',
    text: 'Выбирать избранного раз в два месяца',
    tick: 4,
  });
  const results = await resolvePendingOrders({
    config: { tick: { plot: {} } },
    runtime: null,
    domain,
    world: { tickIndex: 4, gameDate: { label: 'Год 1, месяц 4' } },
  });
  assert.equal(results.length, 1);
  assert.equal(domain.state.pendingOrderRequests.length, 0);
  assert.equal(domain.state.modifiers.length, 1);
  assert.equal(domain.plotlines.length, 1);
  assert.equal(domain.plotlines[0].kind, 'order');
  assert.equal(domain.plotlines[0].modifierId, domain.state.modifiers[0].id);
  assert.equal(domain.state.modifiers[0].plotlineId, domain.plotlines[0].id);
  assert.equal(countOpen(domain).orders, 1);
  assert.equal(countOpen(domain).stories, 0);
  assert.equal(liveStoryImportance(domain), 0);
});

test('расписание хочет тик в срок; без расписания — только вероятность', () => {
  const due = { kind: 'order', nextDueTick: 5, fireChance: 0, scheduleEveryMonths: 1 };
  assert.equal(orderWantsTick(due, 5, () => 0).want, true);
  assert.equal(orderWantsTick(due, 5, () => 0).scheduled, true);
  assert.equal(orderWantsTick(due, 4, () => 0).want, false);
  const chance = { kind: 'order', nextDueTick: null, fireChance: 0.4 };
  assert.equal(orderWantsTick(chance, 3, () => 0.1).want, true);
  assert.equal(orderWantsTick(chance, 3, () => 0.1).scheduled, false);
  assert.equal(orderWantsTick(chance, 3, () => 0.9).want, false);
});

test('если есть и шанс и расписание — тик только по сроку, шанс игнорируется', () => {
  const plot = { kind: 'order', nextDueTick: 10, fireChance: 0.9, scheduleEveryMonths: 1 };
  assert.equal(orderWantsTick(plot, 10, () => 0.99).want, true);
  assert.equal(orderWantsTick(plot, 10, () => 0.99).scheduled, true);
  assert.equal(orderWantsTick(plot, 9, () => 0).want, false);
});

test('пустая доска рождает историю, полная — хронику', () => {
  const c = cfg();
  assert.equal(pickOrderOutcome({ plotlines: [] }, c, () => 0), 'story');
  assert.equal(
    pickOrderOutcome({ plotlines: [{ kind: 'order', importance: 90 }] }, c, () => 0),
    'story',
  );
  const full = {
    plotlines: [
      { kind: 'story', importance: 70 },
      { kind: 'story', importance: 40 },
    ],
  };
  assert.equal(pickOrderOutcome(full, c, () => 0), 'chronicle');
});

test('нет слота — расписание всё равно идёт, вероятностный указ молчит', () => {
  const domain = {
    plotlines: [
      { id: 'o_due', title: 'Избранный', kind: 'order', nextDueTick: 8, fireChance: 0, scheduleEveryMonths: 2 },
      { id: 'o_maybe', title: 'Налог', kind: 'order', nextDueTick: null, fireChance: 1 },
    ],
  };
  const planned = planOrderTicks({ domain, slotsLeft: 0, tick: 8, rng: () => 0 });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].plotId, 'o_due');
  assert.equal(planned[0].scheduled, true);
  assert.equal(domain.plotlines[0].nextDueTick, 8);
});

test('нормализация обнуляет шанс у указа с расписанием', () => {
  const domain = {
    plotlines: [
      {
        id: 'o1',
        title: 'Жребий',
        kind: 'order',
        fireChance: 0.9,
        scheduleEveryMonths: 1,
        nextDueTick: 10,
      },
    ],
  };
  normalizePlotlines(domain);
  assert.equal(domain.plotlines[0].fireChance, 0);
  assert.equal(domain.plotlines[0].scheduleEveryMonths, 1);
  assert.equal(domain.plotlines[0].nextDueTick, 10);
});

test('агент порядка с расписанием не оставляет живой шанс', async () => {
  const domain = normalizeDomain({
    id: 'd1',
    name: 'Саркум',
    description: 'Город у края.',
    state: { modifiers: [], pendingOrderRequests: [] },
    plotlines: [],
  });
  queueOrderRequest(domain, {
    action: 'create',
    text: 'Каждый месяц тянуть жребий у храма',
    tick: 4,
  });
  const runtime = {
    async run({ tools }) {
      const submit = tools.find((t) => t.name === 'submit_order_card');
      await submit.handler({
        title: 'Жребий замыслов',
        synopsis: 'Раз в месяц тянут жребий.',
        closeWhen: 'Покровитель отменил.',
        fireChance: 0.9,
        scheduleEveryMonths: 1,
        dueNow: false,
      });
    },
  };
  await resolvePendingOrders({
    config: { tick: { plot: {} } },
    runtime,
    domain,
    world: { tickIndex: 4, gameDate: { label: 'Год 1, месяц 4' } },
  });
  assert.equal(domain.plotlines[0].fireChance, 0);
  assert.equal(domain.plotlines[0].scheduleEveryMonths, 1);
});

test('после срабатывания расписание ставит следующий срок', () => {
  const plot = { scheduleEveryMonths: 2, nextDueTick: 4, beatCount: 0 };
  markOrderFired(plot, 4);
  assert.equal(plot.nextDueTick, 6);
  assert.equal(plot.beatCount, 1);
});

test('указ на стык хочет тик один раз на это сопряжение', () => {
  const plot = { kind: 'order', fireOn: 'conflux_dock', fireChance: 0.9, scheduleEveryMonths: 2 };
  const docked = { id: 'cf_1', status: 'docked' };
  assert.equal(orderWantsTick(plot, 10, () => 0, { conflux: docked }).want, true);
  assert.equal(orderWantsTick(plot, 10, () => 0, { conflux: docked }).scheduled, true);
  assert.equal(orderWantsTick(plot, 10, () => 0, { conflux: docked }).event, 'conflux_dock');
  assert.equal(orderWantsTick(plot, 10, () => 0, { conflux: { id: 'cf_1', status: 'approaching' } }).want, false);
  assert.equal(orderWantsTick(plot, 10, () => 0).want, false);
  plot.lastFiredConfluxId = 'cf_1';
  assert.equal(orderWantsTick(plot, 11, () => 0, { conflux: docked }).want, false);
  assert.equal(orderWantsTick(plot, 12, () => 0, { conflux: { id: 'cf_2', status: 'docked' } }).want, true);
});

test('стык обнуляет расписание и шанс при нормализации', () => {
  const domain = {
    plotlines: [
      {
        id: 'o1',
        title: 'Делегация',
        kind: 'order',
        fireOn: 'conflux_dock',
        fireChance: 0.9,
        scheduleEveryMonths: 1,
        nextDueTick: 10,
      },
    ],
  };
  normalizePlotlines(domain);
  assert.equal(domain.plotlines[0].fireOn, 'conflux_dock');
  assert.equal(domain.plotlines[0].fireChance, 0);
  assert.equal(domain.plotlines[0].scheduleEveryMonths, null);
  assert.equal(domain.plotlines[0].nextDueTick, null);
});

test('стык идёт даже без слота месяца', () => {
  const domain = {
    plotlines: [
      { id: 'o_dock', title: 'Учёные', kind: 'order', fireOn: 'conflux_dock' },
      { id: 'o_maybe', title: 'Налог', kind: 'order', fireChance: 1 },
    ],
  };
  const planned = planOrderTicks({
    domain,
    slotsLeft: 0,
    tick: 8,
    rng: () => 0,
    conflux: { id: 'cf_1', status: 'docked' },
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].plotId, 'o_dock');
  assert.equal(planned[0].event, 'conflux_dock');
});

test('агент порядка ставит fireOn=conflux_dock и обнуляет календарь', async () => {
  const domain = normalizeDomain({
    id: 'd1',
    name: 'Саркум',
    description: 'Город у края.',
    state: { modifiers: [], pendingOrderRequests: [] },
    plotlines: [],
  });
  queueOrderRequest(domain, {
    action: 'create',
    text: 'При каждом сопряжении отправлять делегацию учёных на соседский остров',
    tick: 4,
  });
  const runtime = {
    async run({ tools }) {
      const submit = tools.find((t) => t.name === 'submit_order_card');
      await submit.handler({
        title: 'Делегация учёных',
        synopsis: 'На каждую встречу островов город шлёт учёных.',
        closeWhen: 'Покровитель отменил.',
        fireChance: 0.4,
        scheduleEveryMonths: 2,
        fireOn: 'conflux_dock',
        dueNow: true,
      });
    },
  };
  await resolvePendingOrders({
    config: { tick: { plot: {} } },
    runtime,
    domain,
    world: { tickIndex: 4, gameDate: { label: 'Год 1, месяц 4' } },
  });
  assert.equal(domain.plotlines[0].fireOn, 'conflux_dock');
  assert.equal(domain.plotlines[0].fireChance, 0);
  assert.equal(domain.plotlines[0].scheduleEveryMonths, null);
  assert.equal(domain.plotlines[0].nextDueTick, null);
});

test('срок указа: не задан — бессрочно; число — истекает через N месяцев', async () => {
  assert.equal(parseOrderDuration(undefined), null);
  assert.equal(parseOrderDuration(0), null);
  assert.equal(parseOrderDuration(3), 3);
  assert.equal(parseOrderDuration(99), 36);

  const domain = normalizeDomain({
    id: 'd1',
    name: 'Саркум',
    state: { modifiers: [], pendingOrderRequests: [] },
    plotlines: [],
  });
  queueOrderRequest(domain, { action: 'create', text: 'Комендантский час', tick: 4 });
  queueOrderRequest(domain, { action: 'create', text: 'Запрет вина на сезон', tick: 4, durationMonths: 3 });
  await resolvePendingOrders({
    config: { tick: { plot: {} } },
    runtime: null,
    domain,
    world: { tickIndex: 4, gameDate: { label: 'Год 1, месяц 4' } },
  });
  const forever = domain.state.modifiers.find((m) => m.text.includes('Комендантский'));
  const timed = domain.state.modifiers.find((m) => m.text.includes('вина'));
  assert.equal(forever.durationMonths, null);
  assert.equal(forever.expiresTick, null);
  assert.equal(timed.durationMonths, 3);
  assert.equal(timed.expiresTick, 7);
  const listed = listStandingOrders(domain, { tick: 5 });
  const timedRow = listed.find((m) => m.text.includes('вина'));
  assert.equal(timedRow.indefinite, false);
  assert.equal(timedRow.remainingMonths, 2);
  assert.equal(listed.find((m) => m.text.includes('Комендантский')).indefinite, true);

  const early = expireTimedOrders(domain, 6);
  assert.equal(early.length, 0);
  assert.equal(domain.state.modifiers.length, 2);

  const gone = expireTimedOrders(domain, 7);
  assert.equal(gone.length, 1);
  assert.equal(domain.state.modifiers.length, 1);
  assert.equal(domain.state.modifiers[0].text.includes('Комендантский'), true);
  assert.equal((domain.closedPlotlines || []).some((p) => p.reason === 'истёк срок порядка'), true);
});

test('правка может снять срок и сделать указ бессрочным', async () => {
  const domain = normalizeDomain({
    id: 'd1',
    name: 'Саркум',
    state: { modifiers: [], pendingOrderRequests: [] },
    plotlines: [],
  });
  queueOrderRequest(domain, { action: 'create', text: 'Ночной дозор', tick: 2, durationMonths: 2 });
  await resolvePendingOrders({
    config: { tick: { plot: {} } },
    runtime: null,
    domain,
    world: { tickIndex: 2, gameDate: { label: 'месяц' } },
  });
  const id = domain.state.modifiers[0].id;
  assert.equal(domain.state.modifiers[0].expiresTick, 4);
  queueOrderRequest(domain, { action: 'edit', text: 'Ночной дозор', orderId: id, tick: 3, durationMonths: 0 });
  await resolvePendingOrders({
    config: { tick: { plot: {} } },
    runtime: null,
    domain,
    world: { tickIndex: 3, gameDate: { label: 'месяц' } },
  });
  assert.equal(domain.state.modifiers[0].durationMonths, null);
  assert.equal(domain.state.modifiers[0].expiresTick, null);
  assert.equal(expireTimedOrders(domain, 10).length, 0);
});
