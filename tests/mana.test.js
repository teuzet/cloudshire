import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantManaForTick, blessManaCost, spendMana, currentMana, MANA_MAX } from '../src/game/mana.js';

function domain(extra = {}) {
  return { state: { faith: 50, mana: 0, manaAccrue: 0, ...extra } };
}

test('за 12 тиков приходит ровно столько маны, сколько веры', () => {
  const d = domain({ faith: 50 });
  let total = 0;
  for (let i = 0; i < 12; i += 1) {
    total += grantManaForTick(d).granted;
  }
  assert.equal(total, 50);
  assert.equal(currentMana(d), 50);
  assert.equal(d.state.manaAccrue, 0);
});

test('вера 7 за год даёт ровно 7, без потери остатка', () => {
  const d = domain({ faith: 7 });
  let total = 0;
  for (let i = 0; i < 12; i += 1) {
    total += grantManaForTick(d).granted;
  }
  assert.equal(total, 7);
  assert.equal(currentMana(d), 7);
});

test('мана не выходит за 100', () => {
  const d = domain({ faith: 80, mana: 95 });
  const { granted, mana } = grantManaForTick(d);
  assert.equal(mana, MANA_MAX);
  assert.ok(granted <= 5);
  assert.equal(currentMana(d), 100);
});

test('стоимость благословения — 10 за месяц базовой длительности', () => {
  assert.equal(blessManaCost({ objectiveMonths: 4, expectedMonths: 1 }), 40);
  assert.equal(blessManaCost({ objectiveMonths: 11 }), 110);
  assert.equal(blessManaCost({ expectedMonths: 2 }), 20);
});

test('дело на 11 месяцев при капе 100 благословить нельзя', () => {
  const d = domain({ mana: 100 });
  const cost = blessManaCost({ objectiveMonths: 11 });
  assert.equal(cost, 110);
  const paid = spendMana(d, cost);
  assert.equal(paid.ok, false);
  assert.equal(paid.error, 'no_mana');
  assert.equal(currentMana(d), 100);
});
