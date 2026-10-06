import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorldObject, deleteWorldObject } from '../src/world/objects.js';
import { addToLedger, recomputeStats } from '../src/world/statSum.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

function domainWith(objects, { scale = 1, ledger = null } = {}) {
  return {
    worldObjects: objects,
    statScale: scale,
    statLedger: ledger || { prosperity: 0, influence: 0, knowledge: 0, security: 0 },
    stats: {},
    state: {},
  };
}

test('два объекта масштабируются одним коэффициентом', () => {
  const domain = domainWith(
    [
      createWorldObject(cfg, {
        type: 'structure',
        name: 'Баллиста',
        statEffect: { prosperity: 3, influence: 1 },
      }),
      createWorldObject(cfg, {
        type: 'practice',
        name: 'Школа',
        statEffect: { prosperity: 4, knowledge: 2, security: 1 },
      }),
    ],
    { scale: 2 },
  );
  const stats = recomputeStats(domain, cfg);
  assert.equal(stats.prosperity, 14);
  assert.equal(stats.influence, 2);
  assert.equal(stats.knowledge, 4);
  assert.equal(stats.security, 2);
});

test('ledger двигает стат и не трогает объекты', () => {
  const objects = [
    createWorldObject(cfg, {
      type: 'structure',
      name: 'Баллиста',
      statEffect: { prosperity: 10, security: 6 },
    }),
  ];
  const before = objects[0].statEffect.prosperity;
  const domain = domainWith(objects, { scale: 1 });
  recomputeStats(domain, cfg);
  addToLedger(domain, { prosperity: -6 }, cfg);
  assert.equal(domain.stats.prosperity, 4);
  assert.equal(objects[0].statEffect.prosperity, before);
});

test('удаление объекта снимает его вклад', () => {
  const ballista = createWorldObject(cfg, {
    type: 'structure',
    name: 'Баллиста',
    statEffect: { security: 6, prosperity: 2 },
  });
  const domain = domainWith([ballista], { scale: 1 });
  recomputeStats(domain, cfg);
  assert.equal(domain.stats.security, 6);
  deleteWorldObject(ballista, 1);
  recomputeStats(domain, cfg);
  assert.equal(domain.stats.security, 0);
});

test('стат не выходит за 0..100', () => {
  const domain = domainWith(
    [createWorldObject(cfg, { type: 'resource', name: 'Жила', statEffect: { prosperity: 140 } })],
    { scale: 1 },
  );
  recomputeStats(domain, cfg);
  assert.equal(domain.stats.prosperity, 100);
});

test('вера равна среднему четырёх статов', () => {
  const domain = domainWith(
    [
      createWorldObject(cfg, {
        type: 'settlement',
        name: 'Город',
        statEffect: { prosperity: 40, influence: 20, knowledge: 10, security: 30 },
      }),
    ],
    { scale: 1 },
  );
  recomputeStats(domain, cfg);
  const vals = ['prosperity', 'influence', 'knowledge', 'security'].map((id) => domain.stats[id]);
  assert.equal(domain.state.faith, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
});
