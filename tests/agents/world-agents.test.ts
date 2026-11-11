import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { FakeLlm, toolReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings, parseAgentSettings } from '../../src/agents/_shared/settings.js';
import { evaluateAssignment } from '../../src/agents/assignment-evaluator/run.js';
import { resolveBeat } from '../../src/agents/beat-resolver/run.js';
import { writeChronicle } from '../../src/agents/front-chronicle/run.js';
import { writeObjectVersion } from '../../src/agents/object-version-writer/run.js';
import { judgeLocalUpdate } from '../../src/agents/local-world-updater/run.js';
import { draftMutation } from '../../src/agents/mutation-drafter/run.js';
import { judgeFeasibility } from '../../src/agents/feasibility-judge/run.js';
import { judgeImpact } from '../../src/agents/impact-judge/run.js';
import { generateConsequences } from '../../src/agents/consequences-generator/run.js';
import { judgeConsequence } from '../../src/agents/consequence-judge/run.js';
import { writeScenario } from '../../src/agents/scenario-writer/run.js';
import { extractWorldObjects } from '../../src/agents/world-objects-genesis/run.js';
import { createFront } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { parseScenario } from '../../src/core/world/scenario.js';
import { blankCity, rules } from '../helpers/fixtures.js';

const r = rules();
const ROOT = path.resolve(import.meta.dirname, '../..');
const deps = (llm: FakeLlm) => ({ llm, settings: fixedSettings() });

function front() {
  return createFront(r, {
    id: 'f1',
    description: 'Добраться до рецепта в башне',
    stake: { reveal: { text: 'Рецепт держит островок' } },
    effort: 10,
    driftBand: 'NONE',
    beatCount: 2,
    events: [{ id: 'collapse', description: 'Обвал лестницы' }],
    clues: [{ id: 'runes', fact: 'Надписи о курсе', alignment: '' }],
    alignment: 'СКРЫТАЯ_ЛОГИКА',
    day: 0,
  });
}

function tower() {
  return createObject(r, { id: 'tower', type: 'structure', name: 'Башня', description: 'Закрытая башня', day: 0 });
}

describe('настройки моделей', () => {
  test('config/agents.yaml разбирается, и каждый агент в нём существует', () => {
    const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'config/agents.yaml'), 'utf8')) as { agents: Record<string, unknown> };
    expect(() => parseAgentSettings(raw)).not.toThrow();
    for (const name of Object.keys(raw.agents)) expect(fs.existsSync(path.join(ROOT, 'src/agents', name, 'run.ts'))).toBe(true);
  });
});

describe('agents мира', () => {
  test('assignment-evaluator: чужой block отбивается, вердикт в терминах ядра', async () => {
    const llm = new FakeLlm().script(
      'assignment-evaluator',
      toolReply('submit_assignment_eval', { direction: 'forward', efficiency: 'strong', blocks: ['ghost'], stop_when: 'stake' }),
      toolReply('submit_assignment_eval', { direction: 'forward', efficiency: 'strong', blocks: ['collapse'], stop_when: 'next_result' }),
    );
    const city = blankCity();
    const v = await evaluateAssignment(deps(llm), { front: front(), officer: city.officers[2]!, text: 'Изучить надписи' });
    expect(v).toEqual({ direction: 'forward', efficiency: 'strong', blocks: ['collapse'], stopWhen: 'next_result' });
    expect(llm.requests[0]?.system).toContain('СКРЫТАЯ_ЛОГИКА');
  });

  test('beat-resolver: ровно одно из пула', async () => {
    const f = front();
    const llm = new FakeLlm().script(
      'beat-resolver',
      toolReply('submit_beat_pick', { event_id: 'collapse', clue_id: 'runes' }),
      toolReply('submit_beat_pick', { clue_id: 'runes' }),
    );
    expect(await resolveBeat(deps(llm), { front: f, start: { events: f.events, clues: f.clues }, history: [] })).toEqual({ eventId: null, clueId: 'runes' });
  });

  test('front-chronicle: имена приходят в system', async () => {
    const llm = new FakeLlm().script('front-chronicle', toolReply('submit_chronicle', { text: 'Лестница рухнула.' }));
    const text = await writeChronicle(deps(llm), { cityName: 'Мерв', fact: 'Обвал', history: [], names: [{ name: 'Таэн', gender: 'female' }] });
    expect(text).toBe('Лестница рухнула.');
    expect(llm.requests[0]?.system).toContain('Таэн (ж)');
  });

  test('object-version-writer: длинное описание отбивается', async () => {
    const long = 'а'.repeat(r.fronts.objects.descriptionMax + 1);
    const llm = new FakeLlm().script(
      'object-version-writer',
      toolReply('submit_object_version', { description: long, weight: 'MINOR', stat_profile: { security: 1 } }),
      toolReply('submit_object_version', { description: 'Башня открыта', weight: 'MINOR', stat_profile: { security: 1 } }),
    );
    const v = await writeObjectVersion(deps(llm), { rules: r, object: tower(), change: 'Дверь вскрыли' });
    expect(v).toEqual({ description: 'Башня открыта', weight: 'MINOR', statProfile: { prosperity: 0, security: 1, knowledge: 0, influence: 0 } });
  });

  test('local-world-updater: updated без текста не принимается', async () => {
    const city = blankCity();
    city.objects.push(tower());
    const llm = new FakeLlm().script(
      'local-world-updater',
      toolReply('submit_local_update', { verdict: 'updated' }),
      toolReply('submit_local_update', { verdict: 'invalid' }),
    );
    const v = await judgeLocalUpdate(deps(llm), { city, change: { id: 'tower', kind: 'deleted' }, target: { kind: 'front', entity: front() } });
    expect(v).toEqual({ verdict: 'invalid' });
    expect(llm.requests[0]?.messages[0]).toMatchObject({ content: expect.stringContaining('исчезло') });
  });
});

describe('воля игрока', () => {
  test('mutation-drafter: цель должна существовать, защищённое не удаляется', async () => {
    const t = { ...tower(), protected: true };
    const llm = new FakeLlm().script(
      'mutation-drafter',
      toolReply('submit_mutation', { kind: 'modify', target: 'ghost', description: 'x' }),
      toolReply('submit_mutation', { kind: 'delete', target: 'tower', description: 'снести' }),
      toolReply('submit_mutation', { kind: 'create', type: 'structure', name: 'Баллиста', description: 'Большая баллиста' }),
    );
    const d = await draftMutation(deps(llm), { rules: r, intent: 'Постройте баллисту', objects: [t] });
    expect(d).toEqual({ kind: 'create', type: 'structure', name: 'Баллиста', description: 'Большая баллиста' });
    expect(llm.requests).toHaveLength(3);
  });

  test('feasibility-judge: LOCKED требует условие', async () => {
    const llm = new FakeLlm().script(
      'feasibility-judge',
      toolReply('submit_feasibility', { verdict: 'LOCKED' }),
      toolReply('submit_feasibility', { verdict: 'LOCKED', missing: 'камень' }),
    );
    const draft = { kind: 'create' as const, type: 'structure' as const, name: 'Б', description: 'Б' };
    expect(await judgeFeasibility(deps(llm), { draft, objects: [] })).toEqual({ verdict: 'LOCKED', missing: 'камень' });
  });

  test('impact-judge: нулевой профиль при ненулевом масштабе не принимается', async () => {
    const llm = new FakeLlm().script(
      'impact-judge',
      toolReply('submit_impact', { impact: 'MAJOR', stat_profile: {} }),
      toolReply('submit_impact', { impact: 'MAJOR', stat_profile: { security: 4, prosperity: -1 } }),
    );
    const draft = { kind: 'create' as const, type: 'structure' as const, name: 'Б', description: 'Б' };
    const a = await judgeImpact(deps(llm), { draft, objects: [] });
    expect(a.impact).toBe('MAJOR');
    expect(a.statProfile.security).toBe(4);
  });

  test('consequences-generator: при нуле не зовётся, при нехватке просит ещё', async () => {
    const draft = { kind: 'create' as const, type: 'structure' as const, name: 'Б', description: 'Б' };
    const silent = new FakeLlm();
    expect(await generateConsequences(deps(silent), { draft, objects: [], count: 0 })).toEqual([]);
    expect(silent.requests).toHaveLength(0);

    const item = { description: 'Дефицит камня', impact: 'MINOR', drift: 'SLOW' };
    const llm = new FakeLlm().script(
      'consequences-generator',
      toolReply('submit_consequences', { items: [item] }),
      toolReply('submit_consequences', { items: [item, { ...item, description: 'Тревога' }, { ...item, description: 'Лишнее' }] }),
    );
    const out = await generateConsequences(deps(llm), { draft, objects: [], count: 2 });
    expect(out.map((c) => c.description)).toEqual(['Дефицит камня', 'Тревога']);
    expect(out[0]?.stake).toBeNull();
  });

  test('consequence-judge', async () => {
    const llm = new FakeLlm().script('consequence-judge', toolReply('submit_consequence_verdict', { ok: false }));
    const draft = { kind: 'create' as const, type: 'structure' as const, name: 'Б', description: 'Б' };
    expect(await judgeConsequence(deps(llm), { draft, objects: [], candidate: { description: 'x', impact: 'MINOR', drift: 'SLOW', stake: null } })).toBe(false);
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
