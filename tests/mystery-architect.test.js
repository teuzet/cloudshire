import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  plotConfig,
  pickMysteryArchitectSeed,
  formatMysteryArchitectAxesForPrompt,
  gravityBand,
  weightedArchitectSourceGroup,
} from '../src/game/plotlines.js';
import {
  normalizeMysterySkeleton,
  formatMysteryArchitectJudgeCase,
  seedMysterySkeleton,
  judgeMysteryArchitect,
  classifyArchitectSkip,
  MEDIUM_CLASSES,
  ARCHITECT_JUDGE_CODES,
} from '../src/game/mysteryArchitect.js';

function validDraft(extra = {}) {
  const x =
    'Наблюдатель видит, что одна и та же группа на рассвете сообщает один и тот же отложенный вред после ночной дозы.';
  return {
    workingTitle: 'Отложенный вред канала',
    mediumClass: 'SHARED_CONSUMABLE',
    premise: 'Через общий канал раздачи идёт вещество с отложенным вредом.',
    mysteryQuestion: 'Почему одна группа на рассвете сообщает один и тот же вред?',
    stakes: 'Если не узнать механизм, вред продолжит накапливаться.',
    nodes: [
      {
        id: 'A',
        role: 'person who alters a shared channel',
        event: 'Человек изменил состав вещества, которое идёт по общему каналу раздачи.',
      },
      {
        id: 'B',
        role: 'hidden physical mechanism',
        event: 'Вещество теперь несёт отложенный вред через тот же канал раздачи.',
      },
      {
        id: 'C',
        role: 'affected population',
        event: 'Затронутая группа каждую ночь получает вещество и накапливает вред.',
      },
      {
        id: 'X',
        role: 'expert observer',
        event: x,
      },
    ],
    edges: [
      {
        from: 'A',
        to: 'B',
        mechanism: 'Изменённый состав делает вещество носителем отложенного вреда.',
        counterfactual: 'Без смены состава вред через канал не появился бы.',
      },
      {
        from: 'B',
        to: 'C',
        mechanism: 'Ночная раздача доносит то же вещество до группы.',
        counterfactual: 'Без вредоносного вещества группа не накапливала бы вред.',
      },
      {
        from: 'C',
        to: 'X',
        mechanism: 'Накопленный вред становится слышен в одном и том же докладе на рассвете.',
        counterfactual: 'Без ночного получения вещества наблюдатель не услышал бы тот же вред.',
      },
    ],
    observedProjection: [
      'одна и та же группа на рассвете сообщает один и тот же отложенный вред после ночной дозы',
      'Наблюдатель видит, что одна и та же группа на рассвете сообщает',
    ],
    resolutionFacts: [
      'какой состав вещества изменён в канале раздачи',
      'кто изменил вещество общего канала',
    ],
    bindingSlots: {
      required: [
        { role: 'primary_actor', function: 'изменил состав вещества в общем канале' },
        { role: 'affected_system', function: 'общий канал раздачи вещества' },
        { role: 'first_observer', function: 'слышит одинаковый вред на рассвете' },
      ],
      optional: [{ role: 'expert', function: 'может отличить вред от обычной порчи' }],
    },
    ...extra,
  };
}

test('жребий Phase 1 бросает все оси и gravity', () => {
  const cfg = plotConfig(loadConfig());
  assert.equal(cfg.mysteryArchitect.judgeAttempts, 3);
  const byId = Object.fromEntries(cfg.mysteryArchitect.tagGroups.map((g) => [g.id, g]));
  for (const id of ['scale', 'source', 'entry', 'tone', 'situation', 'dynamic', 'canonRelation']) {
    assert.ok(byId[id], id);
  }
  const seed = pickMysteryArchitectSeed(cfg, () => 0.4);
  const groups = seed.tags.map((t) => t.groupId).sort();
  assert.deepEqual(groups, [
    'association',
    'canonRelation',
    'dynamic',
    'entry',
    'scale',
    'situation',
    'source',
    'tonePrimary',
    'toneSecondary',
    'type',
  ]);
  assert.ok(seed.gravity >= cfg.mysteryArchitect.gravityMin);
  assert.ok(seed.gravity <= cfg.mysteryArchitect.gravityMax);
  assert.equal(gravityBand(20), 'локальные');
  assert.equal(gravityBand(80), 'судьбоносные');
});

test('промпт осей Phase 1 без города и с type.about', () => {
  const cfg = plotConfig(loadConfig());
  const seed = pickMysteryArchitectSeed(cfg, () => 0.2);
  const text = formatMysteryArchitectAxesForPrompt(seed);
  assert.match(text, /GRAVITY:/);
  assert.match(text, /ТИП ТАЙНЫ/);
  assert.match(text, /ПРИОРИТЕТ ТЕГОВ/);
  assert.match(text, /БАЗОВЫЙ НАБОР ОСТРОВА/);
  assert.match(text, /ASSOCIATION/);
  assert.equal(text.includes('Ваэршаль'), false);
  assert.equal(text.includes('Аллерия'), false);
  assert.equal(text.includes('цистерн'), false);
});

test('самозванец и NATIVE в осях: тип не доступ, нет редкой службы', () => {
  const text = formatMysteryArchitectAxesForPrompt({
    gravity: 40,
    tags: [
      { groupId: 'type', tagId: 'impostor', tagName: 'самозванец', about: 'ложная роль' },
      { groupId: 'canonRelation', tagId: 'native', tagName: 'NATIVE' },
    ],
  });
  assert.match(text, /САМОЗВАНЕЦ/);
  assert.match(text, /неумения делать чужую работу/);
  assert.match(text, /базовый набор острова/);
  assert.ok(ARCHITECT_JUDGE_CODES.includes('EXOTIC_BINDING'));
});

test('нормализация skeleton требует A→B→C→X, mediumClass и неизвестные в resolutionFacts', () => {
  const ok = normalizeMysterySkeleton(validDraft());
  assert.equal(ok.reason, null);
  assert.equal(ok.skeleton.nodes.map((n) => n.id).join(''), 'ABCX');
  assert.equal(ok.skeleton.graph.nodes.length, 4);
  assert.equal(ok.skeleton.mediumClass, 'SHARED_CONSUMABLE');
  assert.equal(ok.skeleton.bindingSlots.required.length, 3);
  assert.match(ok.skeleton.graph.edges[0].reason, /Без parent/);

  const thin = normalizeMysterySkeleton(validDraft({ bindingSlots: { required: [] } }));
  assert.equal(thin.reason, 'thin_slots');
  const noMedium = normalizeMysterySkeleton(validDraft({ mediumClass: 'cistern' }));
  assert.equal(noMedium.reason, 'thin_medium');
  const asFact = normalizeMysterySkeleton(
    validDraft({
      resolutionFacts: [
        'какой состав вещества изменён в канале раздачи',
        'человек изменил состав вещества общего канала',
      ],
    }),
  );
  assert.equal(asFact.reason, null);
  const paraphrase = normalizeMysterySkeleton(
    validDraft({
      resolutionFacts: [
        'личность человека, проводившего скрытую подмену',
        'экономическая выгода виновного',
      ],
    }),
  );
  assert.equal(paraphrase.reason, null);
});

test('пакет судьи Phase 1 без города, resolutionFacts как неизвестные', () => {
  const cfg = plotConfig(loadConfig());
  const seed = pickMysteryArchitectSeed(cfg, () => 0.3);
  const { skeleton } = normalizeMysterySkeleton(validDraft());
  const text = formatMysteryArchitectJudgeCase({ seed, skeleton });
  assert.match(text, /абстрактный skeleton/);
  assert.match(text, /неизвестные уже из узлов/);
  assert.match(text, /НЕ сущности истины/);
  assert.match(text, /Отложенный вред канала/);
  assert.match(text, /mediumClass: SHARED_CONSUMABLE/);
  assert.equal(text.includes('Ваэршаль'), false);
  assert.equal(text.includes('летающий остров'), false);
});

function architectRuntime({ drafts, verdicts }) {
  const seen = [];
  return {
    seen,
    runtime: {
      async run({ agentId, tools }) {
        seen.push(agentId);
        if (agentId === 'mysteryArchitect') {
          await tools[0].handler(drafts.shift());
          return;
        }
        await tools[0].handler(verdicts.shift());
      },
    },
  };
}

test('судья Phase 1 принимает только PASS', async () => {
  const { runtime, seen } = architectRuntime({
    drafts: [],
    verdicts: [{ verdict: 'UNCERTAIN', issues: [], summary: 'спорно' }],
  });
  const out = await judgeMysteryArchitect({ runtime, caseText: 'пакет' });
  assert.equal(out.accepted, false);
  assert.deepEqual(seen, ['mysteryArchitectJudge']);
});

test('каскад Phase 1: FAIL, затем PASS — максимум 3 генерации', async () => {
  const { runtime, seen } = architectRuntime({
    drafts: [validDraft(), validDraft()],
    verdicts: [
      {
        verdict: 'FAIL',
        issues: [{ code: 'CITY_SPECIFIC_INSTANTIATION', location: 'B', reason: 'цистерна' }],
        summary: 'город',
      },
      { verdict: 'PASS', issues: [], summary: 'целая цепь' },
    ],
  });
  const out = await seedMysterySkeleton({
    config: loadConfig(),
    runtime,
    seed: pickMysteryArchitectSeed(plotConfig(loadConfig()), () => 0.5),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, [
    'mysteryArchitect',
    'mysteryArchitectJudge',
    'mysteryArchitect',
    'mysteryArchitectJudge',
  ]);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].accepted, false);
  assert.equal(out.attempts[1].accepted, true);
});

test('жребий source зависит от типа; MYTHIC не перевешивает LOCAL', () => {
  const cfg = plotConfig(loadConfig());
  assert.ok(cfg.mysteryArchitect.sourceByType.crime);
  assert.equal(Number(cfg.mysteryArchitect.sourceByType.crime.environment), 1);
  assert.ok(
    Number(cfg.mysteryArchitect.sourceByType.crime.social) >
      Number(cfg.mysteryArchitect.sourceByType.crime.environment),
  );
  const scale = Object.fromEntries(
    cfg.mysteryArchitect.tagGroups.find((g) => g.id === 'scale').tags.map((t) => [t.id, t.weight]),
  );
  assert.equal(scale.local, 4);
  assert.equal(scale.mythic, 1);
  const source = cfg.mysteryArchitect.tagGroups.find((g) => g.id === 'source');
  const crimeSource = weightedArchitectSourceGroup(source, 'crime', cfg.mysteryArchitect.sourceByType);
  const env = crimeSource.tags.find((t) => t.id === 'environment');
  const social = crimeSource.tags.find((t) => t.id === 'social');
  assert.equal(env.weight, 1);
  assert.equal(social.weight, 8);
  const dropped = weightedArchitectSourceGroup(source, 'x', { x: { environment: 0, social: 2 } });
  assert.equal(dropped.tags.some((t) => t.id === 'environment'), false);
});

test('classifyArchitectSkip режет no_seed на реальные причины', () => {
  assert.equal(classifyArchitectSkip({ data: { ok: true } }), null);
  assert.equal(classifyArchitectSkip({ error: new Error('timeout') }), 'GENERATOR_ERROR');
  assert.equal(
    classifyArchitectSkip({
      run: { toolTrace: [{ name: 'submit_mystery_skeleton', result: { error: 'invalid_json_args' } }] },
    }),
    'SCHEMA_INVALID',
  );
  assert.equal(
    classifyArchitectSkip({
      run: { toolTrace: [{ name: 'submit_mystery_skeleton', result: { error: 'thin_slots' } }] },
    }),
    'PRECHECK_FAIL:thin_slots',
  );
  assert.equal(classifyArchitectSkip({ run: { truncated: true, toolTrace: [] } }), 'TRUNCATED');
  assert.equal(classifyArchitectSkip({ run: { toolTrace: [] } }), 'NO_OUTPUT');
  assert.ok(MEDIUM_CLASSES.includes('SHARED_CONSUMABLE'));
});
