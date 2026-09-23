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
  statPartsForFact,
  confluxStatRate,
} from '../src/game/statJudge.js';
import { createPlotline } from '../src/game/plotlines.js';

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
  assert.ok(deedStatBudget({ durationBand: 'WEEKS', difficulty: 'PLAIN' }, { tick: { statsPerDeedValue: 5 } }) >= 1);
});

test('провальный удар по городу для жертвы не режет в минус как crit нападавших', () => {
  assert.equal(finishForFact({ pairImpact: { hostile: true, finish: 'fail' } }), 'ok');
  assert.equal(finishForFact({ processFinish: 'crit' }), 'crit');
});

const TICK = { statsPerDeedValue: 5, confluxStatGainModifier: 1.5, crossIslandFailShare: 0.6 };
const CFG = { tick: TICK };

test('курс конфлюкса: deedValue × statsPerDeedValue × 1.5', () => {
  assert.equal(confluxStatRate(), 7.5);
});

test('дело через проход считается deedValue × 5 × 1.5', () => {
  const raid = { crossIsland: true, durationBand: 'WEEKS', difficulty: 'SEVERE' };
  assert.equal(deedStatBudget(raid, CFG, { finish: 'crit' }), 19);
  assert.equal(deedStatBudget(raid, CFG, { finish: 'ok' }), 13);
  assert.equal(deedStatBudget({ ...raid, difficulty: 'HARD' }, CFG, { finish: 'crit' }), 14);
  assert.equal(deedStatBudget({ ...raid, durationBand: 'SEASON', difficulty: 'EXTREME' }, CFG, { finish: 'crit' }), 27);
  const home = { durationBand: 'WEEKS', difficulty: 'PLAIN' };
  assert.equal(deedStatBudget(home, CFG, { finish: 'ok' }), 4);
});

test('мелкая вылазка через проход города почти не двигает', () => {
  const errand = { crossIsland: true, durationBand: 'INSTANT', difficulty: 'TRIVIAL' };
  assert.equal(deedStatBudget(errand, CFG, { finish: 'ok' }), 1);
});

test('отбитый штурм стоит дешевле удавшегося, но не ноль', () => {
  const raid = { crossIsland: true, durationBand: 'WEEKS', difficulty: 'SEVERE' };
  const repelled = deedStatBudget(raid, CFG, { finish: 'fail' });
  assert.equal(repelled, 8);
  assert.ok(repelled < deedStatBudget(raid, CFG, { finish: 'ok' }), 'провал дешевле успеха');
  assert.equal(deedStatBudget(raid, { tick: { ...TICK, crossIslandFailShare: 1 } }, { finish: 'fail' }), 13);
});

test('жертва считается по полосам следа, а не по своему делу', () => {
  const hit = {
    pairImpact: {
      hostile: true,
      crossIsland: true,
      finish: 'crit',
      durationBand: 'WEEKS',
      difficulty: 'SEVERE',
    },
  };
  assert.equal(absBudgetForFact({}, hit, CFG), 19);
  const held = { pairImpact: { ...hit.pairImpact, finish: 'fail' } };
  assert.equal(absBudgetForFact({}, held, CFG), 8);
  assert.equal(finishForFact(held), 'ok');
});

test('нападавший берёт цену со своего дела, включая провал', () => {
  const domain = {
    state: {
      pendingActions: [
        { id: 'act_raid', crossIsland: true, durationBand: 'WEEKS', difficulty: 'SEVERE' },
      ],
    },
  };
  assert.equal(absBudgetForFact(domain, { processFinish: 'crit', relatedPendingId: 'act_raid' }, CFG), 19);
  const lost = absBudgetForFact(domain, { processFinish: 'fail', relatedPendingId: 'act_raid' }, CFG);
  assert.equal(lost, 8);
  assert.deepEqual(enforceFinishPolarity({ security: 2, prosperity: -2 }, 'fail'), { prosperity: -2 });
});

test('дело, продвинувшее глубину, получает очки глубины, а не цену дела', () => {
  const plot = createPlotline({ title: 'Гул', type: 'story', gravity: 'CRISIS', depth: 1.2 });
  const domain = {
    plotlines: [plot],
    state: { pendingActions: [{ id: 'act_1', durationBand: 'WEEKS', difficulty: 'HARD' }] },
  };
  const parts = statPartsForFact(domain, {
    author: 'engine:deed',
    processFinish: 'ok',
    relatedPlotlineIds: [plot.id],
    relatedPendingId: 'act_1',
    depthGain: 1.2,
    statPocket: 'deed',
  }, CFG);
  assert.equal(parts.up, 5);
  assert.equal(parts.down, 0);
  assert.equal(parts.deed, 0);
});

test('провал, закрывший историю, держит минус беды и плюс четверти глубины', () => {
  const plot = createPlotline({ title: 'Обрыв', type: 'story', gravity: 'CRISIS', depth: 2 });
  const domain = { plotlines: [], closedPlotlines: [plot] };
  const parts = statPartsForFact(domain, {
    author: 'engine:deed',
    processFinish: 'fail',
    relatedPlotlineIds: [plot.id],
    statPocket: 'ending',
    plotClosed: true,
    woundBudget: 6,
    endingKind: 'BAD_ENDING',
  }, CFG);
  assert.equal(parts.down, 6);
  assert.equal(parts.up, 2);
  assert.equal(parts.deed, 0);
});

test('завязка — только минус масштаба истории', () => {
  const plot = createPlotline({ title: 'Разлом', type: 'story', gravity: 'RUPTURE' });
  const domain = { plotlines: [plot] };
  const parts = statPartsForFact(domain, {
    author: 'freeform:seed',
    statPocket: 'seed',
    relatedPlotlineIds: [plot.id],
  }, CFG);
  assert.deepEqual(parts, { up: 0, down: 3, deed: 0 });
});
