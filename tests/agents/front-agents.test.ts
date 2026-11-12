/**
 * Контракты узких агентов системы фронтов: что уходит в модель, что отбивается проверкой,
 * во что превращается ответ. Плюс гигиена промптов по правилам из docs/design/fronts.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { FakeLlm, toolReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings } from '../../src/agents/_shared/settings.js';
import type { ObjectBrief } from '../../src/agents/_shared/blocks.js';
import { judgeAlignment } from '../../src/agents/alignment-judge/run.js';
import { writeBeat } from '../../src/agents/beat-writer/run.js';
import { judgeCanon } from '../../src/agents/canon-warden/run.js';
import { writeChronicleEntry } from '../../src/agents/chronicler/run.js';
import { appraiseContribution } from '../../src/agents/contribution-appraiser/run.js';
import { dressEvent } from '../../src/agents/costumer/run.js';
import { rewriteDescription } from '../../src/agents/description-rewriter/run.js';
import { composeDynamic } from '../../src/agents/dynamics-composer/run.js';
import { appraiseFaith } from '../../src/agents/faith-appraiser/run.js';
import { mapFootprint } from '../../src/agents/footprint-mapper/run.js';
import { sealKey } from '../../src/agents/key-sealer/run.js';
import { resolveEvent } from '../../src/agents/resolver/run.js';
import { appraiseRisk } from '../../src/agents/risk-appraiser/run.js';
import { fitRole } from '../../src/agents/role-fitter/run.js';
import { planStages } from '../../src/agents/stage-planner/run.js';
import { tagThemes } from '../../src/agents/theme-tagger/run.js';
import { interpretWill } from '../../src/agents/will-interpreter/run.js';
import { rules } from '../helpers/fixtures.js';

const r = rules();
const ROOT = path.resolve(import.meta.dirname, '../..');
const deps = (llm: FakeLlm) => ({ llm, settings: fixedSettings() });
const lastUser = (llm: FakeLlm, agent: string) => {
  const m = llm.callsTo(agent).at(-1)!.messages[0]!;
  return m.role === 'user' ? m.content : '';
};

const quarry: ObjectBrief = { id: 'o1', type: 'site', name: 'Каменоломни', description: 'Карьеры на северном склоне.' };
const masons: ObjectBrief = { id: 'o2', type: 'community', name: 'Артель каменщиков', description: 'Сорок мастеров.' };
const fronts = [{ id: 'f1', title: 'Стройка башни', description: 'Артель кладёт цоколь.', lead: 'казначей Ада', hindrances: [{ name: 'Грозовые птицы', description: 'Стая вьёт гнёзда на лесах.' }] }];

const GENERATORS = ['stage-planner', 'key-sealer', 'costumer', 'dynamics-composer', 'beat-writer', 'resolver', 'description-rewriter', 'chronicler'];
const EVALUATORS = ['will-interpreter', 'canon-warden', 'contribution-appraiser', 'risk-appraiser', 'footprint-mapper', 'alignment-judge', 'role-fitter', 'faith-appraiser', 'theme-tagger'];

describe('гигиена промптов системы фронтов', () => {
  const read = (agent: string) => fs.readFileSync(path.join(ROOT, 'src/agents', agent, 'prompt.md'), 'utf8');

  test('у каждого агента есть четыре файла', () => {
    for (const agent of [...GENERATORS, ...EVALUATORS]) {
      for (const file of ['prompt.md', 'schema.ts', 'run.ts', 'README.md']) {
        expect(fs.existsSync(path.join(ROOT, 'src/agents', agent, file)), `${agent}/${file}`).toBe(true);
      }
    }
  });

  test('в промптах нет сленга проекта', () => {
    const slang = /фронт|ставк|режисс[её]р|отпечат|запечат|динамик|сановнико|ёмкост|(?<![а-яё])вех[аиу](?![а-яё])|(?<![а-яё])ключ[аеу]?(?![а-яё])|элайнмент|костюмер|примерщик|толковател/i;
    for (const agent of [...GENERATORS, ...EVALUATORS]) {
      const hit = read(agent).match(slang);
      expect(hit?.[0] ?? null, `${agent}: внутреннее слово в промпте`).toBeNull();
    }
  });

  test('у генераторов нет примеров, у оценщиков есть', () => {
    for (const agent of GENERATORS) expect(read(agent), agent).not.toMatch(/Пример/);
    for (const agent of EVALUATORS) expect(read(agent), agent).toMatch(/Примеры\./);
  });

  test('в промптах нет запретов прописными и слова «нельзя»', () => {
    for (const agent of [...GENERATORS, ...EVALUATORS]) {
      expect(read(agent), agent).not.toMatch(/ЗАПРЕЩ|НЕЛЬЗЯ|НИКОГДА|нельзя|никогда|запрещено/);
    }
  });
});

describe('воля игрока', () => {
  test('will-interpreter: чужой id дела отбивается, темп переводится в число', async () => {
    const llm = new FakeLlm().script(
      'will-interpreter',
      toolReply('submit_will', { label: 'deed', front_id: 'ghost', deed_kind: 'push', goal: 'Привезти гранит' }),
      toolReply('submit_will', { label: 'deed', front_id: 'f1', deed_kind: 'push', goal: 'Привезти гранит', work_tempo: 'hurry' }),
    );
    const will = await interpretWill(deps(llm), { order: 'Привези гранит, и поскорее', officer: 'маршал Борислав', fronts, projects: [] });
    expect(will).toEqual({ label: 'deed', frontId: 'f1', projectId: null, deedKind: 'push', goal: 'Привезти гранит', manner: null, projectTempo: null, workTempo: 1 });
    expect(llm.callsTo('will-interpreter')).toHaveLength(2);
    expect(lastUser(llm, 'will-interpreter')).toContain('f1 «Стройка башни»');
    expect(lastUser(llm, 'will-interpreter')).toContain('«Грозовые птицы»');
  });

  test('will-interpreter: у проекта поля чужих веток обнуляются', async () => {
    const llm = new FakeLlm().script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: 'f1', deed_kind: 'push', goal: 'Построить маяк', project_tempo: 'careful' }));
    const will = await interpretWill(deps(llm), { order: 'Построй маяк, не спеша', officer: 'казначей Ада', fronts, projects: [] });
    expect(will).toMatchObject({ label: 'project', frontId: null, deedKind: null, projectTempo: -1 });
  });

  test('canon-warden: поправка меняет цель, недостижимое не несёт нехваток', async () => {
    const llm = new FakeLlm().script(
      'canon-warden',
      toolReply('submit_canon_verdict', { verdict: 'amended', reason: 'Магии нет' }),
      toolReply('submit_canon_verdict', { verdict: 'amended', reason: 'Магии нет', amended_goal: 'Учредить гильдию лекарей' }),
      toolReply('submit_canon_verdict', { verdict: 'unattainable', reason: 'Под островом нет дна', gaps: ['канаты'] }),
    );
    const amended = await judgeCanon(deps(llm), { goal: 'Учредить гильдию магов', facts: ['Город стоит на камне.'], objects: [quarry] });
    expect(amended).toMatchObject({ verdict: 'amended', goal: 'Учредить гильдию лекарей' });
    expect(llm.callsTo('canon-warden')[0]!.system).toContain('МИР, В КОТОРОМ ВСЁ ПРОИСХОДИТ');
    const no = await judgeCanon(deps(llm), { goal: 'Спуститься в долину', facts: [], objects: [] });
    expect(no).toEqual({ verdict: 'unattainable', reason: 'Под островом нет дна', goal: 'Спуститься в долину', gaps: [] });
  });

  test('stage-planner: перемена без id из списка отбивается', async () => {
    const stage = (result: Record<string, unknown>) => ({ title: 'Стройка', work: 'Каменщики кладут стены.', result, site: { name: 'Стройка башни', description: 'Леса и цоколь.' }, outcome_known: true });
    const llm = new FakeLlm().script(
      'stage-planner',
      toolReply('submit_stages', { stages: [stage({ kind: 'change_object', object_id: 'ghost', name: 'Каменоломни', description: 'Расширены.' })] }),
      toolReply('submit_stages', { stages: [stage({ kind: 'new_object', type: 'structure', name: 'Башня с баллистой', description: 'Высокая башня с орудием.' })] }),
    );
    const stages = await planStages(deps(llm), { goal: 'Построить башню с баллистой', gaps: [], objects: [quarry, masons] });
    expect(stages).toHaveLength(1);
    expect(stages[0]!.result).toMatchObject({ kind: 'new_object', type: 'structure', objectId: null });
    expect(stages[0]!.outcomeKnown).toBe(true);
  });

  test('contribution-appraiser: повтор стата отбивается, определения статов в системном промпте', async () => {
    const llm = new FakeLlm().script(
      'contribution-appraiser',
      toolReply('submit_contribution', { effects: [{ stat: 'security', direction: 'up', size: 'large' }, { stat: 'security', direction: 'down', size: 'small' }] }),
      toolReply('submit_contribution', { effects: [{ stat: 'security', direction: 'up', size: 'large' }, { stat: 'prosperity', direction: 'down', size: 'small' }], reason: 'Орудие' }),
    );
    const out = await appraiseContribution(deps(llm), {
      rules: r,
      subject: { type: 'structure', name: 'Башня с баллистой', description: 'Высокая башня.' },
      cityStats: 'Безопасность средняя.',
      keyObjects: [{ name: 'Городская стража', type: 'organization', effects: [{ stat: 'security', direction: 'up', size: 'medium' }] }],
      before: { effects: [], event: 'Башню достроили.' },
    });
    expect(out.effects).toHaveLength(2);
    expect(llm.callsTo('contribution-appraiser')[0]!.system).toContain('security (Безопасность)');
    expect(lastUser(llm, 'contribution-appraiser')).toContain('Городская стража (учреждение): security up medium');
    expect(lastUser(llm, 'contribution-appraiser')).toContain('Случилось: Башню достроили.');
  });

  test('footprint-mapper: чужой id отбивается, повторы склеиваются', async () => {
    const llm = new FakeLlm().script(
      'footprint-mapper',
      toolReply('submit_footprint', { relations: [{ object_id: 'ghost', relation: 'occupies', reason: 'x' }] }),
      toolReply('submit_footprint', { relations: [{ object_id: 'o1', relation: 'occupies', reason: 'камень' }, { object_id: 'o1', relation: 'occupies', reason: 'ещё раз' }, { object_id: 'o2', relation: 'pressures', reason: 'тяжело' }] }),
    );
    const links = await mapFootprint(deps(llm), { work: 'Строить башню', result: 'Башня с баллистой', objects: [quarry, masons] });
    expect(links).toEqual([{ objectId: 'o1', relation: 'occupies', reason: 'камень' }, { objectId: 'o2', relation: 'pressures', reason: 'тяжело' }]);
  });

  test('risk-appraiser: ступень и отпечаток словами', async () => {
    const llm = new FakeLlm().script('risk-appraiser', toolReply('submit_risk', { step: 'hard', reason: 'Высота' }));
    const out = await appraiseRisk(deps(llm), { work: 'Строить башню', touches: [{ name: 'Артель каменщиков', relation: 'occupies', reason: 'строит' }] });
    expect(out.step).toBe('hard');
    expect(lastUser(llm, 'risk-appraiser')).toContain('Артель каменщиков — занято работой: строит');
  });

  test('key-sealer: подвох обязателен только когда его просят', async () => {
    const moves = ['Платить артели вовремя', 'Возить камень лебёдками', 'Поставить одного мастера'];
    const llm = new FakeLlm().script(
      'key-sealer',
      toolReply('submit_key', { moves }),
      toolReply('submit_key', { moves, twist: 'Кристаллы запоминают голоса.' }),
      toolReply('submit_key', { moves, twist: 'Лишний подвох.' }),
    );
    const sealed = await sealKey(deps(llm), { title: 'Опыты с кристаллами', description: 'Алхимики растят кристаллы.', kind: 'work', roles: [], twistNeeded: true });
    expect(sealed.twist).toBe('Кристаллы запоминают голоса.');
    const plain = await sealKey(deps(llm), { title: 'Стройка башни', description: 'Артель кладёт цоколь.', kind: 'work', roles: ['Артель каменщиков — занята'] });
    expect(plain).toEqual({ moves, twist: null });
  });

  test('alignment-judge: без ходов модель не зовётся; номер хода обязателен для spot_on', async () => {
    const llm = new FakeLlm().script('alignment-judge', toolReply('submit_alignment', { verdict: 'spot_on' }), toolReply('submit_alignment', { verdict: 'spot_on', matched_move: 2 }));
    expect(await judgeAlignment(deps(llm), { situation: 'Стройка', moves: [], proposal: 'Плати вперёд' })).toEqual({ verdict: 'fits', matchedMove: null });
    expect(llm.requests).toHaveLength(0);
    const out = await judgeAlignment(deps(llm), { situation: 'Стройка', moves: ['Давать отдых', 'Платить вовремя'], proposal: 'Плати вперёд' });
    expect(out).toEqual({ verdict: 'spot_on', matchedMove: 2 });
    expect(lastUser(llm, 'alignment-judge')).toContain('2) Платить вовремя');
  });
});

describe('веха, осложнение, развязка', () => {
  test('role-fitter: да или нет', async () => {
    const llm = new FakeLlm().script('role-fitter', toolReply('submit_fit', { fits: true, reason: 'Тянут стройку' }));
    expect(await fitRole(deps(llm), { question: 'Им стало тяжелее?', subject: 'Артель каменщиков', context: 'Спешная стройка' })).toEqual({ fits: true, reason: 'Тянут стройку' });
  });

  test('costumer: новый участник обязателен только по запросу', async () => {
    const base = { title: 'Грозовые птицы', description: 'Птицы сели на леса.', rumor: 'Говорят, на лесах гнёзда.', outburst: 'Работа встанет.' };
    const llm = new FakeLlm().script(
      'costumer',
      toolReply('submit_costume', base),
      toolReply('submit_costume', { ...base, new_object: { type: 'threat', name: 'Стая грозовых птиц', description: 'Гнездятся на остове.' } }),
      toolReply('submit_costume', { ...base, new_object: { type: 'threat', name: 'Лишние птицы', description: 'x' } }),
    );
    const input = { skeleton: 'Стройку заняли чужие.', shape: 'hindrance' as const, cause: 'Стройка башни', actor: null, themes: ['военная мощь'], names: ['Айра (ж)'], needsNew: true };
    const dressed = await dressEvent(deps(llm), input);
    expect(dressed.newObject?.name).toBe('Стая грозовых птиц');
    expect(lastUser(llm, 'costumer')).toContain('Род события: помеха в работе');
    const plain = await dressEvent(deps(llm), { ...input, needsNew: false, actor: { object: masons, touch: 'занята работой' } });
    expect(plain.newObject).toBeNull();
  });

  test('dynamics-composer: удар по объекту требует id из отпечатка', async () => {
    const llm = new FakeLlm().script(
      'dynamics-composer',
      toolReply('submit_dynamic', { shape: 'tension', target: 'object', skeleton: 'Люди ропщут.' }),
      toolReply('submit_dynamic', { shape: 'tension', target: 'object', object_id: 'o2', skeleton: 'Люди ропщут.', helps: 'Отдых' }),
    );
    const out = await composeDynamic(deps(llm), { work: 'Стройка башни', share: 0.4, touches: [{ id: 'o2', name: 'Артель каменщиков', relation: 'occupies', reason: 'строит' }] });
    expect(out).toMatchObject({ shape: 'tension', target: 'object', objectId: 'o2' });
  });

  test('beat-writer: эффект только из разрешённых', async () => {
    const llm = new FakeLlm().script('beat-writer', toolReply('submit_beat', { text: 'Цоколь готов.', effect: 'reveal' }), toolReply('submit_beat', { text: 'Цоколь готов.', effect: 'none' }));
    const beat = await writeBeat(deps(llm), { title: 'Стройка башни', description: 'Артель кладёт цоколь.', share: 0.33, lead: 'казначей Ада', manner: 'платить вперёд', result: 'Башня с баллистой', reveal: null, allowed: ['none'] });
    expect(beat).toEqual({ text: 'Цоколь готов.', effect: 'none' });
    expect(lastUser(llm, 'beat-writer')).toContain('пройдено около 33% пути');
  });

  test('resolver: эффект из разрешённых, link требует двух участников', async () => {
    const llm = new FakeLlm().script(
      'resolver',
      toolReply('submit_resolution', { text: 'Ропот стих.', effect: 'trace', trace: { type: 'landmark', name: 'Остов', description: 'x' } }),
      toolReply('submit_resolution', { text: 'Ропот стих.', effect: 'link', object_ids: ['o1'] }),
      toolReply('submit_resolution', { text: 'Ропот стих.', effect: 'link', object_ids: ['o1', 'o2'] }),
    );
    const out = await resolveEvent(deps(llm), {
      title: 'Ропот каменщиков',
      description: 'Артель требует отдыха.',
      ending: 'averted',
      consequence: null,
      participants: [quarry, masons],
      keepable: [],
      lead: 'казначей Ада',
      manner: 'уступить в оплате',
      allowed: ['none', 'fact', 'link'],
    });
    expect(out).toEqual({ text: 'Ропот стих.', effect: 'link', a: 'o1', b: 'o2' });
    expect(llm.callsTo('resolver')).toHaveLength(3);
    expect(lastUser(llm, 'resolver')).toContain('Исход: беду отвели вовремя');
  });

  test('faith-appraiser: случай и сила', async () => {
    const llm = new FakeLlm().script('faith-appraiser', toolReply('submit_faith', { case: 'harm_willed', strength: 'grave' }));
    expect(await appraiseFaith(deps(llm), { event: 'Рухнули леса.', will: 'Дело велел и торопил бог.', recent: [] })).toEqual({ case: 'harm_willed', strength: 'grave' });
  });

  test('theme-tagger: тема не из списка отбивается, новая приходит в fresh', async () => {
    const llm = new FakeLlm().script(
      'theme-tagger',
      toolReply('submit_themes', { existing: ['оборона'] }),
      toolReply('submit_themes', { existing: ['Военная мощь'], fresh: 'Закон и порядок' }),
    );
    const themes = await tagThemes(deps(llm), { subject: { type: 'organization', name: 'Суд чести', description: 'Суд для споров знати.' }, themes: ['военная мощь', 'торговля'] });
    expect(themes).toEqual(['военная мощь', 'закон и порядок']);
  });

  test('description-rewriter и chronicler отдают текст', async () => {
    const llm = new FakeLlm()
      .script('description-rewriter', toolReply('submit_description', { description: 'Каменоломни закрыты после обвала.' }))
      .script('chronicler', toolReply('submit_chronicle', { text: 'Башня достроена. Стража приняла баллисту.' }));
    expect(await rewriteDescription(deps(llm), { name: 'Каменоломни', description: 'Карьеры.', change: 'Обвал' })).toBe('Каменоломни закрыты после обвала.');
    const text = await writeChronicleEntry(deps(llm), { gist: 'Башня достроена.', changes: ['Появилось: Башня с баллистой'] });
    expect(text).toContain('Башня достроена');
    expect(lastUser(llm, 'chronicler')).toContain('- Появилось: Башня с баллистой');
  });
});
