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
} from '../src/game/orders.js';
import { resolvePendingOrders } from '../src/game/orderSmith.js';
import { plotConfig, liveStoryImportance, countOpen } from '../src/game/plotlines.js';
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

test('расписание хочет тик в срок, иначе — по вероятности', () => {
  const due = { kind: 'order', nextDueTick: 5, fireChance: 0 };
  assert.equal(orderWantsTick(due, 5, () => 0).want, true);
  assert.equal(orderWantsTick(due, 5, () => 0).scheduled, true);
  assert.equal(orderWantsTick(due, 4, () => 0).want, false);
  const chance = { kind: 'order', nextDueTick: null, fireChance: 0.4 };
  assert.equal(orderWantsTick(chance, 3, () => 0.1).want, true);
  assert.equal(orderWantsTick(chance, 3, () => 0.9).want, false);
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

test('нет слота — расписание переносится, вероятностный указ молчит', () => {
  const domain = {
    plotlines: [
      { id: 'o_due', title: 'Избранный', kind: 'order', nextDueTick: 8, fireChance: 0, scheduleEveryMonths: 2 },
      { id: 'o_maybe', title: 'Налог', kind: 'order', nextDueTick: null, fireChance: 1 },
    ],
  };
  const planned = planOrderTicks({ domain, slotsLeft: 0, tick: 8, rng: () => 0 });
  assert.equal(planned.length, 0);
  assert.equal(domain.plotlines[0].nextDueTick, 9);
  assert.equal(domain.plotlines[1].nextDueTick, null);
});

test('после срабатывания расписание ставит следующий срок', () => {
  const plot = { scheduleEveryMonths: 2, nextDueTick: 4, beatCount: 0 };
  markOrderFired(plot, 4);
  assert.equal(plot.nextDueTick, 6);
  assert.equal(plot.beatCount, 1);
});
