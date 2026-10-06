import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampImpact, complicationHits } from '../src/world/risk.js';
import { riskImpactCap } from '../src/world/scales.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

test('ущерб осложнения не выше потолка риска', () => {
  const cap = riskImpactCap(cfg, 'LOW');
  assert.equal(clampImpact(cfg, 'LOW', 'DEFINING'), cap);
  assert.equal(clampImpact(cfg, 'HIGH', 'MINOR'), 'MINOR');
});

test('нулевой риск не срабатывает, высокий может', () => {
  assert.equal(complicationHits(cfg, 'LOW', 0, () => 0), false);
  assert.equal(complicationHits(cfg, 'HIGH', 6, () => 0), true);
  assert.equal(complicationHits(cfg, 'HIGH', 6, () => 0.99), false);
});
