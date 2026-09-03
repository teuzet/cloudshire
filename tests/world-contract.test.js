import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  formatWorldContractForPrompt,
  matchCosmologyHeuristic,
  worldContractCoversCanonBans,
  WORLD_CONTRACT_ITEMS,
} from '../src/game/worldContract.js';
import {
  sampleGenesisAxes,
  missingAxisIds,
  nextAxisOffer,
  sampleOneAxis,
  axesReadyForConcept,
  emptyAxisInterview,
  setAxisValue,
  GENESIS_AXIS_ORDER,
  formatAxisOffer,
} from '../src/game/genesisAxes.js';
import { normalizeConcept, openingLoreFromConcept } from '../src/game/genesisConcept.js';
import {
  mergePlayerDirectives,
  recordCosmologyConflicts,
  resolveCosmologyConflict,
  hasUnresolvedConflicts,
} from '../src/game/playerDirectives.js';

test('world contract покрывает жёсткие запреты канона', () => {
  const cfg = loadConfig();
  const flags = worldContractCoversCanonBans(cfg);
  assert.equal(flags.humans, true);
  assert.equal(flags.noFlight, true);
  assert.equal(flags.conjunction, true);
  assert.equal(flags.lowMagic, true);
  assert.equal(flags.onePatron, true);
  assert.equal(flags.noCosmos, true);
  const text = formatWorldContractForPrompt(cfg);
  assert.match(text, /20–50 км/);
  assert.match(text, /Люди не летают/);
  assert.ok(WORLD_CONTRACT_ITEMS.length >= 8);
});

test('эвристика космологии ловит эльфов, школу магии и порт', () => {
  const hits = matchCosmologyHeuristic('город эльфов, школа магии и воздушный торговый порт');
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('nonhuman'));
  assert.ok(ids.includes('magic_school'));
  assert.ok(ids.includes('airships'));
});

test('семпл осей: все оси, pressure ~50% NONE_OR_MILD', () => {
  const cfg = loadConfig();
  const ids = (cfg.genesis.axes || []).map((g) => g.id);
  assert.deepEqual(ids, GENESIS_AXIS_ORDER);
  const a = sampleGenesisAxes(cfg, () => 0.01);
  for (const id of ids) assert.ok(a[id]?.value, id);
  let mild = 0;
  for (let i = 0; i < 200; i += 1) {
    const s = sampleGenesisAxes(cfg, Math.random);
    if (s.structuralPressure?.value === 'NONE_OR_MILD') mild += 1;
  }
  assert.ok(mild > 60 && mild < 140, `mild=${mild}`);
});

test('опрос по осям: missing → resolve random/agent → unique feature', () => {
  const cfg = loadConfig();
  let axes = {};
  const missing = missingAxisIds(cfg, axes);
  assert.equal(missing.length, GENESIS_AXIS_ORDER.length);
  const first = nextAxisOffer(cfg, axes);
  assert.equal(first.axisId, 'landscapeForm');
  assert.match(first.prompt, /макроформ/);
  assert.ok(first.options.length >= 2);
  assert.ok(first.extras.some((e) => e.id === 'random'));
  assert.ok(first.extras.some((e) => e.id === 'agent'));

  const sampled = sampleOneAxis(cfg, 'landscapeForm', () => 0.01);
  assert.ok(sampled?.value);
  axes = setAxisValue(axes, 'landscapeForm', sampled.value, 'sampled');
  assert.equal(missingAxisIds(cfg, axes).length, GENESIS_AXIS_ORDER.length - 1);

  axes = sampleGenesisAxes(cfg, () => 0.2, { keep: axes, onlyMissing: true });
  assert.equal(missingAxisIds(cfg, axes).length, 0);
  const interview = emptyAxisInterview();
  assert.equal(axesReadyForConcept(cfg, axes, interview, { uniqueFeatureRequired: true }), false);
  interview.uniqueFeatureAsked = true;
  assert.equal(axesReadyForConcept(cfg, axes, interview, { uniqueFeatureRequired: true }), true);
  assert.equal(axesReadyForConcept(cfg, axes, interview, { uniqueFeatureRequired: false }), true);
});

test('ось особенности в анкете открытая: без однословных типов', () => {
  const cfg = loadConfig();
  const offer = formatAxisOffer(cfg, 'signatureDomain');
  assert.equal(offer.open, true);
  assert.equal(offer.options.length, 0);
  assert.match(offer.prompt, /конкретн/i);
  assert.doesNotMatch(offer.prompt, /живой ресурс|ландшафт, материал/i);
});

test('директивы: конфликт блокирует, адаптация становится required', () => {
  let d = recordCosmologyConflicts({}, [
    { requested: 'город эльфов', reason: 'все жители — люди', adaptations: ['древняя человеческая культура'] },
  ]);
  assert.equal(hasUnresolvedConflicts(d), true);
  d = resolveCosmologyConflict(d, { requested: 'город эльфов', chosenAdaptation: 'древняя человеческая культура' });
  assert.equal(hasUnresolvedConflicts(d), false);
  assert.ok(d.required.includes('древняя человеческая культура'));
  d = mergePlayerDirectives(d, { forbidden: ['грибы'] });
  assert.ok(d.forbidden.includes('грибы'));
});

test('concept schema: READY требует имя и длинный preview, features не обязательны', () => {
  const thin = normalizeConcept({ status: 'READY', name: 'Сарвел', preview: 'коротко' });
  assert.equal(thin.concept, null);
  const ok = normalizeConcept({
    status: 'READY',
    name: 'Верхолесье',
    radiusKm: 32,
    identity: { oneLine: 'Старый город на ветреном нагорье' },
    definingFeatures: [
      { domain: 'BIOLOGICAL_RESOURCE', source: 'GENERATED', description: 'Волокнистая культура для бумаги и канатов.' },
      { domain: 'SOCIAL_CUSTOM', source: 'GENERATED', description: 'Кварталы сами решают внутренние дела.' },
    ],
    landscape: 'Высокое ветреное плато с двумя лесными долинами.',
    settlement: 'Несколько старых кварталов.',
    livelihood: 'Овцы, шерсть и волокно.',
    preview:
      'Верхолесье — старый город на ветреном высоком плато, прорезанном двумя глубокими лесными долинами. Главное богатство — овцы, шерсть и волокнистая культура. Кварталы привыкли решать дела сами. Пастбища постепенно становятся теснее.',
  });
  assert.equal(ok.reason, null);
  assert.equal(ok.concept.status, 'READY');
  const lore = openingLoreFromConcept(ok.concept, { min: 8, max: 12 });
  assert.ok(lore.length >= 8);
  assert.match(lore[0], /Верхолесье/);
});

test('openingLoreFromConcept не зависает на тонком концепте (только имя и preview)', () => {
  const lore = openingLoreFromConcept(
    {
      status: 'READY',
      name: 'Варшела',
      identity: { oneLine: 'Город на дереве, дома и оборона от джунглей.' },
      definingFeatures: [],
      landscape: '',
      settlement: '',
      livelihood: '',
      preview:
        'Варшела стоит в котловине. В центре растёт огромное дерево. Вокруг ствола — мостки. Под корнями — храм.',
    },
    { min: 8, max: 12 },
  );
  assert.ok(lore.length >= 4);
  assert.ok(lore.length <= 12);
  assert.match(lore.join('\n'), /Варшела/);
});
