import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  plotConfig,
  pickMysteryAnnotationSeed,
  formatMysteryAnnotationAxesForPrompt,
  annotationArenaWeights,
  annotationSeedCompatible,
  annotationPairCompatible,
  annotationGravityBand,
  annotationOmitsTruthNature,
  ANNOTATION_NATURE_OFF_SYSTEM,
} from '../src/game/plotlines.js';
import {
  normalizeMysteryAnnotation,
  countAnnotationSentences,
  seedMysteryAnnotation,
  classifyAnnotationSkip,
  judgeMysteryAnnotation,
  formatMysteryAnnotationJudgeCase,
  formatMysteryAnnotationRevisionForPrompt,
  ANNOTATION_JUDGE_CODES,
} from '../src/game/mysteryAnnotation.js';

const KNOWN_TAG_KEYS = new Set(['id', 'name', 'weight', 'people', 'kind', 'about']);

function validDraft(extra = {}) {
  return {
    workingTitle: 'Стекловидные нити',
    observed:
      'После нескольких ночей на камнях находят одинаковые тонкие стекловидные нити, хотя поблизости ничего такого не производят. Нити появляются снова, если участок мести, и никто не видит, кто их оставляет.',
    truth:
      'Нити приносят небольшие ночные существа из удалённой части острова. Сам перенос никто не видит, потому что он происходит далеко от мест, где остаются нити.',
    hiddenness:
      'Связь не очевидна, потому что существ не встречают у камней, а нити похожи на отход неизвестного ремесла. Простая ночная проверка ничего не даёт: перенос уже закончен.',
    ifSolved:
      'Город начинает собирать нити как прочный материал и заводит устойчивый обмен с дальней частью острова.',
    ifUnsolved:
      'Жители принимают нити за порчу камня и бросают участок, теряя удобный проход и привычное место сбора.',
    ...extra,
  };
}

test('YAML аннотаций: оси, веса, about не разрезан запятыми', () => {
  const cfg = plotConfig(loadConfig());
  const byId = Object.fromEntries(cfg.mysteryAnnotation.tagGroups.map((g) => [g.id, g]));
  for (const id of [
    'truthArena',
    'mysteryQuestion',
    'truthNature',
    'truthDomain',
    'manifestation',
    'situation',
    'epistemicMask',
    'worldRelation',
    'scale',
    'tone',
    'association',
  ]) {
    assert.ok(byId[id], id);
  }
  assert.equal(byId.revealPayoff, undefined);
  assert.equal(cfg.mysteryAnnotation.gravityMin, 0);
  assert.equal(cfg.mysteryAnnotation.gravityMax, 100);
  assert.equal(cfg.mysteryAnnotation.secondaryToneChance, 0);
  assert.equal(cfg.mysteryAnnotation.judgeAttempts, 2);
  assert.equal(cfg.mysteryAnnotation.recentWindow, 5);
  assert.equal(cfg.mysteryAnnotation.cooldown.previousMultiplier, 0.2);
  const natures = byId.truthNature.tags.map((t) => t.id);
  assert.equal(natures.includes('old_event'), false);
  assert.equal(natures.includes('external_intrusion'), false);
  assert.ok(natures.includes('human_action'));
  assert.ok(natures.includes('collective_human_process'));
  assert.ok(natures.includes('creature_behavior'));
  assert.equal(cfg.mysteryAnnotation.incompatible.truthNature, undefined);
  const arenas = Object.fromEntries(byId.truthArena.tags.map((t) => [t.id, t.weight]));
  assert.deepEqual(Object.keys(arenas).sort(), [
    'built',
    'creature',
    'earth',
    'ecology',
    'human',
    'material',
    'sky',
  ]);
  assert.equal(arenas.underisland, undefined);
  assert.equal(arenas.people, undefined);
  assert.ok(Object.values(arenas).every((w) => w === 10));
  assert.match(byId.truthArena.tags.find((t) => t.id === 'earth').about, /не колодец/);
  assert.match(byId.truthArena.tags.find((t) => t.id === 'built').about, /водоотвод/);
  const world = Object.fromEntries(byId.worldRelation.tags.map((t) => [t.id, t.weight]));
  assert.equal(world.native, 35);
  assert.equal(world.contact, 40);
  assert.equal(world.legacy, 25);
  const scale = Object.fromEntries(byId.scale.tags.map((t) => [t.id, t.weight]));
  assert.equal(scale.local, 4);
  assert.equal(scale.mythic, 1);
  const domain = Object.fromEntries(byId.truthDomain.tags.map((t) => [t.id, t.weight]));
  assert.equal(domain.underisland, 1);
  assert.ok(domain.people >= 3);
  assert.ok(domain.surface >= 3);
  const legacy = byId.worldRelation.tags.find((t) => t.id === 'legacy');
  assert.match(legacy.about, /прошлого/);
  assert.match(legacy.about, /структуры/);
  const domains = byId.truthDomain.tags.map((t) => t.id);
  assert.deepEqual(domains, [
    'people',
    'ecology',
    'creatures',
    'surface',
    'sky',
    'body',
    'material',
    'built_environment',
    'underisland',
    'external',
    'past',
  ]);
  for (const g of cfg.mysteryAnnotation.tagGroups) {
    for (const t of g.tags) {
      const extra = Object.keys(t).filter((k) => !KNOWN_TAG_KEYS.has(k));
      assert.deepEqual(extra, [], `${g.id}/${t.id}: YAML разрезал about`);
    }
  }
});

test('жребий аннотации: арена первая, без situation/scale/association/второго тона', () => {
  const cfg = plotConfig(loadConfig());
  assert.equal(cfg.mysteryAnnotation.truthNatureByQuestion, undefined);
  const seed = pickMysteryAnnotationSeed(cfg, () => 0.4);
  const groups = seed.tags.map((t) => t.groupId);
  assert.deepEqual(groups, [
    'truthArena',
    'truthNature',
    'worldRelation',
    'manifestation',
    'tonePrimary',
  ]);
  assert.equal(seed.omitTruthNature, false);
  assert.ok(seed.gravity >= cfg.mysteryAnnotation.gravityMin);
  assert.ok(seed.gravity <= cfg.mysteryAnnotation.gravityMax);
  assert.equal(
    seed.tags.some((t) =>
      [
        'mysteryQuestion',
        'truthDomain',
        'epistemicMask',
        'type',
        'source',
        'revealPayoff',
        'scale',
        'association',
        'toneSecondary',
        'situation',
      ].includes(t.groupId),
    ),
    false,
  );
});

test('ветка B: жребий и промпт без truthNature', () => {
  const cfg = plotConfig(loadConfig());
  const seed = pickMysteryAnnotationSeed(cfg, () => 0.4, { omitTruthNature: true });
  assert.equal(seed.omitTruthNature, true);
  assert.equal(
    seed.tags.some((t) => t.groupId === 'truthNature'),
    false,
  );
  assert.ok(annotationOmitsTruthNature(seed));
  assert.deepEqual(
    seed.tags.map((t) => t.groupId),
    ['truthArena', 'worldRelation', 'manifestation', 'tonePrimary'],
  );
  const text = formatMysteryAnnotationAxesForPrompt(seed);
  assert.match(text, /truthNature не задана/);
  assert.equal(text.includes('truthNature, worldRelation'), false);
  assert.equal(text.includes('ПРИРОДА ИСТИНЫ'), false);
  const { annotation } = normalizeMysteryAnnotation(validDraft());
  const pack = formatMysteryAnnotationJudgeCase({ seed, annotation });
  assert.equal(pack.includes('ПРИРОДА ИСТИНЫ'), false);
  assert.match(ANNOTATION_NATURE_OFF_SYSTEM, /оси truthNature нет/);
  let n = 0;
  const rng = () => {
    n += 1;
    return (n % 19) / 19;
  };
  for (let i = 0; i < 80; i += 1) {
    const s = pickMysteryAnnotationSeed(cfg, rng, { omitTruthNature: true });
    assert.equal(s.tags.some((t) => t.groupId === 'truthNature'), false, `b ${i}`);
    assert.ok(s.tags.some((t) => t.groupId === 'truthArena'));
  }
});

test('промпт осей аннотации: жёсткие/мягкие, исходы, без классификации', () => {
  const cfg = plotConfig(loadConfig());
  const seed = pickMysteryAnnotationSeed(cfg, () => 0.2);
  const text = formatMysteryAnnotationAxesForPrompt(seed);
  assert.match(text, /GRAVITY:/);
  assert.match(text, /исторический вес/i);
  assert.match(text, /Читай первым/);
  assert.match(text, /ЖЁСТКИЕ ОСИ/);
  assert.match(text, /truthArena/);
  assert.match(text, /causal substrate/);
  assert.match(text, /МЯГКИЕ/);
  assert.match(text, /ONE CENTRAL REVEAL/);
  assert.match(text, /если разгадана/);
  assert.match(text, /новым правилом, протоколом, инспекцией/);
  assert.match(text, /Не классифицируй/);
  assert.equal(text.includes('situation'), false);
  assert.equal(annotationGravityBand(18), 'эпизод');
  assert.equal(annotationGravityBand(50), 'городская веха');
  assert.equal(annotationGravityBand(65), 'между вехой и судьбоносным');
  assert.equal(annotationGravityBand(100), 'судьбоносное');
  assert.equal(text.includes('ВОПРОС ТАЙНЫ'), false);
  assert.equal(text.includes('ДОМЕН ИСТИНЫ'), false);
  assert.equal(text.includes('ЭПИСТЕМИЧЕСКАЯ МАСКА'), false);
  assert.equal(text.includes('ЦЕНА РАСКРЫТИЯ'), false);
  assert.equal(text.includes('revealPayoff'), false);
  assert.equal(text.includes('Ваэршаль'), false);
  assert.equal(text.includes('Аллерия'), false);
  assert.equal(text.includes('A → B → C → X'), false);
  assert.equal(text.includes('mediumClass'), false);
  assert.equal(annotationGravityBand(18), 'эпизод');
  assert.equal(annotationGravityBand(50), 'городская веха');
  assert.equal(annotationGravityBand(100), 'судьбоносное');
  const native = formatMysteryAnnotationAxesForPrompt({
    gravity: 40,
    tags: [
      { groupId: 'mysteryQuestion', tagName: 'PROVENANCE', about: 'откуда' },
      { groupId: 'truthDomain', tagId: 'creatures', tagName: 'CREATURES', about: 'существа' },
      { groupId: 'epistemicMask', tagName: 'DISTANCE', about: 'места' },
      { groupId: 'worldRelation', tagId: 'native', tagName: 'NATIVE' },
      { groupId: 'association', tagName: 'остаток' },
    ],
  });
  assert.match(native, /WORLD_RELATION NATIVE/);
  assert.equal(native.includes('ASSOCIATION'), false);
  assert.equal(native.includes('PROVENANCE'), false);
  assert.equal(native.includes('CREATURES'), false);
  assert.equal(native.includes('DISTANCE'), false);
  assert.equal(native.includes('UNDERISLAND'), false);
  const withRecent = formatMysteryAnnotationAxesForPrompt(seed, {
    recent: [{ title: 'Белая пыль', annotation: 'После тумана на крышах оседает известь из старой выработки.' }],
  });
  assert.match(withRecent, /Белая пыль/);
  assert.match(withRecent, /субстрат/);
  assert.equal(formatMysteryAnnotationAxesForPrompt(seed).includes('Белая пыль'), false);
});

test('нормализация брифа: пять секций', () => {
  const ok = normalizeMysteryAnnotation(validDraft());
  assert.equal(ok.reason, null);
  assert.match(ok.annotation.text, /стекловидные нити/i);
  assert.match(ok.annotation.text, /Если разгадана/);
  assert.match(ok.annotation.ifUnsolved, /бросают участок/);
  assert.equal(normalizeMysteryAnnotation({}).reason, 'no_seed');
  assert.equal(normalizeMysteryAnnotation({ annotation: 'Коротко.' }).reason, 'thin_brief');
  assert.equal(
    normalizeMysteryAnnotation(
      validDraft({
        truth:
          'Первое длинное предложение про скрытую причину на камнях. Второе про механизм переноса. Третье про место гнездования. Четвёртое про сезонный ритм. Пятое лишнее.',
      }),
    ).reason,
    'long_sentences:truth',
  );
  assert.equal(countAnnotationSentences(validDraft().observed), 2);
});

function annotationRuntime({ drafts, verdicts }) {
  const seen = [];
  const userMessages = [];
  return {
    seen,
    userMessages,
    runtime: {
      async run({ agentId, tools, userMessages: msgs }) {
        seen.push(agentId);
        if (agentId === 'mysteryAnnotation') {
          userMessages.push(msgs?.[0]?.content || '');
          await tools[0].handler(drafts.shift());
          return;
        }
        await tools[0].handler(verdicts.shift());
      },
    },
  };
}

test('пакет судьи аннотации: бриф, лёгкие коды, gravity fidelity', () => {
  const cfg = plotConfig(loadConfig());
  const seed = pickMysteryAnnotationSeed(cfg, () => 0.3);
  const { annotation } = normalizeMysteryAnnotation(validDraft());
  const text = formatMysteryAnnotationJudgeCase({ seed, annotation });
  assert.match(text, /mystery brief/);
  assert.match(text, /АРЕНА ИСТИНЫ/);
  assert.match(text, /ПРИРОДА ИСТИНЫ/);
  assert.match(text, /ПРОЯВЛЕНИЕ/);
  assert.match(text, /ONE CENTRAL REVEAL/);
  assert.match(text, /Стекловидные нити/);
  assert.match(text, /Если разгадана/);
  assert.match(text, /не граф/);
  assert.equal(text.includes('ДОМЕН ИСТИНЫ'), false);
  assert.equal(text.includes('ВОПРОС ТАЙНЫ'), false);
  assert.equal(text.includes('ЦЕНА РАСКРЫТИЯ'), false);
  assert.equal(text.includes('A → B → C → X'), false);
  assert.equal(text.includes('НЕДАВНИЕ MYSTERY'), false);
  assert.deepEqual(ANNOTATION_JUDGE_CODES, [
    'COHERENT_REVEAL',
    'PLAUSIBLE_ENOUGH',
    'CREDIBLE_HIDDENNESS',
    'ONE_REVEAL',
    'TRUTH_ARENA_FIDELITY',
    'GRAVITY_FIDELITY',
    'OTHER',
  ]);
  assert.equal(ANNOTATION_JUDGE_CODES.includes('INTERESTING_PREMISE'), false);
  assert.equal(ANNOTATION_JUDGE_CODES.includes('TRUTH_NATURE_FIDELITY'), false);
  assert.equal(ANNOTATION_JUDGE_CODES.includes('RECENT_CORE_REPEAT'), false);
  assert.equal(ANNOTATION_JUDGE_CODES.includes('SECOND_REVEAL'), false);
  const ins = loadConfig().agents.mysteryAnnotationJudge.instructions;
  assert.match(ins, /лёгкий судья/i);
  assert.match(ins, /не граф/);
  assert.match(ins, /фрагмент брифа/i);
  assert.match(ins, /ONE_REVEAL/);
  assert.match(ins, /TRUTH_ARENA_FIDELITY/);
  assert.match(ins, /GRAVITY_FIDELITY/);
  assert.match(ins, /gravity 8/);
  assert.match(ins, /gravity 92/);
  assert.match(ins, /Широкая терпимость/);
  assert.match(ins, /голос близкого/);
  assert.match(ins, /избегание раздражителя/);
  assert.equal(ins.includes('INTERESTING_PREMISE'), false);
  assert.equal(ins.includes('RECENT_CORE_REPEAT'), false);
  const gen = loadConfig().agents.mysteryAnnotation.instructions;
  assert.match(gen, /Если разгадана/);
  assert.match(gen, /новым правилом, протоколом, инспекцией/);
  assert.match(gen, /Не классифицируй/);
  assert.match(gen, /Сначала прочитай/);
  assert.match(gen, /CREATURE/);
  assert.match(gen, /ECOLOGY/);
  assert.match(gen, /BUILT/);
  assert.equal(gen.includes('OLD_EVENT'), false);
  assert.equal(gen.includes('EXTERNAL_INTRUSION'), false);
});

test('tool судьи аннотации не просит узлы графа', async () => {
  let locationDesc = '';
  let extra = '';
  const runtime = {
    async run({ tools, userMessages }) {
      locationDesc = tools[0].parameters.properties.issues.items.properties.location.description;
      extra = userMessages[0].content;
      await tools[0].handler({ verdict: 'PASS', issues: [], summary: 'ок' });
    },
  };
  await judgeMysteryAnnotation({ runtime, caseText: 'пакет' });
  assert.match(locationDesc, /бриф/i);
  assert.equal(locationDesc.includes('A → B'), false);
  assert.equal(locationDesc.includes('C, A'), false);
  assert.match(extra, /брифа/);
  assert.match(extra, /ONE_REVEAL/);
  assert.match(extra, /TRUTH_ARENA_FIDELITY/);
  assert.match(extra, /GRAVITY_FIDELITY/);
  assert.equal(extra.includes('INTERESTING_PREMISE'), false);
});

test('судья аннотации принимает только PASS', async () => {
  const { runtime, seen } = annotationRuntime({
    drafts: [],
    verdicts: [{ verdict: 'UNCERTAIN', issues: [], summary: 'спорно' }],
  });
  const out = await judgeMysteryAnnotation({ runtime, caseText: 'пакет' });
  assert.equal(out.accepted, false);
  assert.deepEqual(seen, ['mysteryAnnotationJudge']);
});

test('FAIL судьи отдаёт замечания агенту: та же история, один раз; второй провал — стоп', async () => {
  const { runtime, userMessages } = annotationRuntime({
    drafts: [
      validDraft({ workingTitle: 'Первая' }),
      validDraft({ workingTitle: 'Первая' }),
    ],
    verdicts: [
      {
        verdict: 'FAIL',
        issues: [{ code: 'ONE_REVEAL', location: 'Истина', reason: 'два секрета' }],
        summary: 'второе раскрытие',
      },
      { verdict: 'PASS', issues: [], summary: 'ок' },
    ],
  });
  const out = await seedMysteryAnnotation({
    config: loadConfig(),
    runtime,
    rng: () => 0.41,
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].revise, false);
  assert.equal(out.attempts[1].revise, true);
  const ids = (seed) => (seed?.tags || []).map((t) => `${t.groupId}:${t.tagId}`).join('|');
  assert.equal(ids(out.attempts[0].seed), ids(out.attempts[1].seed));
  assert.equal(ids(out.seed), ids(out.attempts[0].seed));
  assert.equal(out.seed.gravity, out.attempts[0].seed.gravity);
  assert.match(userMessages[1], /ДОРАБОТКА/);
  assert.match(userMessages[1], /ONE_REVEAL/);
  assert.match(userMessages[1], /два секрета/);
  assert.match(userMessages[1], /Первая/);
  assert.equal(userMessages[0].includes('ДОРАБОТКА'), false);
});

test('каскад аннотации: FAIL, затем PASS — тот же seed, черновик и одна доработка', async () => {
  const { runtime, seen } = annotationRuntime({
    drafts: [validDraft(), validDraft()],
    verdicts: [
      {
        verdict: 'FAIL',
        issues: [{ code: 'ONE_REVEAL', location: 'last', reason: 'космология поверх ответа' }],
        summary: 'второе раскрытие',
      },
      { verdict: 'PASS', issues: [], summary: 'одна линия' },
    ],
  });
  const seed = pickMysteryAnnotationSeed(plotConfig(loadConfig()), () => 0.5);
  const out = await seedMysteryAnnotation({
    config: loadConfig(),
    runtime,
    seed,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, [
    'mysteryAnnotation',
    'mysteryAnnotationJudge',
    'mysteryAnnotation',
    'mysteryAnnotationJudge',
  ]);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].accepted, false);
  assert.equal(out.attempts[1].accepted, true);
  assert.equal(out.attempts[1].revise, true);
  assert.equal(out.seed, seed);
  assert.equal(out.attempts[0].seed, seed);
  assert.equal(out.attempts[1].seed, seed);
  assert.equal(out.attempts[0].judge.issues[0].code, 'ONE_REVEAL');
});

test('вторая FAIL после доработки — стоп, без нового жребия', async () => {
  const { runtime, seen } = annotationRuntime({
    drafts: [validDraft({ workingTitle: 'Раз' }), validDraft({ workingTitle: 'Два' })],
    verdicts: [
      {
        verdict: 'FAIL',
        issues: [{ code: 'PLAUSIBLE_ENOUGH', location: 'Истина', reason: 'бессмыслица' }],
        summary: 'нет',
      },
      {
        verdict: 'FAIL',
        issues: [{ code: 'GRAVITY_FIDELITY', location: 'Если разгадана', reason: 'масштаб не тот' }],
        summary: 'всё ещё нет',
      },
    ],
  });
  const seed = pickMysteryAnnotationSeed(plotConfig(loadConfig()), () => 0.2);
  const out = await seedMysteryAnnotation({
    config: loadConfig(),
    runtime,
    seed,
  });
  assert.equal(out.ok, false);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[1].revise, true);
  assert.equal(out.attempts[1].title, 'Два');
  assert.equal(out.attempts[0].seed, seed);
  assert.equal(out.attempts[1].seed, seed);
  assert.deepEqual(seen, [
    'mysteryAnnotation',
    'mysteryAnnotationJudge',
    'mysteryAnnotation',
    'mysteryAnnotationJudge',
  ]);
});

test('seedMysteryAnnotation режет thin и классифицирует skip', async () => {
  const runtime = {
    async run({ tools }) {
      await tools[0].handler({ workingTitle: 'Пусто', annotation: 'Мало.' });
    },
  };
  const out = await seedMysteryAnnotation({
    config: loadConfig(),
    runtime,
    seed: pickMysteryAnnotationSeed(plotConfig(loadConfig()), () => 0.3),
  });
  assert.equal(out.ok, false);
  assert.equal(out.annotation, null);
  assert.match(out.skip, /thin/);
  assert.equal(out.attempts.length, 1);
  assert.equal(classifyAnnotationSkip({ data: { ok: true } }), null);
  assert.equal(classifyAnnotationSkip({ error: new Error('timeout') }), 'GENERATOR_ERROR');
  assert.equal(
    classifyAnnotationSkip({
      run: {
        toolTrace: [{ name: 'submit_mystery_annotation', result: { error: 'invalid_json_args' } }],
      },
    }),
    'SCHEMA_INVALID',
  );
  assert.equal(classifyAnnotationSkip({ run: { truncated: true } }), 'TRUNCATED');
  assert.equal(classifyAnnotationSkip({ run: {} }), 'NO_OUTPUT');
});

test('доработка: промпт держит тот же brief и коды судьи', () => {
  const { annotation } = normalizeMysteryAnnotation(validDraft());
  const text = formatMysteryAnnotationRevisionForPrompt({
    annotation,
    judge: {
      summary: 'два секрета',
      issues: [{ code: 'ONE_REVEAL', location: 'Истина', reason: 'космология поверх ответа' }],
    },
  });
  assert.match(text, /ДОРАБОТКА/);
  assert.match(text, /ONE_REVEAL/);
  assert.match(text, /Стекловидные нити/);
  assert.match(text, /стекловидные нити/i);
});

function mulberry32(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('несовместимость осей: жёсткие баны и случайный жребий без запрещённых пар', () => {
  const cfg = plotConfig(loadConfig());
  const inc = cfg.mysteryAnnotation.incompatible;
  assert.equal(
    annotationPairCompatible(inc, 'truthArena', 'human', 'truthNature', 'natural_process'),
    false,
  );
  assert.equal(
    annotationPairCompatible(inc, 'truthArena', 'ecology', 'truthNature', 'creature_behavior'),
    false,
  );
  assert.equal(
    annotationPairCompatible(inc, 'truthArena', 'built', 'truthNature', 'human_action'),
    false,
  );
  assert.equal(
    annotationPairCompatible(inc, 'truthArena', 'human', 'truthNature', 'human_action'),
    true,
  );
  const rng = mulberry32(20260829);
  for (let i = 0; i < 250; i += 1) {
    const seed = pickMysteryAnnotationSeed(cfg, rng);
    assert.equal(annotationSeedCompatible(seed.tags, inc), true, `seed ${i}`);
    assert.ok(seed.tags.some((t) => t.groupId === 'truthArena'));
    assert.ok(seed.tags.some((t) => t.groupId === 'truthNature'));
    assert.equal(
      seed.tags.some((t) => ['scale', 'association', 'situation', 'old_event'].includes(t.groupId) || t.tagId === 'old_event' || t.tagId === 'external_intrusion'),
      false,
    );
  }
});

test('cooldown снижает повтор той же арены', () => {
  const cfg = plotConfig(loadConfig());
  const recent = [
    { truthArena: 'earth' },
    { truthArena: 'earth' },
    { truthArena: 'built' },
    { truthArena: 'earth' },
  ];
  const w = annotationArenaWeights(cfg, recent);
  assert.ok(w.earth < w.human);
  assert.ok(w.earth < w.sky);
  const fresh = annotationArenaWeights(cfg, []);
  assert.equal(fresh.earth, fresh.human);
  assert.ok(w.earth < fresh.earth);
});
