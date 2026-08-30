import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceForFact, applyFallbackStatDrift, factsForStatJudge, enforceFinishPolarity } from '../src/game/statJudge.js';

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
