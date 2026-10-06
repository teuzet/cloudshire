import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScenarioDraft, loadScenarioSeed } from '../src/world/scenario.js';
import { testConfig } from './helpers/config.js';

test('зерно сажает объекты и фронт, и они дальше не зависят от зерна', () => {
  const seed = loadScenarioSeed('scenarios/lantern-isle.yaml');
  const domain = { worldObjects: [], fronts: [] };
  const planted = applyScenarioDraft(testConfig(), domain, seed.create, 0);
  assert.equal(planted.objects.length, 2);
  assert.equal(planted.fronts.length, 1);
  assert.equal(domain.fronts[0].id, 'obtain-recipe');
  assert.equal(domain.worldObjects.find((object) => object.id === 'tower').refs[0], 'island');
  assert.ok(domain.fronts[0].effort > 0);
  assert.equal(domain.fronts[0].clues[0].status, 'hidden');
});
