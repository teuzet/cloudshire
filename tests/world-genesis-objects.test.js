import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statBudgetConfig } from '../src/game/stats.js';
import { deleteWorldObject } from '../src/world/objects.js';
import { buildGenesisObjects } from '../src/world/genesisObjects.js';
import { recomputeStats } from '../src/world/statSum.js';
import { genesisObjectBounds, impactLevels, objectLimits } from '../src/world/scales.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();
const ids = ['prosperity', 'influence', 'knowledge', 'security'];

function draftsOf(count) {
  const weights = impactLevels(cfg).filter((level) => level !== 'NONE');
  const drafts = [];
  for (let i = 0; i < count; i += 1) {
    const profile = { prosperity: 0, influence: 0, knowledge: 0, security: 0 };
    profile[ids[i % ids.length]] = 3;
    profile[ids[(i + 1) % ids.length]] = i % 2 === 0 ? -1 : 1;
    drafts.push({
      type: 'structure',
      name: `Объект ${i + 1}`,
      description: 'Часть города.',
      weight: weights[i % weights.length],
      stat_profile: profile,
    });
  }
  return drafts;
}

test('генезис сводит статы к бюджету и коридору', () => {
  const { budget, min, max } = statBudgetConfig(cfg);
  const built = buildGenesisObjects({
    drafts: draftsOf(genesisObjectBounds(cfg).minCount),
    config: cfg,
    cityName: 'Терракота',
    day: 0,
  });
  const sum = Object.values(built.stats).reduce((a, b) => a + b, 0);
  assert.equal(sum, budget);
  for (const value of Object.values(built.stats)) {
    assert.ok(value >= min && value <= max, String(value));
  }
});

test('пересчёт статов совпадает с тем, что собрал генезис', () => {
  const built = buildGenesisObjects({
    drafts: draftsOf(genesisObjectBounds(cfg).minCount),
    config: cfg,
    cityName: 'Терракота',
    day: 0,
  });
  const domain = {
    worldObjects: built.objects,
    statScale: built.statScale,
    statLedger: { prosperity: 0, influence: 0, knowledge: 0, security: 0 },
    stats: {},
    state: {},
  };
  recomputeStats(domain, cfg);
  assert.deepEqual(domain.stats, built.stats);
});

test('базовый объект города защищён от удаления', () => {
  const built = buildGenesisObjects({
    drafts: draftsOf(genesisObjectBounds(cfg).minCount),
    config: cfg,
    cityName: 'Терракота',
  });
  const baseline = built.objects.find((obj) => obj.id === objectLimits(cfg).baselineId);
  assert.ok(baseline);
  assert.equal(baseline.protected, true);
  assert.equal(baseline.name, 'Терракота');
});

test('удаление обычного объекта меняет статы', () => {
  const built = buildGenesisObjects({
    drafts: draftsOf(genesisObjectBounds(cfg).minCount),
    config: cfg,
    cityName: 'Терракота',
  });
  const domain = {
    worldObjects: built.objects,
    statScale: built.statScale,
    statLedger: { prosperity: 0, influence: 0, knowledge: 0, security: 0 },
    stats: {},
    state: {},
  };
  recomputeStats(domain, cfg);
  const before = { ...domain.stats };
  const victim = built.objects.find((obj) => obj.id !== objectLimits(cfg).baselineId);
  deleteWorldObject(victim, 1);
  recomputeStats(domain, cfg);
  assert.notDeepEqual(domain.stats, before);
});

test('неположительный суммарный вклад отвергается', () => {
  assert.throws(() =>
    buildGenesisObjects({
      drafts: [
        {
          type: 'threat',
          name: 'Яма',
          description: 'Только убыток.',
          weight: 'MINOR',
          stat_profile: { prosperity: -2, influence: 0, knowledge: 0, security: 0 },
        },
      ],
      config: cfg,
      cityName: 'Терракота',
    }),
  );
});
