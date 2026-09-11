import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorldTick } from '../src/game/tick.js';

test('мировой тик отдаёт world и не двигает календарь сам по себе', async () => {
  const now = Date.now();
  const world = { id: 'w1', tickIndex: 4, gameDate: { year: 1, month: 5, label: 'Год 1, месяц 5' } };
  const storage = {
    async getWorld() {
      return world;
    },
    async saveWorld() {},
    async listDomains() {
      return [];
    },
    async saveDomain() {},
  };
  const result = await runWorldTick({ storage, app: {} });
  assert.equal(result.world, world);
  assert.equal(result.world.tickIndex, 4);
  assert.equal(result.tickIndex, 4);
  assert.equal(result.world.dayIndex, 120);
  assert.ok(Array.isArray(result.results));
  assert.ok(world.epochAt);
  const epoch = Date.parse(world.epochAt);
  assert.ok(Math.abs(now - epoch - 120 * 4 * 60 * 1000) < 2000);
});
