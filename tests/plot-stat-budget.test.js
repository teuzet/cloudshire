import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlotline, ensurePlotStatBudget, plotStatForce, boardHasRoom, countOpen, storyStatPockets } from '../src/game/plotlines.js';
import { scaleAffectsToBudget } from '../src/game/plotEngine.js';
import { enforceFinishPolarity } from '../src/game/statJudge.js';

const cfg = { tick: { plot: { stats: { storyStatBudget: {
  SITUATION: { seed: 1, threat: 2, ending: 4 },
  EPISODE: { seed: 2, threat: 2, ending: 6 },
  CRISIS: { seed: 3, threat: 3, ending: 8 },
  RUPTURE: { seed: 4, threat: 4, ending: 10 },
} } } } };

test('RUPTURE: карманы seed/threat/ending, угроза не сумма', () => {
  const plot = createPlotline({ title: 'Гул', type: 'story', gravity: 'RUPTURE' });
  ensurePlotStatBudget(plot, cfg);
  assert.deepEqual(storyStatPockets(plot, cfg), { seed: 4, threat: 4, ending: 10 });
  assert.equal(plotStatForce(plot, { opening: true, config: cfg }), 4);
  assert.equal(plotStatForce(plot, { threat: true, config: cfg }), 4);
  assert.equal(plotStatForce(plot, { ending: true, config: cfg }), 10);
  assert.equal(plotStatForce(plot, { config: cfg }), 0, 'без кармана — ноль');
});

test('концовка 2–3× одной угрозы; мусорный gravity → EPISODE', () => {
  const levels = [
    ['SITUATION', 2, 4],
    ['EPISODE', 2, 6],
    ['CRISIS', 3, 8],
    ['RUPTURE', 4, 10],
  ];
  for (const [gravity, threat, ending] of levels) {
    const plot = createPlotline({ title: gravity, type: 'story', gravity });
    assert.equal(plotStatForce(plot, { threat: true, config: cfg }), threat, gravity);
    assert.equal(plotStatForce(plot, { ending: true, config: cfg }), ending, gravity);
    assert.ok(ending >= threat * 2 && ending <= threat * 3, gravity);
  }
  const garbage = createPlotline({ title: 'Мусор', type: 'story', gravity: 80 });
  assert.deepEqual(storyStatPockets(garbage, cfg), { seed: 2, threat: 2, ending: 6 });
});

test('финиш дела: сумма модулей = бюджет; crit без минусов', () => {
  const deltas = scaleAffectsToBudget(
    [
      { stat: 'prosperity', direction: 'up', force: 'notable' },
      { stat: 'security', direction: 'down', force: 'slight' },
    ],
    6,
  );
  const abs = Object.values(deltas).reduce((s, n) => s + Math.abs(n), 0);
  assert.equal(abs, 6);
  const crit = enforceFinishPolarity({ prosperity: 4, security: -2 }, 'crit');
  assert.deepEqual(crit, { prosperity: 4 });
  const fail = enforceFinishPolarity({ prosperity: 4, security: -2 }, 'fail');
  assert.deepEqual(fail, { security: -2 });
});

test('поручение не занимает доску историй', () => {
  const domain = {
    plotlines: [
      ...Array.from({ length: 5 }, (_, i) => createPlotline({ title: `Нить ${i}`, type: 'story' })),
      { id: 'err_old', type: 'errand', title: 'Поручение' },
    ],
  };
  const counts = countOpen(domain);
  assert.equal(counts.stories, 5);
  assert.equal(counts.errands, 0);
  const room = boardHasRoom(domain, { board: { maxOpen: 5 } });
  assert.equal(room.story, false);
  assert.equal(room.errand, true);
});
