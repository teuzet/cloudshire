import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_CADENCES,
  CADENCE_DAYS,
  MAX_PRIEST_ORDERS,
  parseCadence,
  priestOrders,
  addPriestOrder,
  removePriestOrder,
  dueReports,
  markReported,
  formatPriestOrders,
} from '../src/game/priestOrders.js';
import { DAYS_PER_MONTH } from '../src/game/gameClock.js';

function domain() {
  return { id: 'd1', state: {} };
}

test('каденция — enum, а не произвольное число дней', () => {
  assert.deepEqual(REPORT_CADENCES, ['месяц', 'сезон', 'год']);
  assert.equal(parseCadence('СЕЗОН'), 'сезон');
  assert.equal(parseCadence('каждый час'), 'месяц', 'мусор падает на самую редкую разумную');
  assert.equal(CADENCE_DAYS['месяц'], DAYS_PER_MONTH);
  assert.equal(CADENCE_DAYS['год'], 360);
});

test('наказ ставится со сроком первого доклада', () => {
  const d = domain();
  const res = addPriestOrder(d, { subject: 'как идут дела в порту', cadence: 'сезон', day: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.order.everyDays, 90);
  assert.equal(res.order.nextDay, 190);
  assert.equal(res.order.lastDay, null);
  assert.equal(priestOrders(d).length, 1);
});

test('пустой наказ не принимается', () => {
  assert.equal(addPriestOrder(domain(), { subject: '   ' }).error, 'empty_subject');
});

test('больше трёх наказов не берём — это уже поток докладов', () => {
  const d = domain();
  for (let i = 0; i < MAX_PRIEST_ORDERS; i += 1) {
    assert.equal(addPriestOrder(d, { subject: `тема ${i}`, day: 0 }).ok, true);
  }
  const res = addPriestOrder(d, { subject: 'ещё одна', day: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'too_many');
  assert.equal(res.limit, MAX_PRIEST_ORDERS);
});

test('наказ снимается по id', () => {
  const d = domain();
  const { order } = addPriestOrder(d, { subject: 'порт', day: 0 });
  assert.equal(removePriestOrder(d, order.id).ok, true);
  assert.equal(priestOrders(d).length, 0);
  assert.equal(removePriestOrder(d, order.id).error, 'not_found');
});

test('доклад созревает по своему дню и переносится вперёд', () => {
  const d = domain();
  const { order } = addPriestOrder(d, { subject: 'порт', cadence: 'месяц', day: 0 });
  assert.deepEqual(dueReports(d, 29), []);
  assert.deepEqual(dueReports(d, 30).map((o) => o.id), [order.id]);
  markReported(order, 30);
  assert.equal(order.lastDay, 30);
  assert.equal(order.nextDay, 60);
  assert.deepEqual(dueReports(d, 45), []);
});

test('чаще раза в игровой месяц наказ не срабатывает', () => {
  const order = { id: 'r1', subject: 'порт', cadence: 'месяц', everyDays: 1, nextDay: 0 };
  markReported(order, 100);
  assert.equal(order.nextDay, 100 + DAYS_PER_MONTH);
});

test('просроченный доклад не копит долги', () => {
  const d = domain();
  const { order } = addPriestOrder(d, { subject: 'порт', cadence: 'месяц', day: 0 });
  markReported(order, 200);
  assert.equal(order.nextDay, 230, 'следующий срок считается от факта, не от плана');
  assert.deepEqual(dueReports(d, 210), []);
});

test('наказы читаются для промпта', () => {
  const d = domain();
  addPriestOrder(d, { subject: 'как идут дела в порту', cadence: 'сезон', day: 0 });
  assert.equal(formatPriestOrders(d), '- как идут дела в порту (раз в сезон)');
  assert.equal(formatPriestOrders(domain()), '');
});
