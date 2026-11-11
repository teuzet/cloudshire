import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { runCascade, subscribersOf } from '../../src/core/world/cascade.js';
import { createFront } from '../../src/core/world/fronts.js';
import { buildMutationFront, consequenceAsk, releaseNextConsequence } from '../../src/core/world/mutation.js';
import { createObject } from '../../src/core/world/objects.js';
import { parseScenario, plantScenario } from '../../src/core/world/scenario.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();

describe('каскад по refs', () => {
  function islandCity() {
    const city = blankCity();
    city.objects.push(
      createObject(r, { id: 'island', type: 'site', name: 'Островок', description: '', day: 0 }),
      createObject(r, { id: 'tower', type: 'structure', name: 'Башня', description: '', refs: ['island'], day: 0 }),
    );
    city.fronts.push(
      createFront(r, { id: 'recipe', description: 'Рецепт', stake: null, effort: 5, driftBand: 'NONE', beatCount: 0, refs: ['tower'], day: 0 }),
    );
    return city;
  }

  test('подписчики — только прямые', () => {
    const city = islandCity();
    expect(subscribersOf(city, 'island').map((s) => s.entity.id)).toEqual(['tower']);
  });

  test('удаление идёт волной: остров → башня → фронт', async () => {
    const city = islandCity();
    const seen: string[] = [];
    await runCascade(city, [{ id: 'island', kind: 'deleted' }], {
      day: 5,
      maxSteps: 10,
      judge: async (_change, target) => {
        seen.push(target.entity.id);
        return { verdict: 'invalid' };
      },
    });
    expect(seen).toEqual(['tower', 'recipe']);
    expect(city.objects.find((o) => o.id === 'tower')?.status).toBe('deleted');
    expect(city.fronts[0]?.status).toBe('invalid');
  });

  test('потолок шагов держит каскад', async () => {
    const city = islandCity();
    const applied = await runCascade(city, [{ id: 'island', kind: 'deleted' }], {
      day: 5,
      maxSteps: 1,
      judge: async () => ({ verdict: 'invalid' }),
    });
    expect(applied).toHaveLength(1);
  });

  test('unchanged дальше не идёт', async () => {
    const city = islandCity();
    const applied = await runCascade(city, [{ id: 'island', kind: 'modified' }], {
      day: 5,
      maxSteps: 10,
      judge: async () => ({ verdict: 'unchanged' }),
    });
    expect(applied.map((a) => a.id)).toEqual(['tower']);
  });
});

describe('воля игрока как фронт', () => {
  test('бюджет последствий задаёт код', () => {
    expect(consequenceAsk(r, 'MINOR')).toEqual({ budget: 0, ask: 0 });
    expect(consequenceAsk(r, 'MAJOR')).toEqual({ budget: 2, ask: 2 + r.fronts.consequences.overdraft });
  });

  test('фронт стройки без дрейфа, effort по весу, порог на каждое последствие', () => {
    const f = buildMutationFront(r, {
      id: 'front_b',
      intent: 'Построить баллисту',
      draft: { kind: 'create', type: 'structure', name: 'Великая баллиста', description: 'Строительство Великой баллисты' },
      assessment: { impact: 'MAJOR', statProfile: { security: 4, prosperity: -1 } },
      consequences: [
        { description: 'Дефицит камня', impact: 'MINOR', drift: 'SLOW', stake: { stats: { prosperity: -2 } } },
        { description: 'Тревога соседей', impact: 'MINOR', drift: 'SLOW', stake: null },
      ],
      alignment: 'Двигают стройка, подвоз камня и мастера.',
      day: 0,
    });
    expect(f.driftBand).toBe('NONE');
    expect(f.effort).toBe(r.fronts.impact.effort.MAJOR);
    expect(f.beatCount).toBe(2);
    expect(f.stake && 'create' in f.stake ? f.stake.create.statEffect?.security : 0).toBeGreaterThan(0);
  });

  test('последствие открывается отдельным фронтом со ссылкой на родителя', () => {
    const city = blankCity();
    const parent = buildMutationFront(r, {
      id: 'p',
      intent: 'x',
      draft: { kind: 'create', type: 'structure', name: 'Б', description: 'Б' },
      assessment: { impact: 'SIGNIFICANT', statProfile: { security: 1 } },
      consequences: [{ description: 'Дефицит камня', impact: 'MINOR', drift: 'SLOW', stake: null }],
      alignment: '',
      day: 0,
    });
    const side = releaseNextConsequence(r, city, parent, { id: 'side', day: 4 });
    expect(side?.refs).toEqual(['p']);
    expect(parent.pendingConsequences).toHaveLength(0);
    expect(releaseNextConsequence(r, city, parent, { id: 'x', day: 5 })).toBeNull();
  });
});

describe('сценарий', () => {
  const raw = yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, '../../scenarios/lantern-isle.yaml'), 'utf8'));

  test('заготовка в репо проходит схему', () => {
    expect(() => parseScenario(raw)).not.toThrow();
  });

  test('локальные id получают глобальные, ссылки переписываются', () => {
    const scenario = parseScenario(raw);
    const city = blankCity();
    const { objects, fronts } = plantScenario(r, city, scenario, { day: 3, newId: ids(9) });
    const tower = objects.find((o) => o.name.includes('Башня'));
    const island = objects.find((o) => o.type === 'site');
    expect(tower?.id).not.toBe('tower');
    expect(tower?.refs).toEqual([island?.id]);
    expect(fronts[0]?.refs).toContain(tower?.id);
    expect(city.scenariosUsed).toEqual([scenario.id]);
  });

  test('кривая заготовка падает с путём', () => {
    expect(() => parseScenario({ id: 'x', title: 'x', fronts: [{ id: 'f', description: 'd', impact: 'HUGE' }] })).toThrow(
      /fronts\.0\.impact/,
    );
  });
});
