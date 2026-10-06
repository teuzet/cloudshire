import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeChange } from '../src/world/cascade.js';
import { createFront } from '../src/world/front.js';
import { createWorldObject } from '../src/world/objects.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

test('каскад идёт по одному подписчику и не показывает граф целиком', async () => {
  const island = createWorldObject(cfg, { id: 'island', type: 'site', name: 'Остров' });
  const tower = createWorldObject(cfg, { id: 'tower', type: 'structure', name: 'Башня', refs: ['island'] });
  const recipe = createFront(cfg, { id: 'obtain-recipe', description: 'Добыть рецепт', refs: ['tower'], effort: 4 });
  const substance = createFront(cfg, { id: 'obtain-substance', description: 'Добыть вещество', refs: ['tower'], effort: 4 });
  const domain = { worldObjects: [island, tower], fronts: [recipe, substance] };
  const seen = [];
  await cascadeChange(cfg, domain, { id: 'island', kind: 'deleted' }, {
    updater: async (change, entity) => {
      seen.push({ change: change.id, entity: entity.id });
      const refs = entity.refs || [];
      if (refs.includes(change.id)) return { verdict: 'invalid' };
      return { verdict: 'unchanged' };
    },
  });
  assert.deepEqual(seen.map((item) => item.entity), ['tower', 'obtain-recipe', 'obtain-substance']);
  assert.ok(seen.every((item) => item.entity));
  assert.equal(tower.status, 'deleted');
  assert.equal(recipe.status, 'invalid');
  assert.equal(substance.status, 'invalid');
  const batches = seen.map((item) => item.entity);
  assert.equal(new Set(batches).size, batches.length);
});
