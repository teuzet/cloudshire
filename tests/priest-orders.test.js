import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRIEST_ORDERS,
  REPORT_EVENT_GAP,
  priestOrders,
  eventNo,
  countEvent,
  addPriestOrder,
  removePriestOrder,
  findPriestOrder,
  orderTouchedBy,
  reportGap,
  pickReportSubject,
  markReported,
  formatPriestOrders,
} from '../src/game/priestOrders.js';

function domain() {
  return { id: 'd1', state: {} };
}

/** Наказ, о котором только что докладывали: дальше он должен помолчать. */
function fresh(d, subject) {
  const { order } = addPriestOrder(d, { subject, day: 0 });
  markReported(d, order, { day: 0 });
  return order;
}

test('наказ — тема без расписания', () => {
  const d = domain();
  const res = addPriestOrder(d, { subject: 'как идут дела в порту', day: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.order.subject, 'как идут дела в порту');
  assert.equal(res.order.sinceDay, 100);
  assert.equal(res.order.lastDay, null);
  assert.equal(res.order.lastEventNo, null);
  assert.equal('everyDays' in res.order, false, 'каденции у наказа нет');
  assert.equal('nextDay' in res.order, false, 'срока следующего доклада тоже');
  assert.equal(priestOrders(d).length, 1);
});

test('пустой наказ не принимается, повторный — тоже', () => {
  const d = domain();
  assert.equal(addPriestOrder(d, { subject: '   ' }).error, 'empty_subject');
  assert.equal(addPriestOrder(d, { subject: 'порт' }).ok, true);
  const dup = addPriestOrder(d, { subject: 'ПОРТ' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate');
  assert.equal(priestOrders(d).length, 1);
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

test('наказ снимается по id и ищется по тексту', () => {
  const d = domain();
  const { order } = addPriestOrder(d, { subject: 'дела в порту', day: 0 });
  assert.equal(findPriestOrder(d, { orderId: order.id })?.id, order.id);
  assert.equal(findPriestOrder(d, { subject: 'порт' })?.id, order.id);
  assert.equal(findPriestOrder(d, { subject: 'рудник' }), null);
  assert.equal(removePriestOrder(d, order.id).ok, true);
  assert.equal(priestOrders(d).length, 0);
  assert.equal(removePriestOrder(d, order.id).error, 'not_found');
});

test('первый же доклад можно отдать сразу: свежая тема не ждёт', () => {
  const d = domain();
  const { order } = addPriestOrder(d, { subject: 'порт', day: 0 });
  assert.equal(reportGap(d, order), Infinity);
  assert.equal(pickReportSubject(d, { texts: ['о чём-то своём'] })?.id, order.id);
});

test('после доклада тема молчит, пока не пройдут другие события', () => {
  const d = domain();
  const order = fresh(d, 'порт');
  assert.equal(pickReportSubject(d), null, 'сразу второй раз — нет');
  for (let i = 0; i < REPORT_EVENT_GAP - 1; i += 1) countEvent(d);
  assert.equal(pickReportSubject(d), null, 'зазор ещё не выдержан');
  countEvent(d);
  assert.equal(pickReportSubject(d)?.id, order.id);
});

test('задетая событием тема идёт первой, иначе — самая забытая', () => {
  const d = domain();
  const port = fresh(d, 'дела в порту');
  const mine = fresh(d, 'что на рудниках');
  // Рудник забыт дольше: о порте докладывали позже, уже после нескольких событий.
  for (let i = 0; i < REPORT_EVENT_GAP; i += 1) countEvent(d);
  markReported(d, port, { day: 1 });
  for (let i = 0; i < REPORT_EVENT_GAP; i += 1) countEvent(d);
  assert.ok(reportGap(d, mine) > reportGap(d, port));
  assert.equal(pickReportSubject(d)?.id, mine.id, 'без повода — самая забытая');
  assert.equal(
    pickReportSubject(d, { texts: ['в порту сгорел лоток досмотрщика'] })?.id,
    port.id,
    'повод перебивает забытость',
  );
});

test('короткие и служебные слова темой не считаются', () => {
  const order = { subject: 'как идут дела в порту' };
  assert.equal(orderTouchedBy(order, ['в городе идут дела']), false, 'не по стоп-словам');
  assert.equal(orderTouchedBy(order, ['у порту прибыло']), true);
  assert.equal(orderTouchedBy(order, []), false);
});

test('доклад двигает счётчик события, а не календарь', () => {
  const d = domain();
  const { order } = addPriestOrder(d, { subject: 'порт', day: 0 });
  countEvent(d);
  countEvent(d);
  markReported(d, order, { day: 42 });
  assert.equal(order.lastDay, 42);
  assert.equal(order.lastEventNo, eventNo(d));
  assert.equal(order.times, 1);
});

test('наказы читаются для промпта', () => {
  const d = domain();
  addPriestOrder(d, { subject: 'как идут дела в порту', day: 0 });
  assert.equal(formatPriestOrders(d), '- как идут дела в порту');
  assert.equal(formatPriestOrders(domain()), '');
});
