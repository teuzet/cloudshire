import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProcess,
  reviseProcess,
  applyObjectiveSchedule,
  setRemainingMonths,
  processIsFresh,
  processPaceRatio,
  applyEngineProgress,
  blessProcess,
  processOwnedBy,
} from '../src/game/processes.js';
import { rollProcessFinish, finishFailChance, formatFinishForPrompt, FINISH_SHORT, applyBlessShift } from '../src/game/rolls.js';

function action(extra = {}) {
  return normalizeProcess({
    id: 'act_1',
    summary: 'Разбор хищения',
    detail: 'Допросить Левру и сверить книги.',
    expectedMonths: 3,
    monthsLeft: 3,
    monthsDone: 0,
    linkedStats: ['knowledge'],
    status: 'active',
    ...extra,
  });
}

test('нулевой месяц переписывает дело, дальше только дополняет', () => {
  const fresh = action();
  const rewritten = reviseProcess(fresh, {
    summary: 'Хищение и сообщники',
    detail: 'Допросить Левру и искать сообщников.',
  });
  assert.equal(rewritten.fresh, true);
  assert.equal(rewritten.rewritten, true);
  assert.equal(fresh.summary, 'Хищение и сообщники');
  assert.equal(fresh.detail, 'Допросить Левру и искать сообщников.');

  const going = action({ monthsDone: 1, monthsLeft: 2, expectedMonths: 3 });
  const topped = reviseProcess(going, {
    detail: 'Выяснить, был ли сообщник.',
  });
  assert.equal(topped.fresh, false);
  assert.equal(topped.rewritten, false);
  assert.match(going.detail, /Допросить Левру/);
  assert.match(going.detail, /сообщник/);
});

test('цель дела опциональна и уточняется отдельно', () => {
  const a = action();
  assert.equal(a.goal, undefined);
  reviseProcess(a, { goal: 'Вернуть пластину и назвать вора.' });
  assert.equal(a.goal, 'Вернуть пластину и назвать вора.');
  const going = action({ monthsDone: 1, monthsLeft: 2, expectedMonths: 3 });
  reviseProcess(going, { goal: '  Найти сообщника  ' });
  assert.equal(going.goal, 'Найти сообщника');
  const outcomes = applyEngineProgress(
    { stats: { knowledge: 50 }, state: { pendingActions: [going] } },
    [{ processId: 'act_1', kind: 'normal', advance: 2 }],
    { tick: 3, rng: () => 0.5 },
  );
  assert.equal(outcomes[0].goal, 'Найти сообщника');
});

test('оставшийся срок нельзя ужать меньше месяца', () => {
  const a = action({ monthsDone: 1, monthsLeft: 2, expectedMonths: 3, objectiveMonths: 3 });
  setRemainingMonths(a, 0);
  assert.equal(a.monthsLeft, 1);
  assert.equal(a.expectedMonths, 2);
});

test('спешка уменьшает шанс успеха, обстоятельность — шанс провала', () => {
  const base = rollProcessFinish(50, 1, () => 0);
  const haste = rollProcessFinish(50, 1 / 3, () => 0);
  const care = rollProcessFinish(50, 2, () => 0);
  assert.ok(haste.weights.fail > base.weights.fail);
  assert.ok(haste.weights.ok + haste.weights.crit < base.weights.ok + base.weights.crit);
  assert.ok(care.weights.fail < base.weights.fail);
});

test('исход дела: 40 ≈ 45% провала, 60–70 ≈ 10–15%, 90+ без провала', () => {
  assert.equal(Math.round(finishFailChance(40) * 100), 45);
  assert.equal(Math.round(finishFailChance(60) * 100), 15);
  assert.equal(Math.round(finishFailChance(65) * 100), 13);
  assert.equal(Math.round(finishFailChance(70) * 100), 10);
  assert.equal(finishFailChance(90), 0);
  assert.equal(finishFailChance(100), 0);
  assert.equal(rollProcessFinish(40, 1, () => 0).weights.fail, 45);
  assert.equal(rollProcessFinish(60, 1, () => 0).weights.fail, 15);
  assert.equal(rollProcessFinish(70, 1, () => 0).weights.fail, 10);
  assert.equal(rollProcessFinish(90, 1, () => 0).weights.fail, 0);
  assert.equal(rollProcessFinish(90, 1 / 3, () => 0).weights.fail, 0);
  assert.equal(rollProcessFinish(90, 1, () => 0).finish, 'ok');
});

test('завершение дела кидает исход и не срывает поручение из-за провала', () => {
  const process = action({
    monthsLeft: 1,
    monthsDone: 2,
    expectedMonths: 3,
    objectiveMonths: 3,
  });
  const domain = {
    stats: { knowledge: 10 },
    state: { pendingActions: [process] },
  };
  const outcomes = applyEngineProgress(
    domain,
    [{ processId: 'act_1', kind: 'normal', advance: 1 }],
    { tick: 9, rng: () => 0.99 },
  );
  assert.equal(outcomes[0].finished, true);
  assert.ok(['fail', 'ok', 'crit'].includes(outcomes[0].finish));
  assert.match(outcomes[0].finishLabel, /\[(ПРОВАЛ|УСПЕХ|КРИТИЧЕСКИЙ УСПЕХ)\]/);
  assert.equal(process.status, 'resolved');
  assert.ok(process.finishKind);
});

test('объективный срок живёт отдельно от назначенного', () => {
  const a = action();
  applyObjectiveSchedule(a, 4, 1);
  assert.equal(a.objectiveMonths, 4);
  assert.equal(a.monthsLeft, 1);
  assert.ok(processPaceRatio(a) < 1);
  assert.equal(processIsFresh(a), true);
});

test('благословение своего дела сдвигает исход на ступень вверх', () => {
  const process = action({
    monthsLeft: 1,
    monthsDone: 2,
    expectedMonths: 3,
    objectiveMonths: 3,
  });
  const blessed = blessProcess(process, { tick: 4 });
  assert.equal(blessed.ok, true);
  assert.equal(process.blessed, true);
  assert.equal(process.blessedTick, 4);
  assert.equal(process.blessCost, 30);
  const again = blessProcess(process);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_blessed');

  const domain = {
    stats: { knowledge: 10 },
    state: { pendingActions: [process] },
  };
  const outcomes = applyEngineProgress(
    domain,
    [{ processId: 'act_1', kind: 'normal', advance: 1 }],
    { tick: 9, rng: () => 0 },
  );
  assert.equal(outcomes[0].finished, true);
  assert.equal(outcomes[0].finish, 'ok');
  assert.equal(process.finishRolled, 'fail');
  assert.equal(outcomes[0].blessed, true);
  assert.match(outcomes[0].finishLabel, /благослов/i);
  assert.match(outcomes[0].finishLabel, /\[УСПЕХ\]/);
  assert.equal(process.finishKind, 'ok');
  assert.equal(process.finishBlessed, true);
});

test('благословение без маны не ставится', () => {
  const process = action({ objectiveMonths: 3, expectedMonths: 3 });
  const domain = { state: { mana: 20, pendingActions: [process] } };
  const denied = blessProcess(process, { tick: 1, domain });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'no_mana');
  assert.equal(process.blessed, false);
  assert.equal(domain.state.mana, 20);

  domain.state.mana = 30;
  const paid = blessProcess(process, { tick: 1, domain });
  assert.equal(paid.ok, true);
  assert.equal(paid.cost, 30);
  assert.equal(domain.state.mana, 0);
  assert.equal(process.blessed, true);
});

test('закрытое дело благословить нельзя, чужое — не своё', () => {
  const done = action({ status: 'resolved' });
  assert.equal(blessProcess(done).error, 'not_active');
  assert.equal(processOwnedBy({ ownerDomainId: 'a' }, 'a'), true);
  assert.equal(processOwnedBy({ ownerDomainId: 'b' }, 'a'), false);
  assert.equal(processOwnedBy({ summary: 'местное' }, 'a'), true);
});

test('токен исхода в промпте совпадает со словарём', () => {
  assert.equal(FINISH_SHORT.fail, '[ПРОВАЛ]');
  assert.equal(FINISH_SHORT.ok, '[УСПЕХ]');
  assert.equal(FINISH_SHORT.crit, '[КРИТИЧЕСКИЙ УСПЕХ]');
  assert.equal(applyBlessShift('fail'), 'ok');
  assert.equal(applyBlessShift('ok'), 'crit');
  assert.equal(applyBlessShift('crit'), 'crit');
  assert.match(formatFinishForPrompt('fail'), /^\[ПРОВАЛ\]\. \[ПРОВАЛ\]:/);
  assert.match(formatFinishForPrompt('ok'), /^\[УСПЕХ\]\. \[УСПЕХ\]:/);
  assert.match(formatFinishForPrompt('crit'), /^\[КРИТИЧЕСКИЙ УСПЕХ\]\. \[КРИТИЧЕСКИЙ УСПЕХ\]:/);
  assert.match(formatFinishForPrompt('ok', { blessed: true }), /^\[УСПЕХ\]\./);
  assert.match(formatFinishForPrompt('crit', { blessed: true }), /сдвинул/);
  assert.doesNotMatch(formatFinishForPrompt('ok', { blessed: true }), /гарант/i);
});
