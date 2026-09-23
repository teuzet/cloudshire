import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlotline,
  ensurePlotStatBudget,
  boardHasRoom,
  countOpen,
  seedStatBudget,
  woundBudgetRange,
  rollWoundStatBudget,
  depthStatPoints,
  endingStatPoints,
} from '../src/game/plotlines.js';
import { scaleAffectsToBudget } from '../src/game/plotEngine.js';
import { enforceFinishPolarity } from '../src/game/statJudge.js';

const cfg = { tick: { plot: { stats: {
  pointsPerDepth: 4,
  endingDepthShare: 0.25,
  seedBudget: { SITUATION: 1, EPISODE: 1, CRISIS: 2, RUPTURE: 3 },
  woundBudget: {
    SITUATION: [1, 2],
    EPISODE: [2, 4],
    CRISIS: [4, 8],
    RUPTURE: [8, 12],
  },
} } } };

test('завязка — минус масштаба истории: 1, 1, 2, 3', () => {
  const levels = [
    ['SITUATION', 1],
    ['EPISODE', 1],
    ['CRISIS', 2],
    ['RUPTURE', 3],
  ];
  for (const [gravity, seed] of levels) {
    const plot = createPlotline({ title: gravity, type: 'story', gravity });
    ensurePlotStatBudget(plot, cfg);
    assert.equal(seedStatBudget(plot, cfg), seed, gravity);
    assert.equal(plot.stats.seed, seed, gravity);
    assert.equal(plot.stats.pointsPerDepth, 4);
    assert.equal(plot.stats.endingDepthShare, 0.25);
  }
  const garbage = createPlotline({ title: 'Мусор', type: 'story', gravity: 80 });
  assert.equal(seedStatBudget(garbage, cfg), 1);
});

test('беда кидает свой масштаб, границы включительно', () => {
  const levels = [
    ['SITUATION', 1, 2],
    ['EPISODE', 2, 4],
    ['CRISIS', 4, 8],
    ['RUPTURE', 8, 12],
  ];
  for (const [scale, min, max] of levels) {
    assert.deepEqual(woundBudgetRange(scale, cfg), [min, max], scale);
    assert.equal(rollWoundStatBudget(scale, cfg, () => 0), min, scale);
    assert.equal(rollWoundStatBudget(scale, cfg, () => 0.999999), max, scale);
  }
});

test('глубина даёт очки шагу, закрытие — четверть уже набранной', () => {
  assert.equal(depthStatPoints(1.2, cfg), 5);
  assert.equal(depthStatPoints(0.02, cfg), 0);
  assert.equal(depthStatPoints(0, cfg), 0);
  const plot = createPlotline({ title: 'Гул', type: 'story', gravity: 'RUPTURE', depth: 2 });
  assert.equal(endingStatPoints(plot, cfg), 2);
  plot.depth = 0;
  assert.equal(endingStatPoints(plot, cfg), 0);
});

test('плюс и минус одной хроники не делятся пополам и не гасят друг друга на разных сторонах', () => {
  const deltas = scaleAffectsToBudget(
    [
      { stat: 'prosperity', direction: 'up', force: 'notable' },
      { stat: 'security', direction: 'down', force: 'slight' },
    ],
    0,
    { polarity: 'split', upBudget: 2, downBudget: 6 },
  );
  assert.equal(deltas.prosperity, 2);
  assert.equal(deltas.security, -6);
  const abs = Object.values(deltas).reduce((s, n) => s + Math.abs(n), 0);
  assert.equal(abs, 8);
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
