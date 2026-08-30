import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateStats, syncFaith, applyStatDeltasToDomain } from '../src/game/stats.js';

const STATS = [
  { id: 'prosperity' },
  { id: 'security' },
  { id: 'knowledge' },
  { id: 'influence' },
];
const cfg = { stats: STATS, genesis: { statBudget: 220, statMin: 35, statMax: 75 } };

function sum(stats) {
  return Object.values(stats).reduce((a, b) => a + b, 0);
}

test('равные скоры → 55×4, сумма 220', () => {
  const even = allocateStats({}, cfg);
  assert.deepEqual(even, { prosperity: 55, security: 55, knowledge: 55, influence: 55 });
  assert.equal(sum(even), 220);
  const also = allocateStats({ prosperity: 5, security: 5, knowledge: 5, influence: 5 }, cfg);
  assert.deepEqual(also, even);
});

test('экстремум двух сильных — 75/75/35/35 и сумма 220', () => {
  const stats = allocateStats({ prosperity: 10, security: 10, knowledge: 0, influence: 0 }, cfg);
  const vals = Object.values(stats).sort((a, b) => b - a);
  assert.deepEqual(vals, [75, 75, 35, 35]);
  assert.equal(sum(stats), 220);
  assert.equal(stats.prosperity, 75);
  assert.equal(stats.security, 75);
  assert.equal(stats.knowledge, 35);
  assert.equal(stats.influence, 35);
});

test('клип держит каждый стат в [35, 75]', () => {
  const stats = allocateStats({ prosperity: 100, security: 1, knowledge: 1, influence: 1 }, cfg);
  for (const v of Object.values(stats)) {
    assert.ok(v >= 35 && v <= 75, String(v));
  }
  assert.equal(sum(stats), 220);
});

test('вера = среднее четырёх и пересчитывается после дельт', () => {
  const domain = {
    stats: { prosperity: 75, security: 75, knowledge: 35, influence: 35 },
    state: {},
  };
  assert.equal(syncFaith(domain), 55);
  applyStatDeltasToDomain(domain, { prosperity: -5, knowledge: 3 });
  assert.equal(domain.stats.prosperity, 70);
  assert.equal(domain.stats.knowledge, 38);
  assert.equal(domain.state.faith, Math.round((70 + 75 + 38 + 35) / 4));
});
