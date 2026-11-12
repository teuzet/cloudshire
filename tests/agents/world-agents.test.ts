import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { FakeLlm, toolReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings, parseAgentSettings } from '../../src/agents/_shared/settings.js';
import { writeScenario } from '../../src/agents/scenario-writer/run.js';
import { extractWorldObjects } from '../../src/agents/world-objects-genesis/run.js';
import { createObject } from '../../src/core/world/objects.js';
import { parseScenario } from '../../src/core/world/scenario.js';
import { rules } from '../helpers/fixtures.js';

const r = rules();
const ROOT = path.resolve(import.meta.dirname, '../..');
const deps = (llm: FakeLlm) => ({ llm, settings: fixedSettings() });

function tower() {
  return createObject(r, { id: 'tower', type: 'structure', name: 'Башня', description: 'Закрытая башня', day: 0 });
}

describe('настройки моделей', () => {
  test('config/agents.yaml разбирается, и каждый агент в нём существует', () => {
    const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'config/agents.yaml'), 'utf8')) as { agents: Record<string, unknown> };
    expect(() => parseAgentSettings(raw)).not.toThrow();
    for (const name of Object.keys(raw.agents)) expect(fs.existsSync(path.join(ROOT, 'src/agents', name, 'run.ts'))).toBe(true);
  });

  test('узкие агенты системы фронтов работают на модели по умолчанию', () => {
    const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'config/agents.yaml'), 'utf8'));
    const settings = parseAgentSettings(raw);
    const narrow = ['will-interpreter', 'canon-warden', 'stage-planner', 'contribution-appraiser', 'risk-appraiser', 'footprint-mapper', 'key-sealer', 'alignment-judge', 'role-fitter', 'costumer', 'dynamics-composer', 'beat-writer', 'resolver', 'faith-appraiser', 'theme-tagger', 'description-rewriter', 'chronicler'];
    for (const name of narrow) expect(settings(name).model).toBe('openai:gpt-5.6-luna');
  });
});

describe('посев и генезис объектов', () => {
  const template = parseScenario(yaml.load(fs.readFileSync(path.join(ROOT, 'scenarios/lantern-isle.yaml'), 'utf8')));

  test('scenario-writer: битая ссылка отбивается, id заготовки сохраняется', async () => {
    const broken = structuredClone(template);
    broken.fronts[0]!.refs = ['nowhere'];
    const adapted = { ...structuredClone(template), id: 'renamed', title: 'Островок у Мерва' };
    const llm = new FakeLlm().script('scenario-writer', toolReply('submit_scenario', broken), toolReply('submit_scenario', adapted));
    const s = await writeScenario(deps(llm), { cityBrief: 'Мерв', objects: [], template, seed: null, names: [], unknowns: [] });
    expect(s.id).toBe('lantern-isle');
    expect(s.title).toBe('Островок у Мерва');
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('nowhere');
  });

  test('scenario-writer: подгонка меняет слова, устройство остаётся из заготовки', async () => {
    const drifted = structuredClone(template);
    drifted.fronts[0]!.impact = 'DEFINING';
    drifted.fronts[0]!.drift = 'FAST';
    drifted.fronts[0]!.description = 'Пробраться в башню у Мерва.';
    drifted.fronts.push({ ...structuredClone(drifted.fronts[0]!), id: 'extra' });
    drifted.objects[0]!.statProfile = { security: 5 };
    drifted.objects.push({ id: 'decor', type: 'policy', name: 'Запрет', description: '', refs: [], weight: 'MAJOR', statProfile: { influence: 3 } });
    const llm = new FakeLlm().script('scenario-writer', toolReply('submit_scenario', drifted));
    const s = await writeScenario(deps(llm), { cityBrief: 'Мерв', objects: [], template, seed: null, names: [], unknowns: [] });
    expect(s.fronts.map((f) => f.id)).toEqual(template.fronts.map((f) => f.id));
    expect(s.fronts[0]).toMatchObject({ impact: template.fronts[0]!.impact, drift: 'NONE', description: 'Пробраться в башню у Мерва.' });
    expect(s.objects[0]!.statProfile).toEqual(template.objects[0]!.statProfile);
    expect(s.objects.find((o) => o.id === 'decor')).toBeUndefined();
  });

  test('scenario-writer: переименованные id узнаются по месту', async () => {
    const renamed = structuredClone(template);
    renamed.objects[0]!.id = 'isle_x';
    renamed.objects[0]!.statProfile = {};
    renamed.objects[1]!.refs = ['isle_x'];
    renamed.fronts[0]!.id = 'recipe_x';
    renamed.fronts[0]!.impact = 'DEFINING';
    renamed.fronts[0]!.refs = ['isle_x'];
    const llm = new FakeLlm().script('scenario-writer', toolReply('submit_scenario', renamed));
    const s = await writeScenario(deps(llm), { cityBrief: 'Мерв', objects: [], template, seed: null, names: [], unknowns: [] });
    expect(s.objects[0]).toMatchObject({ id: 'isle_x', statProfile: template.objects[0]!.statProfile });
    expect(s.fronts).toHaveLength(1);
    expect(s.fronts[0]).toMatchObject({ id: 'recipe_x', impact: template.fronts[0]!.impact, refs: ['isle_x'] });
  });

  test('scenario-writer: можно ссылаться на живой объект города', async () => {
    const s = { id: 'x', title: 'x', fronts: [{ id: 'f', description: 'Трещина в башне', impact: 'MINOR', refs: ['tower'], stake: { delete: { target: 'tower' } } }] };
    const llm = new FakeLlm().script('scenario-writer', toolReply('submit_scenario', s));
    const out = await writeScenario(deps(llm), { cityBrief: '', objects: [tower()], template: null, seed: 'трещина', names: [], unknowns: [] });
    expect(out.fronts[0]?.refs).toEqual(['tower']);
  });

  test('scenario-writer: объект тайны острова закрыт для посадки', async () => {
    const touching = { id: 'x', title: 'x', fronts: [{ id: 'f', description: 'Трещина в башне', impact: 'MINOR', refs: ['tower'], stake: null }] };
    const clean = { id: 'x', title: 'x', fronts: [{ id: 'f', description: 'Спор на рынке', impact: 'MINOR', stake: null }] };
    const llm = new FakeLlm().script('scenario-writer', toolReply('submit_scenario', touching), toolReply('submit_scenario', clean));
    const unknowns = [{ text: 'Кто построил башню, не установлено.', objectIds: ['tower'] }];
    const out = await writeScenario(deps(llm), { cityBrief: '', objects: [tower()], template: null, seed: 'что-нибудь', names: [], unknowns });
    expect(out.fronts[0]?.description).toBe('Спор на рынке');
    expect(llm.requests[0]?.system).toContain('ТАЙНЫ ОСТРОВА');
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('касается тайны острова: tower');
  });

  test('world-objects-genesis: число объектов из правил', async () => {
    const one = { type: 'building', name: 'Храм', description: 'Храм', weight: 'MAJOR', stat_profile: { influence: 3 } };
    const many = Array.from({ length: r.fronts.genesisObjects.minCount }, (_, i) => ({ ...one, name: `Храм ${i}` }));
    const llm = new FakeLlm().script('world-objects-genesis', toolReply('submit_world_objects', { objects: [one] }), toolReply('submit_world_objects', { objects: many }));
    const out = await extractWorldObjects(deps(llm), { rules: r, cityName: 'Мерв', description: 'Город' });
    expect(out).toHaveLength(r.fronts.genesisObjects.minCount);
    expect(out[0]?.statProfile.influence).toBe(3);
  });
});
