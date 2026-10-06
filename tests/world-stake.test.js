import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFront } from '../src/world/front.js';
import { createWorldObject } from '../src/world/objects.js';
import { applyStake } from '../src/world/stake.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

function domain() {
  return {
    worldObjects: [],
    fronts: [],
    assignments: [],
    stats: {},
    statScale: 1,
    statLedger: { prosperity: 0, influence: 0, knowledge: 0, security: 0 },
    state: {},
    lore: [],
  };
}

test('пять форм ставки меняют мир', async () => {
  const home = domain();
  const ballista = await applyStake({
    config: cfg,
    domain: home,
    front: createFront(cfg, {
      description: 'Строительство баллисты',
      effort: 2,
      stake: {
        create: {
          type: 'structure',
          name: 'Великая баллиста',
          description: 'Дальнобойная баллиста.',
          statEffect: { security: 6 },
        },
      },
    }),
    day: 1,
  });
  assert.equal(home.worldObjects.length, 1);
  assert.equal(ballista.front.status, 'resolved');
  assert.equal(home.stats.security, 6);

  const target = home.worldObjects[0];
  const modified = await applyStake({
    config: cfg,
    domain: home,
    front: createFront(cfg, {
      description: 'Платформа',
      effort: 2,
      stake: {
        modify: {
          target: target.id,
          proposed_version: { description: 'Баллиста на платформе.', statEffect: { security: 8 } },
        },
      },
    }),
    day: 2,
  });
  assert.equal(modified.front.status, 'resolved');
  assert.equal(target.version, 2);
  assert.equal(home.stats.security, 8);

  const revealed = domain();
  await applyStake({
    config: cfg,
    domain: revealed,
    front: createFront(cfg, {
      description: 'Истина',
      effort: 1,
      stake: { reveal: { text: 'Руины были станцией.' } },
    }),
    day: 1,
  });
  assert.equal(revealed.lore.length, 1);

  const taxed = domain();
  await applyStake({
    config: cfg,
    domain: taxed,
    front: createFront(cfg, {
      description: 'Ущерб',
      effort: 1,
      stake: { stats: { prosperity: -6 } },
    }),
    day: 1,
  });
  assert.equal(taxed.stats.prosperity, 0);
  assert.equal(taxed.statLedger.prosperity, -6);

  const doomed = domain();
  const islet = createWorldObject(cfg, { type: 'site', name: 'Островок', statEffect: { knowledge: 3 } });
  doomed.worldObjects.push(islet);
  await applyStake({
    config: cfg,
    domain: doomed,
    front: createFront(cfg, {
      description: 'Снести островок',
      effort: 1,
      stake: { delete: { target: islet.id } },
    }),
    day: 3,
  });
  assert.equal(islet.status, 'deleted');
});

test('защищённый объект нельзя удалить ставкой', async () => {
  const home = domain();
  const city = createWorldObject(cfg, {
    id: 'city-baseline',
    type: 'settlement',
    name: 'Город',
    protected: true,
  });
  home.worldObjects.push(city);
  const result = await applyStake({
    config: cfg,
    domain: home,
    front: createFront(cfg, {
      description: 'Уничтожить город',
      effort: 1,
      stake: { delete: { target: city.id } },
    }),
    day: 1,
  });
  assert.equal(result.error, 'protected');
  assert.equal(result.front.status, 'invalid');
  assert.equal(city.status, 'active');
});
