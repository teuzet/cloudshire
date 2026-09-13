import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceForFact,
  applyFallbackStatDrift,
  factsForStatJudge,
  enforceFinishPolarity,
  finishForFact,
  deedStatBudget,
  absBudgetForFact,
  confluxStatRate,
} from '../src/game/statJudge.js';

const STAT_CONFIG = {
  stats: [
    { id: 'prosperity', name: 'Благосостояние' },
    { id: 'knowledge', name: 'Знание' },
  ],
};

test('указ покровителя считается его волей, а не миром', () => {
  assert.equal(sourceForFact({ author: 'storyteller:order' }), 'player');
  assert.equal(sourceForFact({ author: 'storyteller:order-story' }), 'player');
  assert.equal(sourceForFact({ author: 'storyteller:beat' }), 'world');
  assert.equal(sourceForFact({ author: 'storyteller:quiet' }), 'world');
});

test('тихий месяц и пропуски оценщика статы не двигают', () => {
  const domain = { stats: { prosperity: 46, knowledge: 39 }, state: {} };
  const fact = { id: 'lore_1', text: 'Тихо.', author: 'storyteller:quiet' };
  const result = applyFallbackStatDrift({
    domain,
    config: STAT_CONFIG,
    chronicleAdds: [fact],
    rng: () => 0.1,
  });
  assert.equal(result, null);
  assert.equal(fact.statChanges, undefined);
  assert.equal(domain.stats.prosperity, 46);
  assert.equal(domain.stats.knowledge, 39);
});

test('тихий месяц оценщику не отдаём', () => {
  const scored = factsForStatJudge([
    { id: 'q', author: 'storyteller:quiet' },
    { id: 'b', author: 'storyteller:beat' },
  ]);
  assert.deepEqual(scored.map((f) => f.id), ['b']);
});

test('крит без минусов, провал без плюсов', () => {
  assert.deepEqual(enforceFinishPolarity({ prosperity: 3, knowledge: -2 }, 'crit'), { prosperity: 3 });
  assert.deepEqual(enforceFinishPolarity({ prosperity: 3, knowledge: -2 }, 'fail'), { knowledge: -2 });
  assert.deepEqual(enforceFinishPolarity({ prosperity: 3, knowledge: -2 }, 'ok'), { prosperity: 3, knowledge: -2 });
});

test('успешный удар по городу для жертвы — потери, не добыча', () => {
  const hit = {
    pairImpact: { hostile: true, finish: 'crit', objectiveDays: 27 },
  };
  assert.equal(finishForFact(hit), 'fail');
  assert.deepEqual(enforceFinishPolarity({ prosperity: 2, security: -3 }, finishForFact(hit)), { security: -3 });
  assert.ok(deedStatBudget({ objectiveDays: 27 }, { tick: { officerStatPerDay: 0.02, officerStatCap: 8 } }) >= 1);
});

test('провальный удар по городу для жертвы не режет в минус как crit нападавших', () => {
  assert.equal(finishForFact({ pairImpact: { hostile: true, finish: 'fail' } }), 'ok');
  assert.equal(finishForFact({ processFinish: 'crit' }), 'crit');
});

const TICK = { officerStatPerDay: 0.02, officerStatCap: 8, crossIslandFailShare: 0.6 };
const CFG = { tick: TICK };

test('курс конфлюкса: единица его глубины стоит как единица глубины разрыва', () => {
  assert.equal(confluxStatRate(), 5);
});

test('дело через проход считается полосами, а поручение дома — днями', () => {
  const raid = { crossIsland: true, durationBand: 'WEEKS', difficulty: 'SEVERE', objectiveDays: 27 };
  assert.equal(deedStatBudget(raid, CFG, { finish: 'crit' }), 9);
  assert.equal(deedStatBudget(raid, CFG, { finish: 'ok' }), 6);
  assert.equal(deedStatBudget({ ...raid, difficulty: 'HARD' }, CFG, { finish: 'crit' }), 6);
  assert.equal(deedStatBudget({ ...raid, durationBand: 'SEASON', difficulty: 'EXTREME' }, CFG, { finish: 'crit' }), 13);
  // Тот же срок без прохода — прежние крохи: поручения статы не фармят.
  assert.equal(deedStatBudget({ objectiveDays: 27 }, CFG), 1);
  assert.equal(deedStatBudget({ objectiveDays: 400 }, CFG), 8);
});

test('мелкая вылазка через проход города не двигает', () => {
  const errand = { crossIsland: true, durationBand: 'INSTANT', difficulty: 'TRIVIAL' };
  assert.equal(deedStatBudget(errand, CFG, { finish: 'ok' }), 1);
});

test('отбитый штурм стоит дешевле удавшегося, но не ноль', () => {
  const raid = { crossIsland: true, durationBand: 'WEEKS', difficulty: 'SEVERE' };
  const repelled = deedStatBudget(raid, CFG, { finish: 'fail' });
  assert.equal(repelled, 4);
  assert.ok(repelled < deedStatBudget(raid, CFG, { finish: 'ok' }), 'провал дешевле успеха');
  // Крит нападавших провалу надбавки не даёт.
  assert.equal(deedStatBudget(raid, { tick: { ...TICK, crossIslandFailShare: 1 } }, { finish: 'fail' }), 6);
});

test('жертва считается по полосам следа, а не по своему делу', () => {
  const hit = {
    pairImpact: {
      hostile: true,
      crossIsland: true,
      finish: 'crit',
      durationBand: 'WEEKS',
      difficulty: 'SEVERE',
      objectiveDays: 27,
    },
  };
  assert.equal(absBudgetForFact({}, hit, CFG), 9);
  // Отбились: тот же след, но дешевле, и знак у защищавшегося не минусовой.
  const held = { pairImpact: { ...hit.pairImpact, finish: 'fail' } };
  assert.equal(absBudgetForFact({}, held, CFG), 4);
  assert.equal(finishForFact(held), 'ok');
});

test('нападавший берёт цену со своего дела, включая провал', () => {
  const domain = {
    state: {
      pendingActions: [
        { id: 'act_raid', crossIsland: true, durationBand: 'WEEKS', difficulty: 'SEVERE', objectiveDays: 27 },
      ],
    },
  };
  assert.equal(absBudgetForFact(domain, { processFinish: 'crit', relatedPendingId: 'act_raid' }, CFG), 9);
  const lost = absBudgetForFact(domain, { processFinish: 'fail', relatedPendingId: 'act_raid' }, CFG);
  assert.equal(lost, 4);
  assert.deepEqual(enforceFinishPolarity({ security: 2, prosperity: -2 }, 'fail'), { prosperity: -2 });
});
