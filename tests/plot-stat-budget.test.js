import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlotline, ensurePlotStatBudget, plotStatForce, boardHasRoom, countOpen } from '../src/game/plotlines.js';
import { scaleAffectsToBudget } from '../src/game/plotEngine.js';
import { enforceFinishPolarity } from '../src/game/statJudge.js';

const cfg = { tick: { plot: { stats: { openingShare: 0.25, beatShare: 0.25 } }, officerStatPerMonth: 1 } };

test('RUPTURE → бюджет 20; старт силой 5 remaining не ест', () => {
  const plot = createPlotline({ title: 'Гул', type: 'story', gravity: 'RUPTURE' });
  ensurePlotStatBudget(plot, cfg);
  assert.equal(plot.stats.budget, 20);
  assert.equal(plot.stats.remaining, 20);
  assert.equal(plot.importance, undefined);
  const opening = plotStatForce(plot, { opening: true, config: cfg });
  assert.equal(opening, 5);
  assert.equal(plot.stats.remaining, 20);
});

test('бюджет по enum: 5 / 10 / 15 / 20', () => {
  const levels = [
    ['SITUATION', 5],
    ['EPISODE', 10],
    ['CRISIS', 15],
    ['RUPTURE', 20],
  ];
  for (const [gravity, budget] of levels) {
    const plot = createPlotline({ title: gravity, type: 'story', gravity });
    ensurePlotStatBudget(plot, cfg);
    assert.equal(plot.stats.budget, budget, gravity);
  }
  const garbage = createPlotline({ title: 'Мусор', type: 'story', gravity: 80 });
  ensurePlotStatBudget(garbage, cfg);
  assert.equal(garbage.stats.budget, 10);
});

test('промежуточные события едят бюджет, но не весь: под концовку заперт порог', () => {
  const plot = createPlotline({ title: 'Гул', type: 'story', gravity: 'RUPTURE' });
  ensurePlotStatBudget(plot, cfg);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(plotStatForce(plot, { config: cfg }), 5, `беда ${i + 1}`);
  }
  assert.equal(plot.stats.remaining, 5, 'порог концовки не отдаём');
  assert.equal(plotStatForce(plot, { config: cfg }), 0, 'сверх порога промежуточным не достаётся');
});

test('кривая концовки выходит сама: чисто 20, один провал 15, два 10', () => {
  const payout = (fails) => {
    const plot = createPlotline({ title: 'Гул', type: 'story', gravity: 'RUPTURE' });
    ensurePlotStatBudget(plot, cfg);
    for (let i = 0; i < fails; i += 1) plotStatForce(plot, { config: cfg });
    return plotStatForce(plot, { ending: true, config: cfg });
  };
  assert.equal(payout(0), 20);
  assert.equal(payout(1), 15);
  assert.equal(payout(2), 10);
  assert.equal(payout(3), 5, 'три беды — и на финал остаётся только порог');
});

test('финиш дела на 6 месяцев: сумма модулей = 6; crit без минусов', () => {
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

test('errand не занимает доску историй', () => {
  const domain = {
    plotlines: [
      ...Array.from({ length: 5 }, (_, i) => createPlotline({ title: `Нить ${i}`, type: 'story' })),
      createPlotline({ title: 'Поручение', type: 'errand' }),
    ],
  };
  const counts = countOpen(domain);
  assert.equal(counts.stories, 5);
  assert.equal(counts.errands, 1);
  const room = boardHasRoom(domain, { board: { maxOpen: 5 } });
  assert.equal(room.story, false);
  assert.equal(room.errand, true);
});
