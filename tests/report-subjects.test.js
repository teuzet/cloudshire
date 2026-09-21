import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRIEST_ORDERS,
  priestOrders,
  addPriestOrder,
  findPriestOrder,
  removePriestOrder,
} from '../src/game/priestOrders.js';

function makeDomain() {
  return { state: {} };
}

test('наказ заводится и помнит день', () => {
  const domain = makeDomain();
  const res = addPriestOrder(domain, { subject: '  как идут дела в порту  ', day: 205 });
  assert.equal(res.ok, true);
  assert.equal(res.order.subject, 'как идут дела в порту');
  assert.equal(res.order.sinceDay, 205);
  assert.equal(priestOrders(domain).length, 1);
  assert.equal('everyDays' in res.order, false);
  assert.equal('nextDay' in res.order, false);
});

test('повторный наказ не плодит вторую тему', () => {
  const domain = makeDomain();
  addPriestOrder(domain, { subject: 'дела в порту' });
  const again = addPriestOrder(domain, { subject: 'ДЕЛА В ПОРТУ' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'duplicate');
  assert.equal(priestOrders(domain).length, 1);
});

test('переполнение возвращает предел', () => {
  const domain = makeDomain();
  for (let i = 0; i < MAX_PRIEST_ORDERS; i += 1) {
    addPriestOrder(domain, { subject: `тема ${i}`, day: 0 });
  }
  const res = addPriestOrder(domain, { subject: 'ещё одна' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'too_many');
  assert.equal(res.limit, MAX_PRIEST_ORDERS);
  assert.equal(priestOrders(domain).length, MAX_PRIEST_ORDERS);
});

test('пустой наказ не заводится', () => {
  const domain = makeDomain();
  const res = addPriestOrder(domain, { subject: '   ' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'empty_subject');
  assert.equal(priestOrders(domain).length, 0);
});

test('наказ ищется по словам покровителя и снимается', () => {
  const domain = makeDomain();
  addPriestOrder(domain, { subject: 'как идут дела в порту' });
  const found = findPriestOrder(domain, { subject: 'порт' });
  assert.equal(found.subject, 'как идут дела в порту');
  const removed = removePriestOrder(domain, found.id);
  assert.equal(removed.ok, true);
  assert.equal(priestOrders(domain).length, 0);
});

test('чужие слова наказ не находят', () => {
  const domain = makeDomain();
  addPriestOrder(domain, { subject: 'дела в порту' });
  assert.equal(findPriestOrder(domain, { subject: 'рудники' }), null);
});
