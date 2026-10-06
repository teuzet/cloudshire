import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPlayerMutation } from '../src/world/mutation.js';
import { consequenceBudget } from '../src/world/scales.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

function many(count) {
  return Array.from({ length: count }, (_, i) => ({ description: `Последствие ${i + 1}`, impact: 'MINOR' }));
}

test('невозможное намерение не создаёт фронт', async () => {
  const domain = { fronts: [] };
  const result = await openPlayerMutation({
    config: cfg,
    domain,
    intent: 'Стать небом',
    judges: {
      mutate: async () => ({ kind: 'create', type: 'structure', name: 'Небо', description: 'Стать небом' }),
      feasibility: async () => ({ verdict: 'IMPOSSIBLE', reason: 'люди не летают' }),
      impact: async () => ({ impact: 'DEFINING', stat_profile: { security: 1 } }),
      consequences: async () => many(10),
      judge: async () => ({ ok: true }),
    },
  });
  assert.equal(result.status, 'impossible');
  assert.equal(result.front, null);
  assert.equal(domain.fronts.length, 0);
});

test('мелкое изменение не порождает побочных фронтов', async () => {
  const domain = { fronts: [] };
  const result = await openPlayerMutation({
    config: cfg,
    domain,
    intent: 'Починить калитку',
    judges: {
      mutate: async () => ({ kind: 'create', type: 'structure', name: 'Калитка', description: 'Новая калитка' }),
      feasibility: async () => ({ verdict: 'FEASIBLE' }),
      impact: async () => ({ impact: 'MINOR', stat_profile: { prosperity: 1 } }),
      consequences: async () => many(10),
      judge: async () => ({ ok: true }),
    },
  });
  assert.equal(consequenceBudget(cfg, 'MINOR'), 0);
  assert.equal(result.pending, 0);
});

test('код не берёт последствий больше бюджета', async () => {
  const domain = { fronts: [] };
  const result = await openPlayerMutation({
    config: cfg,
    domain,
    intent: 'Построить баллисту',
    judges: {
      mutate: async () => ({ kind: 'create', type: 'structure', name: 'Баллиста', description: 'Великая баллиста' }),
      feasibility: async () => ({ verdict: 'FEASIBLE' }),
      impact: async () => ({ impact: 'DEFINING', stat_profile: { security: 4, prosperity: -1 } }),
      consequences: async () => many(10),
      judge: async () => ({ ok: true }),
    },
  });
  assert.equal(result.pending, consequenceBudget(cfg, 'DEFINING'));
  assert.ok(result.pending <= consequenceBudget(cfg, 'DEFINING'));
});
