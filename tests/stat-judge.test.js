import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceForFact, applyFallbackStatDrift, factsForStatJudge, enforceFinishPolarity } from '../src/game/statJudge.js';

const STAT_CONFIG = {
  stats: [
    { id: 'prosperity', name: 'Достаток' },
    { id: 'faith', name: 'Вера' },
  ],
};

test('указ покровителя считается его волей, а не миром', () => {
  assert.equal(sourceForFact({ author: 'storyteller:order' }), 'player');
  assert.equal(sourceForFact({ author: 'storyteller:order-story' }), 'player');
  assert.equal(sourceForFact({ author: 'storyteller:beat' }), 'world');
  assert.equal(sourceForFact({ author: 'storyteller:quiet' }), 'world');
});

test('если оценщик молчит, месяц всё равно сдвигает стат', () => {
  const domain = { stats: { prosperity: 46, faith: 39 } };
  const fact = { id: 'lore_1', text: 'Тихо.' };
  const rng = () => 0.1;
  const result = applyFallbackStatDrift({
    domain,
    config: STAT_CONFIG,
    chronicleAdds: [fact],
    rng,
  });
  assert.ok(result);
  assert.ok(fact.statChanges);
  assert.notEqual(domain.stats.prosperity + domain.stats.faith, 46 + 39);
});

test('если след уже есть, запасной сдвиг не дублирует его', () => {
  const domain = { stats: { prosperity: 46, faith: 39 } };
  const fact = {
    id: 'lore_1',
    text: 'Указ.',
    statChanges: { prosperity: { from: 51, to: 46, delta: -5 } },
  };
  const result = applyFallbackStatDrift({
    domain,
    config: STAT_CONFIG,
    chronicleAdds: [fact],
    rng: () => 0.1,
  });
  assert.equal(result, null);
  assert.equal(domain.stats.prosperity, 46);
});

test('тихий месяц оценщику не отдаём', () => {
  const scored = factsForStatJudge([
    { id: 'q', author: 'storyteller:quiet' },
    { id: 'b', author: 'storyteller:beat' },
  ]);
  assert.deepEqual(scored.map((f) => f.id), ['b']);
});

test('крит без минусов, провал без плюсов', () => {
  assert.deepEqual(enforceFinishPolarity({ prosperity: 3, faith: -2 }, 'crit'), { prosperity: 3 });
  assert.deepEqual(enforceFinishPolarity({ prosperity: 3, faith: -2 }, 'fail'), { faith: -2 });
  assert.deepEqual(enforceFinishPolarity({ prosperity: 3, faith: -2 }, 'ok'), { prosperity: 3, faith: -2 });
});
