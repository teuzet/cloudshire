import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANA_MAX,
  MANA_TURN_COST,
  MANA_TURN_COST_WITH_TOOLS,
  MANA_BLESS_BY_BAND,
  accrueMana,
  manaExact,
  currentMana,
  blessManaCost,
  turnManaCost,
  canAffordTurn,
  spendMana,
  spendTurnMana,
} from '../src/game/mana.js';
import { DAYS_PER_YEAR } from '../src/game/gameClock.js';
import { deedDurationBand } from '../src/game/deeds.js';

function domain(faith = 50, mana = 0) {
  return { id: 'd1', state: { faith, mana } };
}

test('за реальные сутки приходит ровно столько маны, сколько веры', () => {
  const d = domain(50);
  accrueMana(d, 0);
  accrueMana(d, DAYS_PER_YEAR);
  assert.equal(currentMana(d), 50);
});

test('приход непрерывный, а не порциями раз в два часа', () => {
  const d = domain(60);
  accrueMana(d, 0);
  accrueMana(d, 6);
  assert.ok(manaExact(d) > 0, 'за шесть игровых дней уже что-то накопилось');
  assert.equal(currentMana(d), 1);
  assert.ok(Math.abs(manaExact(d) - 1) < 0.01);
});

test('пропущенные дни доначисляются одним куском', () => {
  const steady = domain(48);
  accrueMana(steady, 0);
  for (let day = 1; day <= 180; day += 1) accrueMana(steady, day);

  const lazy = domain(48);
  accrueMana(lazy, 0);
  accrueMana(lazy, 180);

  assert.ok(Math.abs(manaExact(steady) - manaExact(lazy)) < 0.001);
  assert.equal(currentMana(lazy), 24);
});

test('повторный вызов в тот же день ничего не добавляет', () => {
  const d = domain(100);
  accrueMana(d, 0);
  accrueMana(d, 90);
  const before = manaExact(d);
  assert.equal(accrueMana(d, 90).granted, 0);
  assert.equal(manaExact(d), before);
});

test('мана не переливается через край', () => {
  const d = domain(100, 95);
  accrueMana(d, 0);
  const res = accrueMana(d, DAYS_PER_YEAR);
  assert.equal(res.mana, MANA_MAX);
  assert.equal(currentMana(d), MANA_MAX);
});

test('без веры мана не растёт', () => {
  const d = domain(0, 10);
  accrueMana(d, 0);
  accrueMana(d, DAYS_PER_YEAR);
  assert.equal(currentMana(d), 10);
});

test('игроку показывается целая мана, движок считает дробной', () => {
  const d = domain(50);
  accrueMana(d, 0);
  accrueMana(d, 20);
  assert.ok(!Number.isInteger(manaExact(d)));
  assert.ok(Number.isInteger(currentMana(d)));
  assert.equal(currentMana(d), Math.floor(manaExact(d)));
});

test('ход правителя стоит одну ману, с тулами дороже', () => {
  assert.equal(turnManaCost({}), MANA_TURN_COST);
  assert.equal(turnManaCost({ usedTools: true }), MANA_TURN_COST_WITH_TOOLS);
  assert.ok(MANA_TURN_COST_WITH_TOOLS > MANA_TURN_COST);
});

test('списание за ход снимает ровно цену хода', () => {
  const d = domain(50, 10);
  assert.equal(spendTurnMana(d, { usedTools: true }).ok, true);
  assert.equal(manaExact(d), 8);
  assert.equal(spendTurnMana(d, {}).ok, true);
  assert.equal(manaExact(d), 7);
});

test('онбординг за ману не платит', () => {
  const d = domain(50, 0);
  const res = spendTurnMana(d, { usedTools: true, free: true });
  assert.equal(res.ok, true);
  assert.equal(res.cost, 0);
  assert.equal(manaExact(d), 0);
});

test('на нуле маны ход не проходит', () => {
  const d = domain(50, 0.5);
  assert.equal(canAffordTurn(d), false);
  const res = spendTurnMana(d, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_mana');
  assert.equal(manaExact(d), 0.5, 'неудачное списание ничего не съедает');
});

test('цена благословения зависит от полосы срока, а не от числа месяцев', () => {
  assert.equal(blessManaCost({ durationBand: 'INSTANT' }), MANA_BLESS_BY_BAND.INSTANT);
  assert.equal(blessManaCost({ durationBand: 'YEARS' }), MANA_BLESS_BY_BAND.YEARS);
  const bands = ['INSTANT', 'DAYS', 'WEEKS', 'SEASON', 'YEAR', 'YEARS'];
  for (let i = 1; i < bands.length; i += 1) {
    assert.ok(MANA_BLESS_BY_BAND[bands[i]] > MANA_BLESS_BY_BAND[bands[i - 1]]);
  }
});

test('цена благословения выводится из дней, если полосы нет', () => {
  assert.equal(blessManaCost({ objectiveDays: 2 }), MANA_BLESS_BY_BAND.INSTANT);
  assert.equal(blessManaCost({ objectiveDays: 40 }), MANA_BLESS_BY_BAND.WEEKS);
  assert.equal(blessManaCost({ objectiveDays: 1000 }), MANA_BLESS_BY_BAND.YEARS);
  assert.equal(blessManaCost({}), MANA_BLESS_BY_BAND.WEEKS, 'разумный дефолт');
});

test('цена и восстановленная полоса согласны между собой у старой записи', () => {
  for (const days of [2, 10, 40, 90, 200, 900]) {
    const deed = { objectiveDays: days };
    assert.equal(
      blessManaCost(deed),
      MANA_BLESS_BY_BAND[deedDurationBand(deed)],
      `${days} дн.: цена и подпись «работы на …» должны сходиться`,
    );
  }
});

test('благословение дорогого дела не проходит без запаса', () => {
  const d = domain(50, 10);
  const cost = blessManaCost({ durationBand: 'YEAR' });
  const res = spendMana(d, cost);
  assert.equal(res.ok, false);
  assert.equal(currentMana(d), 10);
});
