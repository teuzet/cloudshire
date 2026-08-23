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
} from '../src/game/processes.js';
import { rollProcessFinish } from '../src/game/rolls.js';

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
