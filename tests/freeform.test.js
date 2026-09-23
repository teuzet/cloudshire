import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlotline,
  isThreeActPlot,
  isStakedStory,
  isFreeformPlot,
  storyTypeOf,
  formatCloseWhen,
  normalizeCloseWhenList,
  normalizeFreeformEndings,
  normalizePlotlines,
  plotBeatAgentId,
  PLOT_ENDING_MAX,
  PLOT_HOOK_MAX,
} from '../src/game/plotlines.js';
import { appendChronicle, advanceWorldMonths, normalizeFinish, freeformConfig, formatContinuationAuthorForPrompt, pickContinuationAuthor, openStoryTitlesLine, formatFreeformGravityForPrompt, formatFreeformChronicleSeed, formatBrainstormCandidateForPrompt, parseFreeformGravity, parseFreeformUrgency, FREEFORM_GRAVITY, clampFreeformCountdown, createFreeformPlot, sampleFreeformMaxDepth, advanceFreeformDepth, formatFreeformDepth, plotCardForPrompt, applyFreeformProgress, freeformTickDecision, autotickCloseKind, rollFreeformCountdown, maxFailsForGravity } from '../src/game/freeform.js';
import { parseFreeformPick, formatFreeformVariants, formatFreeformCardJudgeCase, formatFreeformCardJudgeRepair, parseFreeformPackReview, FREEFORM_PACK_JUDGE_CODES } from '../src/game/freeformJudge.js';
import { normalizeSeedBlank, pickFreeformSeedAxes, pickFreeformSeedAxisSets, formatFreeformAxisCatalogs, formatFreeformSeedAxisSetsForPrompt } from '../src/game/freeformArchitect.js';
import { listLegalBeatDynamics, pickFreeformBeatDynamics, formatBeatDynamicsForPrompt } from '../src/game/freeformDynamics.js';
import { sessionPayload, snapshotForUndo, pushUndo, popUndo } from '../src/clients/web/freeformLab.js';
import {
  pickFreeformBrainstormRolls,
  formatFreeformBrainstormRollsForPrompt,
  rollFromBrainstormCandidate,
  brainstormFreeformSeeds,
  brainstormFreeformPack,
  repairBrainstormPack,
  pushFailedRepairHistory,
  normalizeBrainstormCandidate,
  pickPassedBrainstormCandidate,
  pickBrainstormPoolWinner,
  parseFreeformPoolPick,
  parseRequireMystery,
  shouldRequireSeedMystery,
  parseEmitCandidateList,
  intersectPackReviews,
  GENESIS_JUDGE_EXTRA,
  GENESIS_ARCHITECT_EXTRA,
} from '../src/game/freeformBrainstorm.js';
import {
  splitChronicleHiddenLayer,
  fallbackAssembledStory,
  assembleFreeformLabStory,
  isHollowHiddenPremise,
  keepSeedReveals,
  hasSeedReveal,
  keepStoryTitle,
  nameAssembledStory,
  heuristicHiddenSplit,
  leftoverSeedFacts,
  splitAssembledHidden,
  candidateHiddenLayer,
  formatCandidateSeed,
} from '../src/game/freeformAssemble.js';
import { plantStakedStory } from '../src/game/storyteller.js';
import { startFreeformStory, normalizeSeedVariant } from '../src/game/freeformStarter.js';
import { normalizeHiddenPremises } from '../src/game/premises.js';
import { tellFreeformBeat } from '../src/game/freeformTeller.js';
import { loadConfig } from '../src/config.js';
import { createWebServer } from '../src/clients/web/server.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const LEGACY_FREEFORM_AGENTS = ['freeformArchitectStart', 'freeformStart', 'freeformJudge', 'freeformCardJudge'];

function loadLegacyFreeformAgents() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../config/freeform-legacy-agents.yaml');
  return yaml.load(fs.readFileSync(file, 'utf8')).agents;
}

function configWithLegacyFreeform() {
  const cfg = loadConfig();
  cfg.agents = { ...cfg.agents, ...loadLegacyFreeformAgents() };
  return cfg;
}

function seedArchitectBlank(i, hook = `Затравка сапога ${i}`) {
  return {
    hook,
    conflict: `Конфликт сапога ${i}`,
    dynamics: `Динамика сапога ${i}`,
    consequences: `Последствия сапога ${i}`,
  };
}

function passPackReviews(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    verdict: 'PASS',
    summary: 'ок',
    repair: '',
  }));
}

const LAB_ENDINGS = [
  {
    id: 'g',
    text: 'Хозяин найден.',
    kind: 'GOOD_ENDING',
    questionGone: 'сапог отдан, спрашивать больше не о чем',
    nowDifferent: 'двор завёл книгу оставленных вещей',
  },
  {
    id: 'n',
    text: 'Сапог забыт.',
    kind: 'NEUTRAL_ENDING',
    questionGone: 'о сапоге перестали спрашивать сами',
    nowDifferent: 'угол у ворот отдан под ничейное добро',
  },
  {
    id: 'b',
    text: 'Сапог проклял двор.',
    kind: 'BAD_ENDING',
    questionGone: 'двор оставили, спорить не о чем',
    nowDifferent: 'площадь у ворот стоит пустая',
  },
];

async function handleBeatPipeline(opts, { blanks, construct, n = 3 } = {}) {
  const tool = opts.tools?.[0];
  if (!tool) return;
  if (opts.agentId === 'freeformArchitectTell') {
    await tool.handler({ variants: blanks });
  } else if (opts.agentId === 'freeformBeatJudge') {
    const count = Number(tool.parameters?.properties?.reviews?.maxItems) || n;
    await tool.handler({ reviews: passPackReviews(count) });
  } else if (opts.agentId === 'freeformTell' && construct) {
    await tool.handler(construct);
  } else if (opts.agentId === 'freeformEndings') {
    await tool.handler({ keep: false, endings: LAB_ENDINGS });
  } else if (opts.agentId === 'freeformEndingsJudge') {
    const count = Number(tool.parameters?.properties?.reviews?.maxItems) || LAB_ENDINGS.length;
    await tool.handler({
      reviews: Array.from({ length: count }, (_, i) => ({ index: i + 1, verdict: 'PASS' })),
    });
  } else if (opts.agentId === 'freeformUrgency') {
    await tool.handler({ urgency: 'MEDIUM' });
  }
}

test('freeform — отдельный тип, не трёхтакт', () => {
  const plot = createPlotline({
    title: 'Соль на ветру',
    kind: 'story',
    storyType: 'story',
    closeWhen: ['Найти источник соли', 'Признать, что соли нет'],
    hiddenPremises: ['Соль сыплется из разлома края, не из склада.'],
    urgency: 70,
    gravity: 'EPISODE',
  });
  assert.equal(plot.type, 'story');
  assert.equal(isStakedStory(plot), true);
  assert.equal(isFreeformPlot(plot), false);
  assert.equal(isThreeActPlot(plot), false);
  assert.equal(storyTypeOf(plot), 'story');
  assert.equal(plotBeatAgentId(plot), 'freeformTell');
  assert.deepEqual(plot.closeWhen, ['Найти источник соли', 'Признать, что соли нет']);
  assert.match(formatCloseWhen(plot), /1\. Найти источник соли/);
  assert.equal(plot.urgency, 'FAST');
  assert.ok(plot.hiddenPremises.length);
  assert.equal(plot.act, undefined);
  assert.equal(plot.truth, undefined);
  assert.equal(plot.asksSequel, undefined);
  assert.equal(plot.depth, 0);
  assert.equal(plot.maxDepth, 3);
  assert.equal(plot.failCount, 0);
  assert.equal(plot.maxFails, 1);
});

test('нормализация снимает трёхтактный блоб и оси посева', () => {
  const domain = {
    plotlines: [
      {
        id: 'plot_old',
        title: 'Сапог',
        kind: 'story',
        storyType: 'story',
        gravity: 'EPISODE',
        act: 2,
        truth: 'соль из края',
        truthGraph: { nodes: [] },
        asksSequel: true,
        annotationId: 'ann_1',
        arena: 'HUMAN',
        hook: 'старый хук',
        conflict: 'старый конфликт',
        importance: 80,
        cause: 'соль сыплется из разлома края',
      },
    ],
    closedPlotlines: [
      {
        id: 'plot_closed',
        title: 'Было',
        kind: 'story',
        storyType: 'mystery',
        truth: 'секрет',
        status: 'closed',
      },
    ],
  };
  normalizePlotlines(domain);
  const live = domain.plotlines[0];
  assert.equal(live.type, 'story');
  assert.equal(live.gravity, 'EPISODE');
  assert.equal(live.act, undefined);
  assert.equal(live.truth, undefined);
  assert.equal(live.truthGraph, undefined);
  assert.equal(live.asksSequel, undefined);
  assert.equal(live.annotationId, undefined);
  assert.equal(live.arena, undefined);
  assert.equal(live.hook, undefined);
  assert.equal(live.conflict, undefined);
  assert.equal(live.importance, undefined);
  assert.equal(live.cause, 'соль сыплется из разлома края', 'первопричина переживает нормализацию');
  assert.equal(domain.closedPlotlines[0].truth, undefined);
});

test('closeWhen список нормализуется', () => {
  assert.deepEqual(normalizeCloseWhenList('Один\nОдин\nДва'), ['Один', 'Два']);
  assert.deepEqual(normalizeCloseWhenList(['А', '', 'А']), ['А']);
  const long = 'слово '.repeat(80).trim();
  const [item] = normalizeCloseWhenList([long]);
  assert.ok(item.endsWith('…'));
  assert.ok(item.length <= PLOT_HOOK_MAX + 1);
});

test('текст эндинга не режется лимитом closeWhen', () => {
  const long =
    'Площадь и Обелиск частично проваливаются, но город успевает огородить опасную зону и перенести колодцы и торг в другое место. Город выживает, потеряв важный ориентир и часть воды.';
  assert.ok(long.length > PLOT_HOOK_MAX);
  assert.ok(long.length < PLOT_ENDING_MAX);
  const [ending] = normalizeFreeformEndings([{ id: 'n', kind: 'NEUTRAL_ENDING', text: long }]);
  assert.equal(ending.text, long);
  const plot = createPlotline({
    title: 'Провал',
    kind: 'story',
    storyType: 'story',
    gravity: 'CRISIS',
    endings: [
      { id: 'g', kind: 'GOOD_ENDING', text: long },
      { id: 'n', kind: 'NEUTRAL_ENDING', text: 'Нейтраль.' },
      { id: 'b', kind: 'BAD_ENDING', text: 'Плохо.' },
    ],
  });
  assert.equal(plot.endings[0].text, long);
  assert.equal(plot.closeWhen[0], long);
  const tooLong = 'слово '.repeat(200).trim();
  const [clipped] = normalizeFreeformEndings([{ id: 'g', kind: 'GOOD_ENDING', text: tooLong }]);
  assert.ok(clipped.text.endsWith('…'));
  assert.ok(clipped.text.length <= PLOT_ENDING_MAX + 1);
});

test('freeform глубина — с нуля и без потолка текущей', () => {
  assert.equal(sampleFreeformMaxDepth('EPISODE', () => 0), 2);
  assert.equal(sampleFreeformMaxDepth('RUPTURE', () => 0), 3);
  const plot = createPlotline({
    title: 'Сапог',
    kind: 'story',
    storyType: 'story',
    gravity: 'EPISODE',
    depth: 0,
    maxDepth: 3,
  });
  assert.equal(plot.depth, 0);
  assert.equal(plot.maxDepth, 3);
  assert.equal(formatFreeformDepth(plot), 'глубина 0/3');
  assert.match(plotCardForPrompt(plot), /глубина 0\/3/);
  assert.doesNotMatch(plotCardForPrompt(plot), /если не займутся|whyMoves/);
  advanceFreeformDepth(plot);
  assert.equal(plot.depth, 1);
  assert.equal(plot.maxDepth, 3);
  advanceFreeformDepth(plot);
  advanceFreeformDepth(plot);
  assert.equal(plot.depth, 3);
  advanceFreeformDepth(plot);
  assert.equal(plot.depth, 4);
});

test('исход дела и сдвиг календаря', () => {
  assert.equal(normalizeFinish('критический успех'), 'crit');
  assert.equal(normalizeFinish('провал'), 'fail');
  const world = { tickIndex: 14, gameDate: { year: 2, month: 3 } };
  const date = advanceWorldMonths(world, 2);
  assert.equal(world.tickIndex, 16);
  assert.equal(date.label, 'Год 2, месяц 5');
});

test('запись посева датируется днём, а лаборатория остаётся на месяце', () => {
  const world = { tickIndex: 7, gameDate: { year: 1, month: 8, label: 'Год 1, месяц 8' } };
  const domain = { id: 'd1', lore: [], plotlines: [{ id: 'p1', chronicleIds: [] }] };

  const dated = appendChronicle(domain, world, {
    text: 'В Срединном поясе загудели каменные ступени.',
    plotId: 'p1',
    author: 'freeform:seed',
    day: 232,
  });
  assert.equal(dated.day, 232);
  assert.equal(dated.gameDateLabel, 'Год 1, месяц 8, день 23', 'иначе в летописи строка без дня');
  assert.deepEqual(domain.plotlines[0].chronicleIds, [dated.id]);

  const undated = appendChronicle(domain, world, { text: 'Лабораторная запись.', author: 'lab:errand' });
  assert.equal(undated.day, undefined, 'пустой день не должен становиться первым днём года');
  assert.equal(undated.gameDateLabel, 'Год 1, месяц 8');
});

test('судья выбирает номер варианта с 1', () => {
  const parsed = parseFreeformPick({ pick: 3, why: 'живее', repair: '', issues: [] }, 5);
  assert.equal(parsed.pick, 3);
  assert.equal(parseFreeformPick({ pick: 99 }, 3).pick, 1);
});

test('конфиг freeform читается из YAML', () => {
  const cfg = freeformConfig(loadConfig());
  assert.equal(cfg.variantsMin, 3);
  assert.equal(cfg.variantsMax, 3);
  assert.deepEqual(cfg.chronicleMaxChars, { seed: 3600, beat: 1200, ending: 1800 });
  assert.equal(cfg.seedMysteryChance, 0.25);
  assert.equal(cfg.lunaRepairRounds, 2);
  assert.deepEqual(Object.keys(cfg.axes), [
    'arena',
    'worldRelation',
    'target',
    'knowledge',
    'engine',
    'timing',
  ]);
  assert.deepEqual(
    cfg.axes.arena.map((v) => v.id),
    ['human', 'custom', 'creature', 'ecology', 'matter', 'sky', 'phenomenon'],
  );
  assert.deepEqual(
    cfg.axes.worldRelation.map((v) => v.id),
    ['native', 'arrived', 'born', 'surfaced', 'legacy'],
  );
  assert.deepEqual(
    cfg.axes.knowledge.map((v) => v.id),
    ['open', 'unknown', 'few_know', 'false_belief', 'too_late'],
  );
  assert.equal(cfg.axes.target.length, 9);
  assert.equal(cfg.axes.arena[0].name, 'HUMAN');
  assert.equal(cfg.axes.arena.find((v) => v.id === 'matter').weight, 5);
  assert.equal(cfg.axes.worldRelation.find((v) => v.id === 'native').weight, 20);
  assert.deepEqual(
    cfg.axes.engine.map((v) => v.id),
    [
      'refusal',
      'open_feud',
      'discovery',
      'internal_betrayal',
      'moral_dilemma',
      'systemic_crisis',
      'price_of_success',
      'rival_ideology',
    ],
  );
  assert.deepEqual(
    cfg.axes.timing.map((v) => v.id),
    ['fresh_incident', 'long_simmering', 'cyclical_pattern', 'delayed_bomb', 'blow', 'did_not_happen'],
  );
  assert.equal(cfg.axes.engine.find((v) => v.id === 'refusal').weight, 5);
  assert.equal(cfg.axes.timing.find((v) => v.id === 'did_not_happen').weight, 4);
  assert.ok(new Set(cfg.axes.engine.map((v) => v.weight)).size > 1);
  assert.ok(new Set(cfg.axes.timing.map((v) => v.weight)).size > 1);
  assert.ok(Object.values(cfg.axes).every((list) => list.every((v) => v.about && v.weight > 0)));
  const agents = loadConfig().agents;
  for (const id of LEGACY_FREEFORM_AGENTS) {
    assert.equal(Boolean(agents[id]), false, `${id} должен быть только в архиве, не в default.yaml`);
  }
  const archived = loadLegacyFreeformAgents();
  for (const id of LEGACY_FREEFORM_AGENTS) {
    assert.ok(archived[id]?.instructions, `${id} должен быть в config/freeform-legacy-agents.yaml`);
  }
  assert.equal(agents.freeformBrainstorm.provider, 'anthropic');
  assert.equal(agents.freeformBrainstorm.model, 'claude-sonnet-5');
  assert.equal(agents.freeformBrainstorm.maxTokens, 16000);
  assert.deepEqual(agents.freeformBrainstorm.canon, ['world']);
  assert.match(agents.freeformBrainstorm.instructions, /затравк/);
  assert.match(agents.freeformBrainstorm.instructions, /нарративн/);
  assert.match(agents.freeformBrainstorm.instructions, /5–7 предложен/);
  assert.match(agents.freeformBrainstorm.instructions, /НЕ БОЛЬШЕ/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /Можно больше/);
  assert.match(agents.freeformBrainstorm.instructions, /недели и месяцы/);
  assert.match(agents.freeformBrainstorm.instructions, /Судьбоносность/);
  assert.match(agents.freeformBrainstorm.instructions, /Расшифровка выбранного уровня/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /четыре поля|четырьмя полями/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /только к полю «последствия»/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /агент брейншторма/);
  assert.match(agents.freeformBrainstorm.instructions, /эпитетов и орнамента/);
  assert.match(agents.freeformBrainstorm.instructions, /объясняет сюжет структурно/);
  assert.match(agents.freeformBrainstorm.instructions, /Все двигатели должны быть заданы явно/);
  assert.match(agents.freeformBrainstorm.instructions, /бог-покровитель и верховный жрец/);
  assert.match(agents.freeformBrainstorm.instructions, /клиффхэнгер/);
  assert.match(agents.freeformBrainstorm.instructions, /записей несколько/);
  assert.match(agents.freeformBrainstorm.instructions, /не обязательно из последней строки/);
  assert.match(agents.freeformBrainstorm.instructions, /текущее или будущее сопряжение/);
  assert.match(agents.freeformBrainstorm.instructions, /arena, worldRelation, target, knowledge/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /engine, timing/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /- engine —/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /- timing —/);
  assert.match(agents.freeformBrainstorm.instructions, /причинный субстрат/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /arena — это происхождение/);
  assert.match(agents.freeformBrainstorm.instructions, /отдельная история на выбор/);
  assert.match(agents.freeformBrainstorm.instructions, /Неизвестно \(канон\)/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /выбираешь сам/);
  assert.match(agents.freeformBrainstorm.instructions, /emit_freeform_candidates/);
  assert.match(agents.freeformBrainstorm.instructions, /по-русски/);
  assert.match(agents.freeformBrainstorm.instructions, /hiddenLayer/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /по-английски|На самом деле:/);
  // Каталоги значений живут только в tick.plot.freeform.axes и приходят в запросе.
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /^HUMAN —|^NATIVE —|^FOOD —/m);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /threatArena|conflictSource|temporalShape|CONTACT/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /судья|конструктор|cityBrief|recent_themes|actor_scope/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /позже подставит/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /ОБЯЗАТЕЛЬНАЯ ТАЙНА|MYSTERY_PLAUSIBLE/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /НЕТ ЗАТРАВКИ|абстрактный город-государство/);
  const gravity = freeformConfig(loadConfig()).gravity;
  assert.match(gravity.intro, /Судьбоносность/);
  assert.equal(gravity.levels.SITUATION.examples.length, 7);
  assert.equal(gravity.levels.EPISODE.examples.length, 8);
  assert.equal(gravity.levels.CRISIS.examples.length, 10);
  assert.match(gravity.levels.RUPTURE.about, /до.*после/);
  assert.match(gravity.levels.RUPTURE.examples[0], /Война/);
  const beatDyn = freeformConfig(loadConfig()).beatDynamics;
  assert.equal(beatDyn.some((d) => d.id === 'SETTLEMENT'), false);
  assert.ok(beatDyn.some((d) => d.id === 'PLOT_TWIST'));
  assert.ok(beatDyn.some((d) => d.id === 'POLARIZATION'));
  assert.ok(beatDyn.some((d) => d.id === 'DEADLOCK'));
  assert.deepEqual(beatDyn.find((d) => d.id === 'DEADLOCK').polarities, ['bad']);
  assert.deepEqual(beatDyn.find((d) => d.id === 'PLOT_TWIST').polarities, ['good', 'bad']);
  assert.equal(beatDyn.some((d) => d.id === 'DEPLETION' || d.id === 'cascade'), false);
  assert.equal(agents.freeformBrainstormJudge.provider, 'openai');
  assert.equal(agents.freeformBrainstormJudge.model, 'gpt-5.6-luna');
  assert.deepEqual(agents.freeformBrainstormJudge.canon, ['world']);
  assert.match(loadConfig().canon.world, /необитаемые малые тела/);
  assert.match(loadConfig().canon.world, /не является сопряжением/);
  assert.doesNotMatch(loadConfig().canon.world, /тварь|груз руды|курс малых/);
  assert.match(agents.freeformBrainstorm.instructions, /метафизика конкретного острова/);
  assert.match(agents.freeformBrainstormJudge.instructions, /submit_freeform_pack_review/);
  assert.match(agents.freeformBrainstormJudge.instructions, /GRAVITY/);
  assert.match(agents.freeformBrainstormJudge.instructions, /COSMOLOGY/);
  assert.match(agents.freeformBrainstormJudge.instructions, /BUREAUCRACY_PORN/);
  assert.match(agents.freeformBrainstormJudge.instructions, /WATER_SYSTEMS_PORN/);
  assert.match(agents.freeformBrainstormJudge.instructions, /TEMPO/);
  assert.match(agents.freeformBrainstormJudge.instructions, /ECONOMY/);
  assert.match(agents.freeformBrainstormJudge.instructions, /часы или дни/);
  assert.match(agents.freeformBrainstormJudge.instructions, /украшательств/);
  assert.match(agents.freeformBrainstormJudge.instructions, /больше 7 предложений/);
  assert.match(agents.freeformBrainstormJudge.instructions, /PATRON/);
  assert.match(agents.freeformBrainstormJudge.instructions, /CONFLUX/);
  assert.match(agents.freeformBrainstormJudge.instructions, /AXIS/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /^HUMAN —|^NATIVE —|^FOOD —/m);
  assert.match(agents.freeformBrainstormJudge.instructions, /CANONICAL_UNKNOWNS/);
  assert.match(agents.freeformBrainstormJudge.instructions, /Неизвестно \(канон\)/);
  assert.match(agents.freeformBrainstormJudge.instructions, /Не предлагай новый сюжет, новый двигатель/);
  assert.match(agents.freeformBrainstormJudge.instructions, /BUREAUCRACY/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /ENGINEERING_PORN/);
  assert.match(agents.freeformBrainstormJudge.instructions, /CAUSALITY/);
  assert.match(agents.freeformBrainstormJudge.instructions, /NATURAL_PEOPLE_BEHAVIOUR/);
  assert.match(agents.freeformBrainstormJudge.instructions, /Угроза или возможность/);
  assert.match(agents.freeformBrainstormJudge.instructions, /Главный персонаж — сам город/);
  assert.match(agents.freeformBrainstormJudge.instructions, /скрытом слою/);
  assert.match(agents.freeformBrainstormJudge.instructions, /Неизвестно/);
  assert.match(agents.freeformBrainstormJudge.instructions, /верховный жрец/);
  assert.match(agents.freeformBrainstormJudge.instructions, /список замечаний по этим критериям/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /Пустой repair|repair всё равно|repair —/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /вход для дела/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /4–5 предложен|Шестое/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /четыре поля|четырьмя полями/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /поле «последствия»/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /хранител|инея|плато|звер(ь|я|ю)|договор.{0,40}остров/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /конструктор|cityBrief/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /MYSTERY_PLAUSIBLE|тайна обязательна/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /НЕТ ЗАТРАВКИ|абстрактный город-государство/);
  assert.equal(agents.freeformBrainstormRepairSonnet.provider, 'anthropic');
  assert.equal(agents.freeformBrainstormRepairSonnet.model, 'claude-sonnet-5');
  assert.equal(agents.freeformBrainstormRepairSonnet.maxTokens, 16000);
  assert.deepEqual(agents.freeformBrainstormRepairSonnet.canon, ['world']);
  assert.equal(agents.freeformBrainstormRepair.provider, 'openai');
  assert.equal(agents.freeformBrainstormRepair.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformBrainstormRepair.maxTokens, 4000);
  assert.deepEqual(agents.freeformBrainstormRepair.canon, ['world']);
  assert.equal(agents.freeformBrainstormRepair.instructions, agents.freeformBrainstormRepairSonnet.instructions);
  assert.match(agents.freeformBrainstormRepair.instructions, /исправить ровно то/);
  assert.match(agents.freeformBrainstormRepair.instructions, /код критерия/);
  assert.match(agents.freeformBrainstormRepair.instructions, /Не выдумывай будущие и текущие сопряжения/);
  assert.match(agents.freeformBrainstormRepair.instructions, /knowledge не OPEN/);
  assert.match(agents.freeformBrainstormRepair.instructions, /Неизвестно \(канон\)/);
  assert.match(agents.freeformBrainstormRepair.instructions, /5–7 кратких предложений/);
  assert.match(agents.freeformBrainstormRepair.instructions, /водоотвод/);
  assert.match(agents.freeformBrainstormRepair.instructions, /подъёмник/);
  assert.match(agents.freeformBrainstormRepair.instructions, /текущее состояние/);
  assert.match(agents.freeformBrainstormRepair.instructions, /emit_freeform_candidates/);
  assert.match(agents.freeformBrainstormRepair.instructions, /hiddenLayer/);
  assert.doesNotMatch(agents.freeformBrainstormRepair.instructions, /нет полного описания города/);
  assert.doesNotMatch(agents.freeformBrainstormRepair.instructions, /cityBrief|конструктор/);
  assert.doesNotMatch(agents.freeformBrainstormRepair.instructions, /4–5 коротких/);
  assert.equal(agents.freeformBrainstormPick.provider, 'openai');
  assert.equal(agents.freeformBrainstormPick.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformBrainstormPick.maxTokens, 400);
  assert.deepEqual(agents.freeformBrainstormPick.canon, ['world']);
  assert.match(agents.freeformBrainstormPick.instructions, /геолог/);
  assert.match(agents.freeformBrainstormPick.instructions, /водосбор/);
  assert.match(agents.freeformBrainstormPick.instructions, /канцеляр/);
  assert.match(agents.freeformBrainstormPick.instructions, /pick_freeform_pool_winner/);
  assert.doesNotMatch(agents.freeformBrainstormPick.instructions, /cityBrief|конструктор/);
  const authors = freeformConfig(loadConfig()).continuationAuthors;
  assert.ok(authors.length >= 12);
  assert.equal(new Set(authors.map((a) => a.id)).size, authors.length);
  assert.ok(authors.some((a) => a.name.includes('По')));
  assert.equal(agents.freeformArchitectTell.model, 'claude-haiku-4-5');
  assert.deepEqual(agents.freeformArchitectTell.canon, ['world']);
  assert.match(agents.freeformArchitectTell.instructions, /один абзац/);
  assert.doesNotMatch(agents.freeformArchitectTell.instructions, /ХОДА|whatHappens|closeWhen|situationNow|архитектор/);
  assert.equal(Boolean(agents.freeformArchitect), false);
  assert.equal(agents.freeformTell.provider, 'anthropic');
  assert.equal(agents.freeformTell.model, 'claude-haiku-4-5');
  assert.match(agents.freeformTell.instructions, /пересказ всего сюжета/);
  assert.match(agents.freeformTell.instructions, /Год 3, месяц 6/);
  assert.match(agents.freeformTell.instructions, /нумерованн/);
  assert.match(agents.freeformTell.instructions, /hiddenPremises/);
  assert.match(agents.freeformTell.instructions, /НА САМОМ ДЕЛЕ/);
  assert.match(agents.freeformArchitectTell.instructions, /НА САМОМ ДЕЛЕ/);
  assert.match(agents.freeformEndings.instructions, /хотя бы по одной/);
  assert.equal(agents.freeformAssemble.model, 'gpt-5.6-luna');
  assert.deepEqual(agents.freeformAssemble.canon, ['chronicle', 'world']);
  assert.deepEqual(agents.freeformAssemble.styles, []);
  assert.match(agents.freeformAssemble.instructions, /submit_freeform_story/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /whyMoves/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /что ситуация сделает следующим/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /САНОВНИКИ НЕ ГЕРОИ|столпов не используй/i);
  assert.match(agents.freeformAssemble.instructions, /наблюдаемый слой/);
  assert.match(agents.freeformAssemble.instructions, /обозначить конфликт/);
  assert.match(agents.freeformAssemble.instructions, /не изменяй основы истории/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /hiddenPremises/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /На самом деле/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /claim_character/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /Не схлопывай цепочку/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /первая запись этой истории/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /depth|countdown|urgency|не ставь/i);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /title — короткое имя/);
  assert.equal(agents.freeformHiddenSplit.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformHiddenSplit.maxTokens, 1600);
  assert.deepEqual(agents.freeformHiddenSplit.canon, []);
  assert.match(agents.freeformHiddenSplit.instructions, /submit_hidden_layer/);
  assert.match(agents.freeformHiddenSplit.instructions, /разгадываемой тайны/);
  assert.match(agents.freeformHiddenSplit.instructions, /обнажает первопричину/);
  assert.match(agents.freeformHiddenSplit.instructions, /не вошедшие в хронику/);
  assert.match(agents.freeformHiddenSplit.instructions, /намекают на разгадку/);
  assert.doesNotMatch(agents.freeformHiddenSplit.instructions, /Не дописывай подступы/);
  assert.doesNotMatch(agents.freeformHiddenSplit.instructions, /cityBrief/);
  assert.equal(agents.freeformTitle.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformTitle.maxTokens, 400);
  assert.equal(agents.freeformTitle.reasoningEffort, undefined);
  assert.deepEqual(agents.freeformTitle.canon, []);
  assert.match(agents.freeformTitle.instructions, /завязк/);
  assert.match(agents.freeformTitle.instructions, /2-4 слова/);
  assert.match(agents.freeformTitle.instructions, /submit_freeform_title/);
  assert.equal(agents.freeformUrgency.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformUrgency.maxTokens, 400);
  assert.deepEqual(agents.freeformUrgency.canon, ['world']);
  assert.match(agents.freeformUrgency.instructions, /set_freeform_urgency/);
  assert.match(agents.freeformUrgency.instructions, /FAST/);
  assert.doesNotMatch(agents.freeformUrgency.instructions, /\bdepth\b/i);
  assert.equal(agents.freeformEndings.model, 'gpt-5.6-luna');
  assert.deepEqual(agents.freeformEndings.canon, ['world']);
  assert.match(agents.freeformEndings.instructions, /submit_freeform_endings/);
  assert.match(agents.freeformEndings.instructions, /GOOD_ENDING/);
  assert.match(agents.freeformEndings.instructions, /вопрос в городе больше не стоит/);
  assert.match(agents.freeformEndings.instructions, /соотносить масштаб последствий с уровнем GRAVITY/);
  assert.match(agents.freeformEndings.instructions, /questionGone/);
  assert.match(agents.freeformEndings.instructions, /nowDifferent/);
  assert.match(agents.freeformEndings.instructions, /к зиме/, 'горизонт последствий запрещён');
  assert.doesNotMatch(agents.freeformEndings.instructions, /cityBrief/);
  assert.equal(agents.freeformEndingsJudge.reasoningEffort, 'low', 'судья концовок дешёвый');
  assert.match(agents.freeformEndingsJudge.instructions, /submit_endings_review/);
  assert.match(agents.freeformEndingsJudge.instructions, /QUESTION_OPEN/);
  assert.match(agents.freeformEndingsJudge.instructions, /NOT_A_LOSS/);
  assert.equal(agents.freeformBeatJudge.model, 'gpt-5.6-luna');
  assert.match(agents.freeformBeatJudge.instructions, /submit_freeform_pack_review/);
  assert.match(agents.freeformAlign.instructions, /DIRECT/);
  assert.match(agents.freeformAlign.instructions, /endingId/);
});

test('gravity для архитектора — enum и расшифровка уровней', () => {
  const cfg = loadConfig();
  assert.deepEqual(FREEFORM_GRAVITY, ['SITUATION', 'EPISODE', 'CRISIS', 'RUPTURE']);
  assert.equal(parseFreeformGravity('crisis'), 'CRISIS');
  assert.equal(parseFreeformGravity(8), 'EPISODE');
  assert.equal(parseFreeformGravity(40), 'EPISODE');
  assert.equal(parseFreeformGravity(80), 'EPISODE');
  assert.equal(parseFreeformGravity('нет'), 'EPISODE');
  const rupture = formatFreeformGravityForPrompt('RUPTURE', cfg);
  assert.match(rupture, /GRAVITY: RUPTURE/);
  assert.doesNotMatch(rupture, /Судьбоносность/);
  assert.match(rupture, /Экзистенциальная угроза/);
  assert.match(rupture, /якоря/);
  assert.doesNotMatch(rupture, /SITUATION/);
  assert.doesNotMatch(rupture, /EPISODE/);
  assert.doesNotMatch(rupture, /изгородь|венок/);
  assert.match(rupture, /Война/);
  assert.doesNotMatch(rupture, /поле «последствия»|Динамика делает/);
  const episode = formatFreeformGravityForPrompt('EPISODE', cfg);
  assert.match(episode, /GRAVITY: EPISODE/);
  assert.doesNotMatch(episode, /RUPTURE/);
  assert.doesNotMatch(episode, /изгородь|венок/);
  assert.match(formatFreeformGravityForPrompt('SITUATION', cfg), /родов|гильдий|скандал/);
  assert.match(formatFreeformGravityForPrompt('CRISIS', cfg), /пожар|осада|Восстание/);
});

test('брейншторм пишет затравку по-русски', () => {
  const ins = loadConfig().agents.freeformBrainstorm.instructions;
  assert.match(ins, /по-русски/);
  assert.match(ins, /hiddenLayer/);
  assert.doesNotMatch(ins, /по-английски|На самом деле:/);
  assert.match(ins, /emit_freeform_candidates/);
});

test('затравка брейншторма — одна запись или несколько', () => {
  assert.equal(formatFreeformChronicleSeed([]), '');
  assert.equal(formatFreeformChronicleSeed('  сапог  '), 'сапог');
  assert.equal(formatFreeformChronicleSeed([{ text: 'На площади нашли сапог.' }]), 'На площади нашли сапог.');
  assert.equal(
    formatFreeformChronicleSeed([
      { text: 'Нашли сапог.', gameDateLabel: 'Год 1, месяц 2' },
      { text: 'Двор его держит.', gameDateLabel: 'Год 1, месяц 3' },
    ]),
    'Год 1, месяц 2 — Нашли сапог.\nГод 1, месяц 3 — Двор его держит.',
  );
});

test('пакет судьи карточки — абзац, gravity, без угрозы', () => {
  const text = formatFreeformCardJudgeCase({
    seedText: 'На площади нашли сапог.',
    blank: {
      hook: 'Сапог зовёт к створу.',
      conflict: 'Хозяин ищет гостя.',
      dynamics: 'Пока сапог на площади, двор держит чужака.',
      consequences: 'Площадь неделю спорит, чей это знак.',
      arena: 'HUMAN',
      worldRelation: 'NATIVE',
    },
    card: {
      title: 'Сапог',
      synopsis: 'Гость оставил сапог.',
      closeWhen: ['Найти', 'Бросить'],
      hiddenPremises: [],
      urgency: 40,
    },
    gravity: 'RUPTURE',
  });
  assert.match(text, /Сапог зовёт к створу/);
  assert.match(text, /последствия: Площадь неделю спорит/);
  assert.doesNotMatch(text, /whyMoves/);
  assert.match(text, /GRAVITY: RUPTURE/);
  assert.match(text, /HUMAN/);
  assert.match(text, /hiddenPremises: \[\]/);
  assert.doesNotMatch(text, /если не предотвратить/);
  const repair = formatFreeformCardJudgeRepair({
    verdict: 'FAIL',
    summary: 'нет шарнира',
    issues: [{ code: 'HINGE', location: 'synopsis', reason: 'по густоте судят о жильцах без механизма' }],
  });
  assert.match(repair, /HINGE/);
  assert.match(repair, /густоте/);
  assert.equal(formatFreeformCardJudgeRepair({ verdict: 'PASS', summary: 'ок' }), '');
});

test('завязка: у посева только разгадка, подступов к ней ещё нет', () => {
  const cfg = freeformConfig(loadConfig());
  const empty = normalizeSeedVariant(
    {
      title: 'Долг за камень',
      synopsis: 'Патроны спорят, платить ли каменотёсам сверх уговора.',
      closeWhen: ['Заплатить', 'Отказать'],
      urgency: 40,
    },
    cfg,
  );
  assert.equal(empty.hiddenAnswer, '');
  assert.deepEqual(empty.hiddenPremises, []);
  assert.equal(empty.urgency, undefined);
  const mystery = normalizeSeedVariant(
    {
      title: 'Долг за камень',
      synopsis: 'Патроны спорят, платить ли каменотёсам сверх уговора.',
      closeWhen: ['Заплатить', 'Отказать'],
      hiddenAnswer: 'Уговор подписан на выработку, которой в горе уже нет',
      hiddenPremises: ['Подступ, который посев придумывать не вправе'],
      urgency: 40,
    },
    cfg,
  );
  assert.equal(mystery.hiddenAnswer, 'Уговор подписан на выработку, которой в горе уже нет');
  assert.deepEqual(mystery.hiddenPremises, [], 'подступы город нащупывает делами, а не на посеве');
});

test('разгадку не рубит по букве: верхней границы у пункта нет', () => {
  const long = `${'Каменотёсы платят за проход через выработку, потому что '.repeat(9)}иначе им негде брать камень.`;
  assert.ok(long.length > 280);
  const [kept] = normalizeHiddenPremises([long]);
  assert.equal(kept, long);
  assert.ok(kept.endsWith('иначе им негде брать камень.'));
});

test('болванка архитектора — четыре поля без urgency', () => {
  const blank = normalizeSeedBlank(
    {
      hook: 'На площади нашли сапог.',
      conflict: 'Хозяин ищет гостя.',
      dynamics: 'Двор держит чужака, пока сапог лежит.',
      consequences: 'Площадь спорит, чей это знак.',
    },
    [
      { groupId: 'arena', tagName: 'HUMAN' },
      { groupId: 'worldRelation', tagName: 'NATIVE' },
    ],
  );
  assert.equal(blank.hook, 'На площади нашли сапог.');
  assert.equal(blank.conflict, 'Хозяин ищет гостя.');
  assert.equal(blank.dynamics, 'Двор держит чужака, пока сапог лежит.');
  assert.equal(blank.consequences, 'Площадь спорит, чей это знак.');
  assert.equal(blank.text, blank.hook);
  assert.equal(blank.urgency, undefined);
  assert.equal(blank.arena, 'HUMAN');
  assert.match(formatFreeformVariants([blank]), /затравка: На площади/);
  assert.match(formatFreeformVariants([blank]), /конфликт: Хозяин ищет/);
  assert.match(formatFreeformVariants([blank]), /последствия: Площадь спорит/);
  assert.equal(normalizeSeedBlank({ hook: 'только затравка' }), null);
  assert.equal(
    openStoryTitlesLine({
      plotlines: [
        { kind: 'story', status: 'open', title: 'Белый налёт' },
        { kind: 'errand', status: 'open', title: 'Поручение' },
      ],
    }),
    'Уже открытые истории (не продолжай и не делай близнеца): Белый налёт.',
  );
});

test('архитектор не видит бриф города, конструктор видит', async () => {
  const CITY_MARK = 'ЦИСТЕРНЫ_МАРКЕР';
  const seedText = 'На площади нашли чужой сапог.';
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Сапог зовёт в путь ${i}`));
  const calls = [];
  const runtime = {
    async run(opts) {
      calls.push({
        agentId: opts.agentId,
        extraSystem: String(opts.extraSystem || ''),
        user: String(opts.userMessages?.[0]?.content || ''),
        required: opts.tools?.[0]?.parameters?.required,
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 2, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        await tool.handler({
          title: 'Сапог на площади',
          synopsis: 'Гость оставил сапог и ушёл к створу.',
          entry: '',
          closeWhen: ['Найти хозяина 2', 'Бросить сапог'],
          cause: 'Гость ушёл к створу и не вернулся за своим сапогом.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({ verdict: 'PASS', summary: 'шарнир на месте', issues: [] });
      }
    },
  };
  const domain = {
    id: 'd1',
    name: 'Грасток',
    cityBrief: `${CITY_MARK} питают водосборы и колёса.`,
    stats: { prosperity: 10 },
    plotlines: [],
    lore: [],
  };
  const world = { tickIndex: 3, gameDate: { year: 1, month: 3 } };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain,
    world,
    seedText,
    gravity: 'RUPTURE',
  });
  assert.equal(started.ok, true);
  assert.equal(started.winner.title, 'Сапог на площади');
  assert.equal(started.winner.gravity, 'RUPTURE');
  assert.equal(started.winner.whyMoves, undefined);
  assert.equal(started.rejected.length, 2);
  assert.match(started.rejected[0].hook, /Сапог зовёт в путь 1/);
  assert.match(started.rejected[0].text, /конфликт: Конфликт сапога 1/);
  assert.ok(started.rejected[0].arena);
  assert.ok(started.rejected[0].worldRelation);
  assert.ok(started.winner.arena);
  assert.ok(started.winner.worldRelation);
  const architect = calls.find((c) => c.agentId === 'freeformArchitectStart');
  const judge = calls.find((c) => c.agentId === 'freeformJudge');
  const ctor = calls.find((c) => c.agentId === 'freeformStart');
  const cardJudge = calls.find((c) => c.agentId === 'freeformCardJudge');
  assert.ok(architect && judge && ctor && cardJudge);
  assert.match(cardJudge.extraSystem, new RegExp(CITY_MARK));
  assert.match(cardJudge.user, /GRAVITY: RUPTURE/);
  assert.equal(started.judge.card.verdict, 'PASS');
  assert.equal(architect.extraSystem, '');
  assert.doesNotMatch(architect.user, new RegExp(CITY_MARK));
  assert.match(architect.user, /1\. arena \w+ · worldRelation \w+ · target \w+ · knowledge \w+/);
  assert.match(architect.user, /^arena — /m);
  assert.match(architect.user, /^HUMAN — /m);
  assert.match(architect.user, /^worldRelation — /m);
  assert.match(architect.user, /^NATIVE — /m);
  assert.equal((architect.user.match(/^\d+\. /gm) || []).length, 3);
  assert.match(architect.user, /четыре поля/);
  assert.match(architect.user, /Gravity — посадка/);
  assert.match(architect.user, /ассоциативн/);
  assert.match(judge.extraSystem, new RegExp(CITY_MARK));
  assert.match(ctor.extraSystem, new RegExp(CITY_MARK));
  assert.match(ctor.user, /Сапог зовёт в путь 2/);
  assert.match(started.winner.hook, /Сапог зовёт в путь 2/);
  assert.match(started.winner.consequences, /Последствия сапога 2/);
  assert.match(architect.user, /GRAVITY: RUPTURE/);
  assert.match(architect.user, /Экзистенциальная угроза/);
  assert.doesNotMatch(architect.user, /SITUATION/);
  assert.doesNotMatch(architect.user, /EPISODE/);
  assert.doesNotMatch(architect.user, /изгородь|венок|помолвк/);
  assert.match(judge.user, /GRAVITY: RUPTURE/);
  assert.doesNotMatch(ctor.user, /whyMoves/);
  assert.ok(!ctor.required.includes('urgency'));
  assert.ok(!ctor.required.includes('whyMoves'));
  assert.match(ctor.user, /Urgency не ставь/);
  assert.equal(started.winner.urgency, undefined);
  assert.match(judge.user, /чужой остров/);
  assert.doesNotMatch(ctor.user, /urgency: /);
  assert.match(started.architectPrompt, /На площади нашли чужой сапог/);
  assert.match(started.architectPrompt, /GRAVITY: RUPTURE/);
});

test('FAIL судьи карточки — одна доработка конструктора', async () => {
  let startCalls = 0;
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Горький корень гуще у стены ${i}.`));
  const runtime = {
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 1, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        startCalls += 1;
        const user = String(opts.userMessages?.[0]?.content || '');
        if (startCalls === 2) {
          assert.match(user, /HINGE/);
          assert.match(user, /густоте/);
        }
        await tool.handler({
          title: startCalls === 1 ? 'Корень' : 'Корень у стены',
          synopsis:
            startCalls === 1
              ? 'Горький корень гуще, значит есть неучтённые жильцы.'
              : 'Горький корень гуще у стены, потому что там течёт скрытый сток, и по густоте судят о числе жильцов.',
          closeWhen: ['Признать жильцов', 'Срезать корень'],
          cause: 'Под стеной течёт неучтённый сток, и корень кормится им.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({
          verdict: 'FAIL',
          summary: 'нет шарнира',
          issues: [{ code: 'HINGE', location: 'synopsis', reason: 'по густоте судят о жильцах без механизма' }],
        });
      }
    },
  };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', cityBrief: 'двор', plotlines: [], lore: [] },
    world: { tickIndex: 3, gameDate: { year: 1, month: 3 } },
    seedText: 'У стены гуще горький корень.',
    gravity: 'EPISODE',
  });
  assert.equal(started.ok, true);
  assert.equal(startCalls, 2);
  assert.equal(started.winner.title, 'Корень у стены');
  assert.equal(started.judge.card.verdict, 'FAIL');
  assert.equal(started.judge.card.repaired, true);
  assert.match(started.judge.card.issues[0].code, /HINGE/);
});

test('UNCERTAIN судьи карточки не гоняет конструктора на починку', async () => {
  let startCalls = 0;
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Сапог ${i}`));
  const runtime = {
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 1, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        startCalls += 1;
        await tool.handler({
          title: 'Сапог',
          synopsis: 'Гость оставил сапог.',
          closeWhen: ['Найти', 'Бросить'],
          cause: 'Гость ушёл к створу и не вернулся за сапогом.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({ verdict: 'UNCERTAIN', summary: 'неясно', issues: [] });
      }
    },
  };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', cityBrief: 'двор', plotlines: [], lore: [] },
    world: { tickIndex: 3, gameDate: { year: 1, month: 3 } },
    seedText: 'На площади нашли сапог.',
  });
  assert.equal(started.ok, true);
  assert.equal(startCalls, 1);
  assert.equal(started.judge.card.verdict, 'UNCERTAIN');
  assert.equal(started.judge.card.repaired, false);
});

test('продолжение: архитектор без города, конструктор с городом', async () => {
  const CITY_MARK = 'ЦИСТЕРНЫ_МАРКЕР';
  const blanks = [1, 2, 3].map((i) => ({
    text: `Гость показал второй сапог ${i}`,
  }));
  const calls = [];
  const runtime = {
    async run(opts) {
      calls.push({
        agentId: opts.agentId,
        extraSystem: String(opts.extraSystem || ''),
        user: String(opts.userMessages?.[0]?.content || ''),
        tool: opts.tools?.[0]?.name,
        toolProps: Object.keys(opts.tools?.[0]?.parameters?.properties?.variants?.items?.properties || {}),
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      await handleBeatPipeline(opts, {
        blanks,
        construct: {
          chronicle: 'Гость показал второй сапог у створа.',
          synopsis: 'Хозяин двора держит гостя у створа.',
        },
      });
    },
  };
  const plot = createPlotline({
    title: 'Чужой сапог',
    kind: 'story',
    storyType: 'story',
    closeWhen: ['Найти хозяина', 'Выбросить сапог'],
    synopsis: 'На площади нашли сапог.',
    urgency: 40,
    gravity: 'EPISODE',
  });
  const domain = {
    id: 'd1',
    name: 'Грасток',
    cityBrief: `${CITY_MARK} питают водосборы.`,
    plotlines: [plot],
    lore: [],
  };
  const told = await tellFreeformBeat({
    config: loadConfig(),
    runtime,
    domain,
    world: { tickIndex: 4, gameDate: { year: 1, month: 4 } },
    plot,
    deed: { summary: 'Искали хозяина сапога', detail: '', durationMonths: 1, finish: 'ok' },
    rng: () => 0,
  });
  assert.equal(told.ok, true);
  assert.match(told.winner.chronicle, /створа/);
  assert.equal(told.rejected[0].text, 'Гость показал второй сапог 2');
  assert.equal(told.pickedIndex, 1);
  assert.ok(told.variants[0].dynamicName);
  assert.match(told.variants[0].dynamicId, /PLOT_TWIST|POLARIZATION|DEADLOCK|COMPLICATION|REVERSAL|REVELATION|BREAKTHROUGH/);
  const architect = calls.find((c) => c.agentId === 'freeformArchitectTell');
  const ctor = calls.find((c) => c.agentId === 'freeformTell');
  assert.equal(architect.extraSystem, '');
  assert.equal(architect.tool, 'submit_freeform_beat_blanks');
  assert.deepEqual(architect.toolProps, ['text']);
  assert.doesNotMatch(architect.user, new RegExp(CITY_MARK));
  assert.doesNotMatch(architect.user, /threatArena/);
  assert.match(architect.user, /История «Чужой сапог»/);
  assert.match(architect.user, /Способы сдвига/);
  assert.match(architect.user, /Поворот|Поляризация|Тупик|Осложнение|Разворот|Прояснение|Прорыв/);
  assert.match(architect.user, /Поступок: Искали хозяина сапога/);
  assert.doesNotMatch(architect.user, /История кончится/);
  assert.doesNotMatch(architect.user, /closeWhen|whatHappens|situationNow|whyMoves:|hiddenPremises|urgency|countdown|ДИНАМИКИ|ХОДА|архитектор|глубина|maxDepth|\bdepth\b/);
  assert.doesNotMatch(architect.user, /Истощение|Накопление|Каскад|depletion|cascade/i);
  assert.match(ctor.extraSystem, new RegExp(CITY_MARK));
  assert.match(ctor.extraSystem, /глубина 1\/3/);
  assert.match(ctor.user, /пересказ сюжета/);
  assert.match(ctor.user, /нумерованн/);
  assert.deepEqual(
    calls.map((c) => c.agentId),
    [
      'freeformArchitectTell',
      'freeformBeatJudge',
      'freeformTell',
      'freeformEndings',
      'freeformEndingsJudge',
      'freeformUrgency',
    ],
  );
});

test('жребий динамики хода — полярность good/bad, без SETTLEMENT', () => {
  const cfg = loadConfig();
  const legal = listLegalBeatDynamics(cfg);
  const ids = legal.map((d) => d.id);
  assert.equal(ids.includes('SETTLEMENT'), false);
  assert.ok(ids.includes('PLOT_TWIST'));
  assert.ok(ids.includes('POLARIZATION'));
  assert.ok(ids.includes('DEADLOCK'));
  assert.equal(ids.includes('DEPLETION'), false);
  assert.equal(ids.includes('CASCADE'), false);
  const good = listLegalBeatDynamics(cfg, null, { polarity: 'good' }).map((d) => d.id);
  assert.equal(good.includes('DEADLOCK'), false);
  assert.equal(good.includes('COMPLICATION'), false);
  assert.ok(good.includes('PLOT_TWIST'));
  const bad = listLegalBeatDynamics(cfg, null, { polarity: 'bad' }).map((d) => d.id);
  assert.ok(bad.includes('DEADLOCK'));
  assert.ok(bad.includes('COMPLICATION'));
  const picked = pickFreeformBeatDynamics(cfg, 3, () => 0, null, { polarity: 'good' });
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((d) => d.id)).size, 3);
  assert.equal(picked[0].id, 'PLOT_TWIST');
  const formatted = formatBeatDynamicsForPrompt(picked);
  assert.match(formatted, /Способы сдвига/);
  assert.match(formatted, /Поворот/);
  assert.doesNotMatch(formatted, /SETTLEMENT|PLOT_TWIST|ДИНАМИКИ/);
});

test('ход тоже получает брошенного автора, и пул у него общий с завязками', () => {
  const cfg = loadConfig();
  const pool = freeformConfig(cfg).continuationAuthors;
  const first = pickContinuationAuthor(cfg, () => 0);
  const last = pickContinuationAuthor(cfg, () => 0.999999);
  assert.equal(first.id, pool[0].id);
  assert.equal(last.id, pool[pool.length - 1].id);

  const text = formatContinuationAuthorForPrompt(first);
  assert.match(text, new RegExp(first.name));
  assert.match(text, /нарративную эстетику/);
  // Бросок настраивает руку, а не тянет в текст чужой мир.
  assert.match(text, /Мир, имена, ремёсла и время остаются здешние/);
  assert.equal(formatContinuationAuthorForPrompt(null), '');

  assert.match(cfg.agents.freeformArchitectTell.instructions, /брошен известный автор/);
  assert.match(cfg.agents.freeformArchitectTell.instructions, /ничего в сюжете не решает/);
});

test('лабораторный undo снимает последний снимок', () => {
  const base = { mode: 'idle', lastChronicle: '', undoStack: [] };
  const afterSeed = { mode: 'story', lastChronicle: 'сапог', plotId: 'p1' };
  pushUndo(afterSeed, snapshotForUndo(base));
  assert.equal(afterSeed.undoStack.length, 1);
  const restored = popUndo(afterSeed);
  assert.equal(restored.mode, 'idle');
  assert.equal(restored.undoStack.length, 0);
  assert.equal(popUndo(restored), null);
});

test('автотик: архитектор без дела, с динамиками', async () => {
  const blanks = [1, 2, 3].map((i) => ({
    text: `Сапог сам сдвинулся ${i}`,
  }));
  const calls = [];
  const runtime = {
    async run(opts) {
      calls.push({
        agentId: opts.agentId,
        user: String(opts.userMessages?.[0]?.content || ''),
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      await handleBeatPipeline(opts, {
        blanks,
        construct: {
          chronicle: 'Сапог сам сдвинулся у створа.',
          synopsis: 'Площадь держит тишину у створа.',
        },
      });
    },
  };
  const plot = createPlotline({
    title: 'Чужой сапог',
    kind: 'story',
    storyType: 'story',
    closeWhen: ['Найти хозяина'],
    synopsis: 'На площади нашли сапог.',
  });
  const told = await tellFreeformBeat({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', plotlines: [plot], lore: [] },
    world: { tickIndex: 4, gameDate: { year: 1, month: 4 } },
    plot,
    trigger: 'auto',
    rng: () => 0.5,
  });
  assert.equal(told.ok, true);
  assert.equal(told.pickedIndex, 2);
  const architect = calls.find((c) => c.agentId === 'freeformArchitectTell');
  assert.match(architect.user, /не занимались/);
  assert.doesNotMatch(architect.user, /клонилась к тому|whyMoves|Дело:|Поступок:/);
  assert.match(architect.user, /Способы сдвига/);
});

test('urgency enum, провалы и решение хода', () => {
  assert.equal(parseFreeformUrgency(70), 'FAST');
  assert.equal(parseFreeformUrgency(30), 'SLOW');
  assert.equal(parseFreeformUrgency('medium'), 'MEDIUM');
  assert.equal(rollFreeformCountdown('FAST', () => 0), 1);
  assert.equal(rollFreeformCountdown('FAST', () => 0.99), 2);
  assert.equal(rollFreeformCountdown('MEDIUM', () => 0), 2);
  assert.equal(rollFreeformCountdown('SLOW', () => 0.99), 8);
  assert.equal(maxFailsForGravity('SITUATION'), 0);
  assert.equal(maxFailsForGravity('EPISODE'), 1);
  assert.equal(maxFailsForGravity('CRISIS'), 2);
  assert.equal(maxFailsForGravity('RUPTURE'), 3);

  const plot = createPlotline({
    title: 'Сапог',
    kind: 'story',
    storyType: 'story',
    gravity: 'EPISODE',
    maxDepth: 3,
    endings: LAB_ENDINGS,
  });
  assert.equal(plot.depth, 0);
  applyFreeformProgress(plot, { finish: 'ok' });
  assert.equal(plot.depth, 1);
  assert.equal(plot.failCount, 0);
  assert.equal(freeformTickDecision(plot, { relation: 'RELATED', finish: 'ok' }).kind, 'continue');
  assert.equal(freeformTickDecision(plot, { relation: 'DIRECT', finish: 'ok', endingId: 'g' }).kind, 'continue');

  plot.depth = 3;
  assert.equal(
    freeformTickDecision(plot, { relation: 'DIRECT', finish: 'ok', endingId: 'g' }).kind,
    'closeDirect',
  );
  assert.equal(freeformTickDecision(plot, { relation: 'RELATED', finish: 'ok' }).kind, 'continue');

  applyFreeformProgress(plot, { finish: 'fail' });
  assert.equal(plot.failCount, 1);
  assert.equal(freeformTickDecision(plot, { finish: 'fail' }).kind, 'continue');
  applyFreeformProgress(plot, { finish: 'fail' });
  assert.equal(plot.failCount, 2);
  assert.equal(freeformTickDecision(plot, { finish: 'fail' }).kind, 'closeBad');
  applyFreeformProgress(plot, { finish: 'crit' });
  assert.equal(plot.failCount, 1);

  const sit = createPlotline({
    title: 'Мелочь',
    kind: 'story',
    storyType: 'story',
    gravity: 'SITUATION',
  });
  applyFreeformProgress(sit, { autotick: true });
  assert.equal(sit.failCount, 1);
  assert.equal(freeformTickDecision(sit, { autotick: true }).kind, 'closeBad');
});

test('автотик/провал: тип концовки по отношению успехов к глубине', () => {
  assert.equal(autotickCloseKind({ maxDepth: 3, failCount: 3 }), 'BAD_ENDING');
  assert.equal(autotickCloseKind({ maxDepth: 3, failCount: 0 }), 'NEUTRAL_ENDING');
  const tones = new Set();
  for (let i = 0; i < 40; i += 1) {
    tones.add(autotickCloseKind({ maxDepth: 3, failCount: 2 }, () => i / 40));
  }
  assert.ok(tones.has('NEUTRAL_ENDING'));
  assert.ok(tones.has('BAD_ENDING'));
});

test('DIRECT успех на maxDepth являет связанную концовку и закрывает', async () => {
  const calls = [];
  const runtime = {
    async run(opts) {
      calls.push(opts.agentId);
      await handleBeatPipeline(opts, {
        blanks: [{ text: 'Хозяин взял сапог и двор выдохнул.' }],
        construct: {
          chronicle: 'Хозяин взял сапог у створа.',
          synopsis: 'Сапог вернулся, двор спокоен.',
        },
        n: 1,
      });
    },
  };
  const plot = createPlotline({
    title: 'Чужой сапог',
    kind: 'story',
    storyType: 'story',
    gravity: 'EPISODE',
    maxDepth: 2,
    depth: 1,
    endings: LAB_ENDINGS,
    synopsis: 'На площади нашли сапог.',
  });
  const told = await tellFreeformBeat({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', plotlines: [plot], lore: [] },
    world: { tickIndex: 4, gameDate: { year: 1, month: 4 } },
    plot,
    deed: { summary: 'Вернули сапог хозяину', durationMonths: 1, finish: 'ok' },
    relation: 'DIRECT',
    endingId: 'g',
    rng: () => 0,
  });
  assert.equal(told.ok, true);
  assert.equal(told.decision.kind, 'closeDirect');
  assert.equal(told.winner.closed, true);
  assert.match(told.winner.closedBy, /Хозяин найден/);
  assert.equal(plot.depth, 2);
  assert.equal(calls.includes('freeformBeatJudge'), false);
  assert.equal(calls.includes('freeformEndings'), false);
  assert.equal(calls.includes('freeformUrgency'), false);
  assert.match(calls.join(','), /freeformArchitectTell/);
  assert.match(calls.join(','), /freeformTell/);
});

test('RELATED на maxDepth не закрывает, провал DIRECT даёт closeBad при переполнении', () => {
  const plot = createPlotline({
    title: 'Сапог',
    kind: 'story',
    storyType: 'story',
    gravity: 'SITUATION',
    maxDepth: 1,
    endings: LAB_ENDINGS,
  });
  applyFreeformProgress(plot, { finish: 'ok' });
  assert.equal(
    freeformTickDecision(plot, { relation: 'RELATED', finish: 'ok' }).kind,
    'continue',
  );
  assert.equal(
    freeformTickDecision(plot, { relation: 'DIRECT', finish: 'ok', endingId: 'g' }).kind,
    'closeDirect',
  );
  applyFreeformProgress(plot, { finish: 'fail' });
  assert.equal(
    freeformTickDecision(plot, { relation: 'DIRECT', finish: 'fail', endingId: 'g' }).kind,
    'closeBad',
  );
});

test('жребий завязки — четыре оси мира из каталога конфига', () => {
  const cfg = loadConfig();
  const tags = pickFreeformSeedAxes(cfg, () => 0);
  assert.deepEqual(
    tags.map((t) => t.groupId),
    ['arena', 'worldRelation', 'target', 'knowledge'],
  );
  assert.deepEqual(
    tags.map((t) => t.tagId),
    ['human', 'native', 'food', 'open'],
  );
  assert.match(tags[0].about, /поступке|решении/);

  const setsText = formatFreeformSeedAxisSetsForPrompt([tags], cfg);
  assert.match(
    setsText,
    /1\. arena HUMAN · worldRelation NATIVE · target FOOD · knowledge OPEN/,
  );
  assert.doesNotMatch(setsText, /\bengine\b|\btiming\b/);
  assert.match(setsText, /четыре поля/);
  assert.match(setsText, /ассоциативн/);

  const catalogs = formatFreeformAxisCatalogs(cfg);
  for (const axis of ['arena', 'worldRelation', 'target', 'knowledge']) {
    assert.match(catalogs, new RegExp(`^${axis} — `, 'm'));
  }
  assert.doesNotMatch(catalogs, /^engine — /m);
  assert.doesNotMatch(catalogs, /^timing — /m);
  assert.match(catalogs, /^PHENOMENON — /m);
  assert.match(catalogs, /^SURFACED — /m);
  assert.match(catalogs, /^RITE — /m);
  assert.match(catalogs, /^FALSE_BELIEF — /m);
  assert.doesNotMatch(catalogs, /CYCLICAL_PATTERN|PRICE_OF_SUCCESS|DID_NOT_HAPPEN/);
  assert.doesNotMatch(catalogs, /FREE|вайлдкард|CONTACT|^BUILT|^EARTH/im);
  assert.doesNotMatch(catalogs, /EXTERNAL_THREAT|DELAYED_CONSEQUENCE|SUPERNATURAL_ANOMALY/);

  const sets = pickFreeformSeedAxisSets(cfg, 4, () => 0);
  assert.equal(sets.length, 4);
  for (const axis of ['arena', 'worldRelation', 'target', 'knowledge']) {
    const drawn = sets.map((s) => s.find((t) => t.groupId === axis).tagId);
    assert.equal(new Set(drawn).size, 4, `${axis} повторился в пачке`);
  }
});

test('жребий брейншторма — четыре оси без повторов, без engine и timing', () => {
  const cfg = loadConfig();
  const zero = pickFreeformBrainstormRolls(cfg, 3, () => 0);
  assert.equal(zero.length, 3);
  assert.deepEqual(
    zero[0].axes.map((t) => t.groupId),
    ['arena', 'worldRelation', 'target', 'knowledge'],
  );
  assert.deepEqual(
    zero[0].axes.map((t) => t.tagId),
    ['human', 'native', 'food', 'open'],
  );
  assert.equal(new Set(zero.map((r) => r.author.id)).size, 3);
  assert.equal(zero[0].author.name, 'Эдгар Аллан По');
  for (let i = 0; i < 20; i += 1) {
    const rolls = pickFreeformBrainstormRolls(cfg, 3);
    assert.equal(new Set(rolls.map((r) => r.author.id)).size, 3);
    for (const axis of ['arena', 'worldRelation', 'target', 'knowledge']) {
      const drawn = rolls.map((r) => r.axes.find((t) => t.groupId === axis).tagId);
      assert.equal(new Set(drawn).size, 3, `${axis} повторился в пачке`);
    }
    assert.equal(rolls[0].axes.some((t) => t.groupId === 'engine' || t.groupId === 'timing'), false);
  }

  const text = formatFreeformBrainstormRollsForPrompt(zero);
  assert.match(
    text,
    /1\. arena HUMAN · worldRelation NATIVE · target FOOD · knowledge OPEN · автор Эдгар Аллан По/,
  );
  assert.doesNotMatch(text, /\bengine\b|\btiming\b/);
  assert.doesNotMatch(text, /conflictSource|temporalShape/);
  assert.doesNotMatch(text, /не канцелярия|ассоциативн|кликбейт|ориентир|четыре поля/);

  const blank = normalizeBrainstormCandidate(
    {
      chronicle: 'На площади нашли сапог, и двор спорит, чей это знак.',
      arena: 'CREATURE',
      engine: 'MORAL_DILEMMA',
      timing: 'BLOW',
    },
    zero[0],
    1,
  );
  assert.equal(blank.chronicle, 'На площади нашли сапог, и двор спорит, чей это знак.');
  assert.equal(blank.hook, blank.chronicle);
  assert.equal(blank.text, blank.chronicle);
  assert.equal(blank.conflict, undefined);
  assert.equal(blank.arena, 'HUMAN');
  assert.equal(blank.worldRelation, 'NATIVE');
  assert.equal(blank.target, 'FOOD');
  assert.equal(blank.knowledge, 'OPEN');
  assert.equal(blank.engine, undefined);
  assert.equal(blank.timing, undefined);
  assert.equal(blank.authorName, 'Эдгар Аллан По');
  assert.equal(blank.index, 1);
  assert.equal(blank.hiddenLayer, '');
  const withField = normalizeBrainstormCandidate(
    { chronicle: 'Yard holds a boot.', hiddenLayer: 'Salt leaks from the rim.' },
    zero[0],
    1,
  );
  assert.equal(withField.chronicle, 'Yard holds a boot.');
  assert.equal(withField.hiddenLayer, 'Salt leaks from the rim.');
  assert.equal(withField.text, withField.chronicle);
  const withMarker = normalizeBrainstormCandidate(
    { chronicle: 'Yard holds a boot.\nНа самом деле: Salt leaks from the rim.' },
    zero[0],
    1,
  );
  assert.equal(withMarker.chronicle, 'Yard holds a boot.');
  assert.match(withMarker.hiddenLayer, /Salt leaks from the rim/);
  assert.doesNotMatch(withMarker.chronicle, /На самом деле|Salt leaks/);
  assert.equal(normalizeBrainstormCandidate({ hook: 'Сапог на площади.' }, zero[0], 2).chronicle, 'Сапог на площади.');
  assert.equal(normalizeBrainstormCandidate({}, zero[0], 1), null);
  const longHook = `${'А'.repeat(50)} сцена.`;
  assert.ok(normalizeBrainstormCandidate({ hook: longHook }, zero[0], 3, 20).chronicle.length <= 21);

  const shown = formatBrainstormCandidateForPrompt(blank, 1);
  assert.match(shown, /оси: HUMAN · NATIVE · FOOD · OPEN/);
  assert.doesNotMatch(shown, /REFUSAL|FRESH_INCIDENT/);
  assert.match(shown, /Описание истории: На площади нашли сапог/);
  assert.doesNotMatch(shown, /конфликт:|динамика:|последствия:|автор:/);
  assert.doesNotMatch(shown, /hiddenLayer/);
  assert.match(formatBrainstormCandidateForPrompt(withField, 1), /hiddenLayer: Salt leaks from the rim/);
  assert.match(formatBrainstormCandidateForPrompt(blank, 1, { includeAuthor: true }), /автор: Эдгар Аллан По/);

  const again = normalizeBrainstormCandidate(
    { chronicle: 'Тот же двор, тот же сапог.', engine: 'MORAL_DILEMMA', timing: 'BLOW' },
    rollFromBrainstormCandidate(blank),
    1,
  );
  assert.equal(again.engine, undefined);
  assert.equal(again.timing, undefined);
  assert.equal(again.target, 'FOOD');
});

test('брейншторм принимает candidates, сериализованные JSON-строкой', async () => {
  assert.equal(parseEmitCandidateList([{ chronicle: 'a' }]).length, 1);
  assert.equal(parseEmitCandidateList(JSON.stringify([{ chronicle: 'a' }, { chronicle: 'b' }])).length, 2);
  assert.equal(
    parseEmitCandidateList(JSON.stringify(JSON.stringify([{ chronicle: 'a' }]))).length,
    1,
  );
  assert.deepEqual(parseEmitCandidateList('not json'), []);
  assert.deepEqual(parseEmitCandidateList({ chronicle: 'a' }), []);

  const real = new AgentRuntime(loadConfig());
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      const tool = opts.tools?.[0];
      if (opts.agentId !== 'freeformBrainstorm' || !tool) return;
      await tool.handler({
        candidates: JSON.stringify(
          [1, 2, 3].map((i) => ({
            chronicle: `Хроника сапога ${i}`,
            hiddenLayer: `тайна ${i}`,
          })),
        ),
      });
    },
  };
  const drafted = await brainstormFreeformSeeds({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'CRISIS',
  });
  assert.equal(drafted.ok, true);
  assert.equal(drafted.candidates.length, 3);
  assert.match(drafted.candidates[0].chronicle, /Хроника сапога 1/);
  assert.equal(drafted.candidates[1].hiddenLayer, 'тайна 2');
});

test('брейншторм не видит город, не зовёт судью и конструктора, оси берёт из броска', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (opts.agentId !== 'freeformBrainstorm' || !tool) return;
      await tool.handler({
        candidates: [1, 2, 3].map((i) => ({
          chronicle: `Хроника сапога ${i}`,
        })),
      });
    },
  };
  const drafted = await brainstormFreeformSeeds({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
  });
  assert.equal(drafted.ok, true);
  assert.equal(drafted.gravity, 'RUPTURE');
  assert.equal(drafted.candidates.length, 3);
  assert.deepEqual(calls, ['freeformBrainstorm']);
  drafted.candidates.forEach((c, i) => {
    const axes = drafted.rolls[i].axes;
    assert.equal(c.arena, axes.find((t) => t.groupId === 'arena').tagName);
    assert.equal(c.worldRelation, axes.find((t) => t.groupId === 'worldRelation').tagName);
    assert.equal(c.target, axes.find((t) => t.groupId === 'target').tagName);
    assert.equal(c.knowledge, axes.find((t) => t.groupId === 'knowledge').tagName);
    assert.equal(c.engine, undefined);
    assert.equal(c.timing, undefined);
    assert.equal(c.authorName, drafted.rolls[i].author.name);
    assert.equal(c.chronicle, `Хроника сапога ${i + 1}`);
    assert.equal(c.hook, c.chronicle);
  });
  assert.match(drafted.prompt, /=== SYSTEM ===/);
  assert.match(drafted.prompt, /=== USER ===/);
  assert.match(drafted.prompt, /=== TOOLS ===/);
  assert.match(drafted.prompt, /ТЕБЕ ДАНО|затравк/);
  assert.match(drafted.prompt, /ЗАТРАВКА/);
  assert.match(drafted.prompt, /автор Эдгар|автор /);
  assert.match(drafted.prompt, /На площади нашли чужой сапог/);
  assert.match(drafted.prompt, /GRAVITY: RUPTURE/);
  assert.match(drafted.prompt, /Судьбоносность/);
  assert.match(drafted.prompt, /Война/);
  assert.match(drafted.prompt, /emit_freeform_candidates/);
  assert.doesNotMatch(drafted.prompt, /^engine — /m);
  assert.doesNotMatch(drafted.prompt, /^timing — /m);
  const user = String(drafted.prompt.split('=== USER ===')[1] || '').split('=== TOOLS ===')[0];
  assert.match(user, /GRAVITY: RUPTURE/);
  assert.match(user, /ЗАТРАВКА/);
  assert.match(user, /ОСИ/);
  assert.match(user, /^arena — /m);
  assert.match(user, /^knowledge — /m);
  assert.doesNotMatch(user, /^engine — /m);
  assert.doesNotMatch(user, /^timing — /m);
  assert.match(user, /^НАБОРЫ$/m);
  assert.match(user, /^1\. arena \w+ · worldRelation \w+ · target \w+ · knowledge \w+ · автор /m);
  assert.doesNotMatch(user, /\bengine\b|\btiming\b/);
  assert.match(user, /На площади нашли чужой сапог/);
  assert.doesNotMatch(user, /не канцелярия|ассоциативн|кликбейт|Верни ровно|emit_freeform_candidates/);
  assert.doesNotMatch(user, /Судьбоносность/);
  assert.doesNotMatch(drafted.prompt, /ЦИСТЕРНЫ/);
  assert.doesNotMatch(drafted.prompt, /ХРОНИКА/);
  assert.doesNotMatch(drafted.prompt, /агент брейншторма/);
  assert.doesNotMatch(drafted.prompt, /судья|конструктор|позже подставит/);
  assert.doesNotMatch(drafted.prompt, /ОБЯЗАТЕЛЬНАЯ ТАЙНА|MYSTERY_PLAUSIBLE/);
  assert.doesNotMatch(drafted.prompt, /НЕТ ЗАТРАВКИ|абстрактный город-государство/);
  const packed = real.assembleChat({
    agentId: 'freeformBrainstorm',
    extraSystem: '',
    userMessages: [{ role: 'user', content: 'хроника' }],
  });
  assert.doesNotMatch(packed.systemContent, /cityBrief/i);
  assert.match(packed.systemContent, /Судьбоносность|нарративн/);
});

test('судья пачки разбирает отзыв по всем трём и не требует победителя', () => {
  const reviews = parseFreeformPackReview(
    {
      reviews: [
        { index: 2, verdict: 'fail', summary: 'посадка мельче', repair: 'подними последствия', issues: [{ code: 'gravity', reason: 'это эпизод, не разрыв' }] },
        { index: 1, verdict: 'PASS', summary: 'ок' },
      ],
    },
    3,
  );
  assert.equal(reviews.length, 3);
  assert.equal(reviews[0].verdict, 'PASS');
  assert.equal(reviews[0].repair, '');
  assert.equal(reviews[1].verdict, 'FAIL');
  assert.equal(reviews[1].issues[0].code, 'GRAVITY');
  assert.equal(reviews[2].verdict, 'PASS');
  assert.ok(FREEFORM_PACK_JUDGE_CODES.includes('BUREAUCRACY_PORN'));
  assert.equal(FREEFORM_PACK_JUDGE_CODES.includes('ENGINEERING_PORN'), false);
  assert.ok(FREEFORM_PACK_JUDGE_CODES.includes('WATER_SYSTEMS_PORN'));
  assert.equal(FREEFORM_PACK_JUDGE_CODES.includes('FORECAST'), false);
  assert.equal(FREEFORM_PACK_JUDGE_CODES.includes('OTHER'), false);
  assert.equal(FREEFORM_PACK_JUDGE_CODES.includes('HIDDEN'), false);
  assert.ok(FREEFORM_PACK_JUDGE_CODES.includes('AXIS'));
  assert.ok(FREEFORM_PACK_JUDGE_CODES.includes('CANONICAL_UNKNOWNS'));
  assert.ok(FREEFORM_PACK_JUDGE_CODES.includes('MYSTERY'));
  assert.ok(FREEFORM_PACK_JUDGE_CODES.includes('MYSTERY_PLAUSIBLE'));
  const dropped = parseFreeformPackReview(
    {
      reviews: [
        { index: 1, verdict: 'FAIL', issues: [{ code: 'HIDDEN', reason: 'дыра в скрытом' }] },
        { index: 2, verdict: 'UNCERTAIN', summary: 'неясно' },
        { index: 3, verdict: 'FAIL', issues: [{ code: 'CANONICAL_UNKNOWNS', reason: 'закрыл канон' }] },
      ],
    },
    3,
  );
  assert.equal(dropped[0].verdict, 'PASS');
  assert.equal(dropped[0].issues.length, 0);
  assert.equal(dropped[1].verdict, 'PASS');
  assert.equal(dropped[2].verdict, 'FAIL');
  assert.equal(dropped[2].issues[0].code, 'CANONICAL_UNKNOWNS');
  const mysteryReview = parseFreeformPackReview(
    {
      reviews: [
        { index: 1, verdict: 'FAIL', issues: [{ code: 'mystery', reason: 'нет странности' }] },
        { index: 2, verdict: 'FAIL', issues: [{ code: 'MYSTERY_PLAUSIBLE', reason: 'разгадка скучная' }] },
        { index: 3, verdict: 'FAIL', issues: [{ code: 'engineering', reason: 'сюжет держится на желобах' }] },
      ],
    },
    3,
  );
  assert.equal(mysteryReview[0].issues[0].code, 'MYSTERY');
  assert.equal(mysteryReview[1].issues[0].code, 'MYSTERY_PLAUSIBLE');
  assert.equal(mysteryReview[2].verdict, 'PASS');
  assert.equal(mysteryReview[2].issues.length, 0);
});

test('судья пачки сохраняет исходные номера при частичном наборе', () => {
  const reviews = parseFreeformPackReview(
    {
      reviews: [
        { index: 3, verdict: 'PASS', summary: 'ок' },
        { index: 1, verdict: 'FAIL', repair: 'чини', issues: [{ code: 'gravity', reason: 'мелко' }] },
      ],
    },
    2,
    [1, 3],
  );
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].index, 1);
  assert.equal(reviews[0].verdict, 'FAIL');
  assert.equal(reviews[1].index, 3);
  assert.equal(reviews[1].verdict, 'PASS');
});

test('пересечение судей оставляет только общие коды', () => {
  const merged = intersectPackReviews(
    [
      {
        index: 1,
        verdict: 'FAIL',
        issues: [
          { code: 'COSMOLOGY', reason: 'закон' },
          { code: 'MOTION', reason: 'стоит' },
        ],
      },
      { index: 2, verdict: 'FAIL', issues: [{ code: 'GRAVITY', reason: 'мелко' }] },
    ],
    [
      {
        index: 1,
        verdict: 'FAIL',
        issues: [
          { code: 'COSMOLOGY', reason: 'канон' },
          { code: 'PATRON', reason: 'жрец' },
        ],
      },
      { index: 2, verdict: 'PASS', issues: [] },
    ],
  );
  assert.equal(merged[0].verdict, 'FAIL');
  assert.equal(merged[0].issues.length, 1);
  assert.equal(merged[0].issues[0].code, 'COSMOLOGY');
  assert.match(merged[0].issues[0].reason, /Судья 1: закон/);
  assert.match(merged[0].issues[0].reason, /Судья 2: канон/);
  assert.equal(merged[1].verdict, 'PASS');
  assert.equal(merged[1].issues.length, 0);
});

test('пачка: судьи не солидарны — слот PASS, ремонт не зовут', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  let judgeN = 0;
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({ chronicle: `Хроника сапога ${i}` })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        await tool.handler({
          reviews: [
            {
              index: 1,
              verdict: 'FAIL',
              issues: [
                {
                  code: judgeN === 1 ? 'COSMOLOGY' : 'MOTION',
                  reason: judgeN === 1 ? 'закон' : 'стоит',
                },
              ],
            },
            { index: 2, verdict: 'PASS', summary: 'держит' },
            { index: 3, verdict: 'PASS', summary: 'держит' },
          ],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
    rng: () => 0,
  });
  assert.deepEqual(calls, [
    'freeformBrainstorm',
    'freeformBrainstormJudge',
    'freeformBrainstormJudge',
    'freeformBrainstormPick',
  ]);
  assert.equal(packed.reviews[0].verdict, 'PASS');
  assert.equal(packed.reviews[0].issues.length, 0);
  assert.equal(packed.repairPrompt, '');
  assert.equal(packed.winner.chronicle, 'Хроника сапога 1');
});

test('пачка: два PASS после первого судьи — FAIL всё равно идёт на починку', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  let judgeN = 0;
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push({ agentId: opts.agentId, domainId: opts.domainId });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm' || opts.agentId === 'freeformBrainstormRepairSonnet') {
        const isRepair = opts.agentId === 'freeformBrainstormRepairSonnet';
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: isRepair ? `Починка ${i}` : `Хроника сапога ${i}`,
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        await tool.handler({
          reviews:
            judgeN <= 2
              ? [
                  {
                    index: 1,
                    verdict: 'FAIL',
                    summary: 'новый закон мира',
                    issues: [{ code: 'COSMOLOGY', reason: 'посадка держится на новом законе мира' }],
                  },
                  { index: 2, verdict: 'PASS', summary: 'держит полосу' },
                  { index: 3, verdict: 'PASS', summary: 'держит полосу' },
                ]
              : [{ index: 1, verdict: 'PASS', summary: 'починилось' }],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
    rng: () => 0,
    domainId: 'domain_live',
  });
  assert.equal(packed.ok, true);
  assert.deepEqual(
    calls.map((c) => c.agentId),
    [
      'freeformBrainstorm',
      'freeformBrainstormJudge',
      'freeformBrainstormJudge',
      'freeformBrainstormRepairSonnet',
      'freeformBrainstormJudge',
      'freeformBrainstormPick',
    ],
  );
  assert.ok(calls.every((c) => c.domainId === 'domain_live'));
  assert.equal(packed.drafts[0].chronicle, 'Хроника сапога 1');
  assert.equal(packed.candidates[0].chronicle, 'Починка 1');
  assert.equal(packed.candidates[1].chronicle, 'Хроника сапога 2');
  assert.equal(packed.candidates[2].chronicle, 'Хроника сапога 3');
  assert.equal(packed.reviews[0].verdict, 'FAIL');
  assert.equal(packed.reviews[1].verdict, 'PASS');
  assert.equal(packed.finalReviews[0].verdict, 'PASS');
  assert.equal(packed.finalReviews[1], null);
  assert.equal(packed.finalReviews[2], null);
  assert.equal(packed.winner.chronicle, 'Починка 1');
  assert.equal(packed.pickedIndex, 1);
  assert.match(packed.repairPrompt, /новом законе мира/);
  assert.match(packed.repairPrompt, /\[COSMOLOGY\]/);
  assert.match(packed.repairPrompt, /Судья 1:/);
  assert.match(packed.repairPrompt, /Судья 2:/);
  assert.match(packed.repairPrompt, /Кандидат 1/);
  assert.doesNotMatch(packed.repairPrompt, /Кандидат 2|Кандидат 3/);
  assert.doesNotMatch(packed.repairPrompt, /Хроника сапога 2|Хроника сапога 3/);
  assert.doesNotMatch(packed.repairPrompt, /актуальный вердикт судьи:\nPASS/);
  assert.doesNotMatch(packed.repairPrompt, /правка:/);
  assert.match(packed.finalJudgePrompt, /Починка 1/);
  assert.doesNotMatch(packed.finalJudgePrompt, /Хроника сапога 2/);
  assert.match(packed.judgePrompt, /submit_freeform_pack_review/);
  assert.match(packed.judgePrompt, /Дефекты по критериям/);
  assert.doesNotMatch(packed.judgePrompt, /UNCERTAIN/);
  assert.doesNotMatch(packed.judgePrompt, /Минимальная инструкция автору/);
  assert.match(packed.judgePrompt, /PATRON/);
  assert.match(packed.judgePrompt, /CONFLUX/);
  assert.match(packed.judgePrompt, /^ОСИ$/m);
  assert.match(packed.judgePrompt, /^arena — /m);
  assert.match(packed.judgePrompt, /^HUMAN — /m);
  assert.match(packed.judgePrompt, /^BODY — /m);
  assert.doesNotMatch(packed.judgePrompt, /^engine — /m);
  assert.doesNotMatch(packed.judgePrompt, /хранител|инея/);
  assert.doesNotMatch(packed.judgePrompt, /автор:/);
  assert.doesNotMatch(packed.judgePrompt, /cityBrief/i);
  assert.doesNotMatch(packed.prompt, /ОБЯЗАТЕЛЬНАЯ ТАЙНА/);
  assert.doesNotMatch(packed.judgePrompt, /MYSTERY_PLAUSIBLE|тайна обязательна/);
  assert.doesNotMatch(packed.prompt, /НЕТ ЗАТРАВКИ|абстрактный город-государство/);
  assert.doesNotMatch(packed.judgePrompt, /НЕТ ЗАТРАВКИ|CHRONICLE не применяй/);
});

test('пачка: один PASS — чинятся только FAIL, второй судья видит только их', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  let judgeN = 0;
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm' || opts.agentId === 'freeformBrainstormRepairSonnet') {
        const isRepair = opts.agentId === 'freeformBrainstormRepairSonnet';
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: isRepair ? `Починка ${i}` : `Хроника сапога ${i}`,
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        await tool.handler({
          reviews:
            judgeN <= 2
              ? [
                  {
                    index: 1,
                    verdict: 'FAIL',
                    summary: 'новый закон мира',
                    issues: [{ code: 'COSMOLOGY', reason: 'новый закон' }],
                  },
                  {
                    index: 2,
                    verdict: 'FAIL',
                    summary: 'мелко',
                    issues: [{ code: 'GRAVITY', reason: 'эпизод' }],
                  },
                  { index: 3, verdict: 'PASS', summary: 'держит полосу' },
                ]
              : [
                  { index: 1, verdict: 'PASS', summary: 'починилось' },
                  { index: 2, verdict: 'PASS', summary: 'тоже' },
                ],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
    rng: () => 0,
  });
  assert.deepEqual(calls, [
    'freeformBrainstorm',
    'freeformBrainstormJudge',
    'freeformBrainstormJudge',
    'freeformBrainstormRepairSonnet',
    'freeformBrainstormJudge',
    'freeformBrainstormPick',
  ]);
  assert.doesNotMatch(packed.repairPrompt, /стартовый вариант:/);
  assert.match(packed.repairPrompt, /текущее состояние:/);
  assert.match(packed.repairPrompt, /актуальный вердикт судьи:/);
  assert.doesNotMatch(packed.repairPrompt, /актуальный вердикт судьи:\nPASS/);
  assert.doesNotMatch(packed.repairPrompt, /Кандидат 3/);
  assert.doesNotMatch(packed.repairPrompt, /Хроника сапога 3/);
  assert.match(packed.repairPrompt, /\[COSMOLOGY\]/);
  assert.match(packed.repairPrompt, /новый закон/);
  assert.doesNotMatch(packed.repairPrompt, /правка:/);
  assert.doesNotMatch(packed.repairPrompt, /черновик 1:|предыдущие черновики/);
  assert.equal(packed.candidates[2].chronicle, 'Хроника сапога 3');
  assert.equal(packed.candidates[0].chronicle, 'Починка 1');
  assert.equal(packed.finalReviews[0].verdict, 'PASS');
  assert.equal(packed.finalReviews[1].verdict, 'PASS');
  assert.equal(packed.finalReviews[2], null);
  assert.doesNotMatch(packed.finalJudgePrompt, /Хроника сапога 3/);
  assert.doesNotMatch(packed.finalJudgePrompt, /Кандидат 3/);
  assert.match(packed.finalJudgePrompt, /Починка 1/);
  assert.match(packed.finalJudgePrompt, /Починка 2/);
  assert.match(packed.finalJudgePrompt, /2 кандидатов \(1, 2\)/);
  assert.equal(packed.ok, true);
  assert.equal(packed.winner.chronicle, 'Починка 1');
  assert.equal(packed.pickedIndex, 1);
});

test('пачка: второй судья не видит средний PASS и сохраняет номера 1 и 3', async () => {
  const real = new AgentRuntime(loadConfig());
  let judgeN = 0;
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm' || opts.agentId === 'freeformBrainstormRepairSonnet') {
        const isRepair = opts.agentId === 'freeformBrainstormRepairSonnet';
        const user = String(opts.userMessages?.[0]?.content || '');
        const indices = [...user.matchAll(/=== Кандидат (\d+) ===/g)].map((m) => Number(m[1]));
        const ids = isRepair && indices.length ? indices : [1, 2, 3];
        await tool.handler({
          candidates: ids.map((i) => ({
            chronicle: isRepair ? `Починка ${i}` : `Хроника сапога ${i}`,
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        await tool.handler({
          reviews:
            judgeN <= 2
              ? [
                  { index: 1, verdict: 'FAIL', summary: 'дыряво', issues: [{ code: 'HINGE', reason: 'дыры' }] },
                  { index: 2, verdict: 'PASS', summary: 'держит' },
                  { index: 3, verdict: 'FAIL', summary: 'мелко', issues: [{ code: 'GRAVITY', reason: 'эпизод' }] },
                ]
              : [
                  { index: 1, verdict: 'PASS', summary: 'починилось' },
                  { index: 3, verdict: 'PASS', summary: 'тоже' },
                ],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
    rng: () => 0,
  });
  assert.equal(packed.candidates[1].chronicle, 'Хроника сапога 2');
  assert.equal(packed.candidates[0].chronicle, 'Починка 1');
  assert.equal(packed.candidates[2].chronicle, 'Починка 3');
  assert.equal(packed.finalReviews[0].verdict, 'PASS');
  assert.equal(packed.finalReviews[1], null);
  assert.equal(packed.finalReviews[2].verdict, 'PASS');
  assert.doesNotMatch(packed.finalJudgePrompt, /Хроника сапога 2/);
  assert.doesNotMatch(packed.finalJudgePrompt, /Кандидат 2/);
  assert.match(packed.finalJudgePrompt, /Кандидат 1/);
  assert.match(packed.finalJudgePrompt, /Кандидат 3/);
  assert.match(packed.finalJudgePrompt, /2 кандидатов \(1, 3\)/);
  assert.equal(packed.winner.chronicle, 'Починка 1');
});

test('после sonnet-починки PASS < 2 — luna с брифом и предыдущими черновиками, только FAIL', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  const extras = [];
  let judgeN = 0;
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      extras.push({
        agentId: opts.agentId,
        user: String(opts.userMessages?.[0]?.content || ''),
        extraSystem: String(opts.extraSystem || ''),
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      const user = String(opts.userMessages?.[0]?.content || '');
      if (opts.agentId === 'freeformBrainstorm' || opts.agentId === 'freeformBrainstormRepairSonnet') {
        const isRepair = opts.agentId === 'freeformBrainstormRepairSonnet';
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: isRepair ? `Починка ${i}` : `Хроника сапога ${i}`,
          })),
        });
        return;
      }
      if (opts.agentId === 'freeformBrainstormRepair') {
        const n = (user.match(/=== Кандидат/g) || []).length;
        await tool.handler({
          candidates: Array.from({ length: n }, (_, i) => ({ chronicle: `Луна ${i + 1}` })),
        });
        return;
      }
      if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        await tool.handler({
          reviews:
            judgeN <= 2
              ? [
                  { index: 1, verdict: 'FAIL', summary: 'дыряво', issues: [{ code: 'HINGE', reason: 'дыры' }] },
                  { index: 2, verdict: 'FAIL', summary: 'мелко', issues: [{ code: 'GRAVITY', reason: 'эпизод' }] },
                  { index: 3, verdict: 'PASS', summary: 'держит' },
                ]
              : judgeN === 3
                ? [
                    { index: 1, verdict: 'FAIL', summary: 'всё ещё дыряво', issues: [{ code: 'HINGE', reason: 'дыры остались' }] },
                    { index: 2, verdict: 'FAIL', summary: 'всё ещё мелко', issues: [{ code: 'GRAVITY', reason: 'всё ещё эпизод' }] },
                  ]
                : judgeN === 4
                  ? [
                      { index: 1, verdict: 'PASS', summary: 'луна починила' },
                      { index: 2, verdict: 'FAIL', summary: 'нет', issues: [{ code: 'GRAVITY', reason: 'нет' }] },
                    ]
                  : [{ index: 2, verdict: 'FAIL', summary: 'нет', issues: [{ code: 'GRAVITY', reason: 'нет' }] }],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
    rng: () => 0,
  });
  assert.deepEqual(calls, [
    'freeformBrainstorm',
    'freeformBrainstormJudge',
    'freeformBrainstormJudge',
    'freeformBrainstormRepairSonnet',
    'freeformBrainstormJudge',
    'freeformBrainstormRepair',
    'freeformBrainstormJudge',
    'freeformBrainstormRepair',
    'freeformBrainstormJudge',
    'freeformBrainstormPick',
  ]);
  const sonnet = extras.find((e) => e.agentId === 'freeformBrainstormRepairSonnet');
  assert.ok(sonnet);
  assert.match(sonnet.user, /текущее состояние:/);
  assert.doesNotMatch(sonnet.user, /стартовый вариант:/);
  assert.doesNotMatch(sonnet.user, /Хроника сапога 3/);
  assert.doesNotMatch(sonnet.user, /актуальный вердикт судьи:\nPASS/);
  const luna = extras.find((e) => e.agentId === 'freeformBrainstormRepair');
  assert.ok(luna);
  assert.match(luna.user, /GRAVITY/);
  assert.match(luna.user, /оси:/);
  assert.match(luna.user, /стартовый вариант:/);
  assert.match(luna.user, /текущее состояние:/);
  assert.match(luna.user, /актуальный вердикт судьи:/);
  assert.match(luna.user, /замечания:/);
  assert.match(luna.user, /\[HINGE\]/);
  assert.doesNotMatch(luna.user, /правка:/);
  assert.doesNotMatch(luna.user, /черновик 1:|предыдущие черновики/);
  assert.match(luna.user, /ЗАТРАВКА/);
  assert.match(luna.user, /На площади нашли чужой сапог/);
  assert.match(luna.user, /Хроника сапога 1/);
  assert.match(luna.user, /Починка 1/);
  assert.ok(luna.user.indexOf('стартовый вариант:') < luna.user.indexOf('текущее состояние:'));
  assert.ok(luna.user.indexOf('Хроника сапога 1') < luna.user.indexOf('Починка 1'));
  assert.match(luna.user, /автор:/);
  assert.doesNotMatch(luna.user, /Хроника сапога 3/);
  assert.doesNotMatch(luna.extraSystem, /cityBrief/);
  assert.equal(packed.candidates[2].chronicle, 'Хроника сапога 3');
  assert.equal(packed.candidates[0].chronicle, 'Луна 1');
  assert.equal(packed.finalReviews[0].verdict, 'PASS');
  assert.equal(packed.finalReviews[1].verdict, 'FAIL');
  assert.equal(packed.finalReviews[2], null);
  assert.match(packed.extraRepairPrompt, /ДОРАБОТКА/);
  assert.match(packed.extraJudgePrompt, /Луна 1/);
  assert.equal(packed.ok, true);
  assert.equal(packed.winner.chronicle, 'Луна 1');
});

test('дешёвая luna не больше двух кругов, даже если PASS один', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  let judgeN = 0;
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (!tool) return;
      const user = String(opts.userMessages?.[0]?.content || '');
      if (
        opts.agentId === 'freeformBrainstorm' ||
        opts.agentId === 'freeformBrainstormRepairSonnet' ||
        opts.agentId === 'freeformBrainstormRepair'
      ) {
        const n = Math.max(1, (user.match(/=== Кандидат/g) || []).length || 3);
        const prefix =
          opts.agentId === 'freeformBrainstormRepair'
            ? 'Луна'
            : opts.agentId === 'freeformBrainstormRepairSonnet'
              ? 'Починка'
              : 'Хроника';
        await tool.handler({
          candidates: Array.from({ length: n }, (_, i) => ({ chronicle: `${prefix} ${i + 1}` })),
        });
        return;
      }
      if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        const failTwo = [
          { index: 1, verdict: 'FAIL', summary: 'дыряво', issues: [{ code: 'HINGE', reason: 'дыры' }] },
          { index: 2, verdict: 'FAIL', summary: 'мелко', issues: [{ code: 'GRAVITY', reason: 'эпизод' }] },
        ];
        await tool.handler({
          reviews:
            judgeN <= 2
              ? [...failTwo, { index: 3, verdict: 'PASS', summary: 'держит' }]
              : failTwo,
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
    rng: () => 0,
  });
  assert.deepEqual(calls, [
    'freeformBrainstorm',
    'freeformBrainstormJudge',
    'freeformBrainstormJudge',
    'freeformBrainstormRepairSonnet',
    'freeformBrainstormJudge',
    'freeformBrainstormRepair',
    'freeformBrainstormJudge',
    'freeformBrainstormRepair',
    'freeformBrainstormJudge',
  ]);
  assert.equal(packed.winner.chronicle, 'Хроника 3');
  assert.equal(calls.filter((id) => id === 'freeformBrainstormRepair').length, 2);
});

test('посев с тайной добавляет блоки архитектору и судье', async () => {
  assert.equal(parseRequireMystery(true), true);
  assert.equal(parseRequireMystery('on'), true);
  assert.equal(parseRequireMystery(false), false);
  assert.equal(parseRequireMystery(undefined), false);
  const real = new AgentRuntime(loadConfig());
  const extras = [];
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      extras.push({ agentId: opts.agentId, extraSystem: String(opts.extraSystem || '') });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({ chronicle: `Хроника сапога ${i}` })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [
            { index: 1, verdict: 'FAIL', repair: 'добавь разгадку', issues: [{ code: 'MYSTERY_PLAUSIBLE', reason: 'нет разгадки' }] },
            { index: 2, verdict: 'PASS', summary: 'держит тайну' },
            { index: 3, verdict: 'PASS', summary: 'держит тайну' },
          ],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
    requireMystery: true,
    rng: () => 0,
  });
  assert.equal(packed.ok, true);
  const architect = extras.find((e) => e.agentId === 'freeformBrainstorm');
  const judge = extras.find((e) => e.agentId === 'freeformBrainstormJudge');
  assert.match(architect.extraSystem, /ОБЯЗАТЕЛЬНАЯ ТАЙНА/);
  assert.match(architect.extraSystem, /переопределяет правило/);
  assert.match(packed.prompt, /ОБЯЗАТЕЛЬНАЯ ТАЙНА/);
  assert.match(judge.extraSystem, /MYSTERY —/);
  assert.match(judge.extraSystem, /MYSTERY_PLAUSIBLE/);
  assert.match(judge.extraSystem, /обряд сработал не по той причине/);
  assert.doesNotMatch(judge.extraSystem, /ENGINEERING_PORN/);
  assert.match(packed.repairPrompt, /инженерией:/);
  assert.match(packed.judgePrompt, /MYSTERY_PLAUSIBLE/);
  assert.match(packed.judgePrompt, /CHEKHOV при этом посеве не опционален/);
  assert.equal(packed.reviews[0].issues[0].code, 'MYSTERY_PLAUSIBLE');
  const drafts = [1, 2, 3].map((i) => ({
    index: i,
    chronicle: `Хроника ${i}`,
    hook: `Хроника ${i}`,
    arena: 'HUMAN',
    worldRelation: 'NATIVE',
    target: 'FOOD',
    knowledge: 'OPEN',
    engine: 'REFUSAL',
    timing: 'FRESH_INCIDENT',
  }));
  let repairExtra = '';
  const repairedMystery = await repairBrainstormPack({
    runtime: {
      assembleChat: (opts) => real.assembleChat(opts),
      async run(opts) {
        repairExtra = String(opts.extraSystem || '');
        const tool = opts.tools?.[0];
        if (!tool) return;
        await tool.handler({
          candidates: drafts.map((c) => ({ chronicle: c.chronicle })),
        });
      },
    },
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'EPISODE',
    drafts,
    reviews: [
      { index: 1, verdict: 'FAIL', issues: [{ code: 'MYSTERY_PLAUSIBLE', reason: 'нет разгадки' }] },
      { index: 2, verdict: 'PASS' },
      { index: 3, verdict: 'PASS' },
    ],
    requireMystery: true,
    config: loadConfig(),
  });
  assert.match(repairExtra, /ОБЯЗАТЕЛЬНАЯ ТАЙНА/);
  assert.match(repairedMystery.prompt, /исправить ровно то/);
  assert.match(repairedMystery.prompt, /\[MYSTERY_PLAUSIBLE\]\nнет разгадки/);
  assert.match(repairedMystery.prompt, /agent: freeformBrainstormRepairSonnet/);
  assert.doesNotMatch(repairedMystery.prompt, /правка:/);
});

test('посев из пустоты: архитектор и судья пишут про абстрактный город', async () => {
  const real = new AgentRuntime(loadConfig());
  const extras = [];
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      extras.push({
        agentId: opts.agentId,
        extraSystem: String(opts.extraSystem || ''),
        user: String(opts.userMessages?.[0]?.content || ''),
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({ chronicle: `Хроника сапога ${i}` })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [
            { index: 1, verdict: 'FAIL', repair: 'обостри' },
            { index: 2, verdict: 'PASS', summary: 'держит' },
            { index: 3, verdict: 'PASS', summary: 'держит' },
          ],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: '',
    gravity: 'EPISODE',
    fromVoid: true,
    rng: () => 0,
  });
  assert.equal(packed.ok, true);
  const architect = extras.find((e) => e.agentId === 'freeformBrainstorm');
  const judge = extras.find((e) => e.agentId === 'freeformBrainstormJudge');
  assert.match(architect.extraSystem, /НЕТ ЗАТРАВКИ/);
  assert.match(architect.extraSystem, /абстрактный город-государство на летающем острове/);
  assert.match(architect.user, /ЗАТРАВКА/);
  assert.match(architect.user, /нет\. Придумай историю с нуля/);
  assert.doesNotMatch(architect.user, /На площади нашли/);
  assert.match(packed.prompt, /абстрактный город-государство/);
  assert.match(judge.extraSystem, /CHRONICLE не применяй/);
  assert.match(packed.judgePrompt, /абстрактный город-государство/);
  assert.doesNotMatch(architect.extraSystem, /ОБЯЗАТЕЛЬНАЯ ТАЙНА/);
});

test('посев из генезиса: архитектор видит описание города, не пустоту', async () => {
  const real = new AgentRuntime(loadConfig());
  const extras = [];
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      extras.push({
        agentId: opts.agentId,
        extraSystem: String(opts.extraSystem || ''),
        user: String(opts.userMessages?.[0]?.content || ''),
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({ chronicle: `Хроника сапога ${i}` })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [
            { index: 1, verdict: 'FAIL', repair: 'обостри' },
            { index: 2, verdict: 'PASS', summary: 'держит' },
            { index: 3, verdict: 'PASS', summary: 'держит' },
          ],
        });
      }
    },
  };
  const packed = await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'Вертикальный город вокруг Праотца, джунгли давят на край освоенного ядра.',
    gravity: 'SITUATION',
    fromGenesis: true,
    rng: () => 0,
  });
  assert.equal(packed.ok, true);
  const architect = extras.find((e) => e.agentId === 'freeformBrainstorm');
  const judge = extras.find((e) => e.agentId === 'freeformBrainstormJudge');
  assert.match(architect.extraSystem, /БРИФ ГОРОДА/);
  assert.match(architect.extraSystem, /стандартный бриф/);
  assert.match(architect.extraSystem, /Не полное описание и не каталог сущностей/);
  assert.match(architect.user, /БРИФ ГОРОДА/);
  assert.match(architect.user, /Вертикальный город вокруг Праотца/);
  assert.doesNotMatch(architect.user, /cityBrief/i);
  assert.doesNotMatch(architect.user, /Срез каталога|Обмен хлебом/);
  assert.doesNotMatch(architect.extraSystem, /cityBrief|полное описание города|==== ГОРОД ====/);
  assert.doesNotMatch(architect.extraSystem, /НЕТ ЗАТРАВКИ/);
  assert.match(judge.extraSystem, /БРИФ ГОРОДА/);
  assert.match(judge.user, /Вертикальный город вокруг Праотца/);
  assert.doesNotMatch(judge.extraSystem, /CHRONICLE не применяй/);
  assert.match(GENESIS_ARCHITECT_EXTRA, /стандартный бриф/);
  assert.match(GENESIS_JUDGE_EXTRA, /не обязательный крючок/);
  assert.match(GENESIS_JUDGE_EXTRA, /UNKNOWNS/);
  assert.doesNotMatch(GENESIS_JUDGE_EXTRA, /не вырастает из этого города/);
});

test('посев из хроники не подмешивает бриф города', async () => {
  const real = new AgentRuntime(loadConfig());
  const extras = [];
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      extras.push({
        agentId: opts.agentId,
        extraSystem: String(opts.extraSystem || ''),
        user: String(opts.userMessages?.[0]?.content || ''),
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({ chronicle: `Хроника сапога ${i}` })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [1, 2, 3].map((i) => ({ index: i, verdict: 'PASS', summary: 'держит' })),
        });
      }
    },
  };
  await brainstormFreeformPack({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'EPISODE',
    rng: () => 0,
  });
  const writer = extras.find((e) => e.agentId === 'freeformBrainstorm');
  const judge = extras.find((e) => e.agentId === 'freeformBrainstormJudge');
  assert.match(writer.user, /На площади нашли чужой сапог/);
  assert.doesNotMatch(writer.extraSystem, /БРИФ ГОРОДА|стандартный бриф/);
  assert.doesNotMatch(writer.user, /БРИФ ГОРОДА/);
  assert.doesNotMatch(judge.extraSystem, /БРИФ ГОРОДА/);
});

test('правка пропускается, если судья ничего не просит', async () => {
  const calls = [];
  const drafts = [1, 2, 3].map((i) => ({
    index: i,
    chronicle: `Хроника ${i}`,
    hook: `Хроника ${i}`,
    arena: 'HUMAN',
    worldRelation: 'NATIVE',
    target: 'FOOD',
    knowledge: 'OPEN',
    engine: 'REFUSAL',
    timing: 'FRESH_INCIDENT',
  }));
  const out = await repairBrainstormPack({
    runtime: {
      async run(opts) {
        calls.push(opts.agentId);
      },
    },
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'EPISODE',
    drafts,
    reviews: [
      { index: 1, verdict: 'PASS', repair: '' },
      { index: 2, verdict: 'PASS', repair: '' },
      { index: 3, verdict: 'PASS', repair: '' },
    ],
  });
  assert.equal(calls.length, 0);
  assert.equal(out.candidates, drafts);
  assert.equal(out.prompt, '');
});

test('PASS с советом repair не идёт на починку', async () => {
  const calls = [];
  const drafts = [1, 2, 3].map((i) => ({
    index: i,
    chronicle: `Хроника ${i}`,
    hook: `Хроника ${i}`,
    arena: 'HUMAN',
    worldRelation: 'NATIVE',
    target: 'FOOD',
    knowledge: 'OPEN',
    engine: 'REFUSAL',
    timing: 'FRESH_INCIDENT',
  }));
  const out = await repairBrainstormPack({
    runtime: {
      async run(opts) {
        calls.push(opts.agentId);
      },
    },
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'EPISODE',
    drafts,
    reviews: [
      { index: 1, verdict: 'PASS', repair: 'обостри динамику' },
      { index: 2, verdict: 'PASS', repair: '' },
      { index: 3, verdict: 'PASS', repair: 'уточни шарнир' },
    ],
  });
  assert.equal(calls.length, 0);
  assert.equal(out.candidates, drafts);
});

test('FAIL без repair идёт на починку по замечаниям', async () => {
  const calls = [];
  let user = '';
  const drafts = [1, 2, 3].map((i) => ({
    index: i,
    chronicle: `Хроника ${i}`,
    hook: `Хроника ${i}`,
    arena: 'HUMAN',
    worldRelation: 'NATIVE',
    target: 'FOOD',
    knowledge: 'OPEN',
    engine: 'REFUSAL',
    timing: 'FRESH_INCIDENT',
  }));
  const out = await repairBrainstormPack({
    runtime: {
      assembleChat: () => ({ systemContent: '', messages: [], tools: [] }),
      async run(opts) {
        calls.push(opts.agentId);
        user = String(opts.userMessages?.[0]?.content || '');
        const tool = opts.tools?.[0];
        if (!tool) return;
        await tool.handler({
          candidates: drafts.map((c) => ({ chronicle: `Починка ${c.index}` })),
        });
      },
    },
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'EPISODE',
    drafts,
    reviews: [
      { index: 1, verdict: 'FAIL', issues: [{ code: 'GRAVITY', reason: 'это эпизод, не разрыв' }] },
      { index: 2, verdict: 'PASS' },
      { index: 3, verdict: 'PASS' },
    ],
  });
  assert.equal(calls.length, 1);
  assert.match(user, /\[GRAVITY\]\nэто эпизод, не разрыв/);
  assert.match(user, /замечания:/);
  assert.doesNotMatch(user, /стартовый вариант:/);
  assert.match(user, /текущее состояние:/);
  assert.match(user, /актуальный вердикт судьи:/);
  assert.doesNotMatch(user, /правка:/);
  assert.doesNotMatch(user, /Кандидат 2|Кандидат 3/);
  assert.doesNotMatch(user, /Хроника 2|Хроника 3/);
  assert.doesNotMatch(user, /актуальный вердикт судьи:\nPASS/);
  assert.equal(out.candidates[0].chronicle, 'Починка 1');
});

test('ремонтник: первая итерация без лога, следующая видит стартовый вариант и не дублирует текущее', async () => {
  const start = {
    index: 1,
    chronicle: 'Стартовая хроника',
    arena: 'HUMAN',
    worldRelation: 'NATIVE',
    target: 'FOOD',
    knowledge: 'OPEN',
  };
  const firstReview = {
    index: 1,
    verdict: 'FAIL',
    issues: [{ code: 'GRAVITY', reason: 'это эпизод' }],
  };
  const capture = async ({ drafts, reviews, history }) => {
    let user = '';
    await repairBrainstormPack({
      runtime: {
        assembleChat: () => ({ systemContent: '', messages: [], tools: [] }),
        async run(opts) {
          user = String(opts.userMessages?.[0]?.content || '');
          const tool = opts.tools?.[0];
          if (!tool) return;
          await tool.handler({ candidates: [{ chronicle: 'Следующая починка' }] });
        },
      },
      seedText: 'На площади нашли чужой сапог и двор его держит.',
      gravity: 'RUPTURE',
      drafts,
      reviews,
      history,
    });
    return user;
  };

  const first = await capture({
    drafts: [start],
    reviews: [firstReview],
    history: pushFailedRepairHistory({}, [start], [firstReview]),
  });
  assert.match(first, /текущее состояние:\nСтартовая хроника/);
  assert.doesNotMatch(first, /стартовый вариант:/);
  assert.equal((first.match(/Стартовая хроника/g) || []).length, 1);

  const repaired = [{ ...start, chronicle: 'Починка 1' }];
  const stillFail = {
    index: 1,
    verdict: 'FAIL',
    issues: [{ code: 'HINGE', reason: 'дыры остались' }],
  };
  const second = await capture({
    drafts: repaired,
    reviews: [stillFail],
    history: pushFailedRepairHistory(
      pushFailedRepairHistory({}, [start], [firstReview]),
      repaired,
      [stillFail],
    ),
  });
  assert.match(second, /стартовый вариант:\nСтартовая хроника/);
  assert.match(second, /текущее состояние:\nПочинка 1/);
  assert.doesNotMatch(second, /стартовый вариант:\nПочинка 1/);
  assert.ok(second.indexOf('стартовый вариант:') < second.indexOf('текущее состояние:'));
  assert.equal((second.match(/Починка 1/g) || []).length, 1);
});

test('лабораторный payload отдаёт затравки без сюжета', () => {
  const payload = sessionPayload({
    mode: 'seeds',
    cityName: 'Грасток',
    world: { tickIndex: 1, gameDate: { year: 1, month: 1 } },
    domain: { name: 'Грасток', lore: [], plotlines: [] },
    lastChronicle: 'На площади нашли чужой сапог и двор его держит.',
    lastGravity: 'RUPTURE',
    lastRequireMystery: true,
    lastCandidates: [
      {
        index: 1,
        chronicle: 'Сапог зовёт иначе, и площадь спорит неделю.',
      },
    ],
    lastDrafts: [
      {
        index: 1,
        chronicle: 'Сапог зовёт, и площадь спорит.',
      },
    ],
    lastJudgeReviews: [{ index: 1, verdict: 'FAIL', summary: 'посадка мельче', repair: 'подними последствия', issues: [] }],
    lastArchitectPrompt: 'agent: freeformBrainstorm',
    lastJudgePrompt: 'agent: freeformBrainstormJudge',
    lastRepairPrompt: 'ДОРАБОТКА',
    lastFinalJudgePrompt: 'второй судья',
    lastAssemblePrompt: 'конструктор',
    lastEndingsPrompt: 'концовки',
    lastUrgencyPrompt: 'срок',
    lastAlignPrompt: '',
    lastBeatArchitectPrompt: '',
    lastBeatJudgePrompt: '',
    lastBeatRepairPrompt: '',
    lastBeatTellPrompt: '',
    lastFinalReviews: [{ index: 1, verdict: 'PASS', summary: 'ок', repair: '', issues: [] }],
    lastPickedIndex: 1,
    lastRejected: [],
    lastJudge: null,
    lastWarning: null,
    plotId: null,
  });
  assert.equal(payload.mode, 'seeds');
  assert.equal(payload.plot, null);
  assert.equal(payload.lastCandidates.length, 1);
  assert.equal(payload.lastDrafts.length, 1);
  assert.equal(payload.lastJudgeReviews[0].verdict, 'FAIL');
  assert.equal(payload.lastGravity, 'RUPTURE');
  assert.equal(payload.lastRequireMystery, true);
  assert.equal(payload.lastChronicle, 'На площади нашли чужой сапог и двор его держит.');
  assert.match(payload.lastArchitectPrompt, /freeformBrainstorm/);
  assert.match(payload.lastJudgePrompt, /freeformBrainstormJudge/);
  assert.equal(payload.lastFinalReviews[0].verdict, 'PASS');
  assert.equal(payload.lastPickedIndex, 1);
  assert.match(payload.lastFinalJudgePrompt, /второй судья/);
  assert.match(payload.lastAssemblePrompt, /конструктор/);
  assert.match(payload.lastEndingsPrompt, /концовки/);
  assert.match(payload.lastUrgencyPrompt, /срок/);
  assert.equal(payload.lastAlignPrompt, '');
  assert.equal(payload.canUndo, false);
  assert.deepEqual(payload.lastBeatVariants, []);
});

test('из PASS без агента берётся случайный, без PASS победителя нет', () => {
  const candidates = [1, 2, 3].map((i) => ({ index: i, chronicle: `Хроника ${i}` }));
  const mixed = [
    { index: 1, verdict: 'FAIL' },
    { index: 2, verdict: 'PASS' },
    { index: 3, verdict: 'PASS' },
  ];
  assert.equal(pickPassedBrainstormCandidate(candidates, mixed, () => 0).index, 2);
  assert.equal(pickPassedBrainstormCandidate(candidates, mixed, () => 0.99).index, 3);
  assert.equal(
    pickPassedBrainstormCandidate(
      candidates,
      [
        { index: 1, verdict: 'FAIL' },
        { index: 2, verdict: 'UNCERTAIN' },
        { index: 3, verdict: 'FAIL' },
      ],
      () => 0,
    ),
    null,
  );
  assert.equal(parseFreeformPoolPick({ pick: 3, why: 'живее' }, [2, 3])?.pick, 3);
  assert.equal(parseFreeformPoolPick({ pick: 1 }, [2, 3]), null);
  assert.equal(parseFreeformPoolPick({ pick: 99 }, [2, 3]), null);
});

test('дешёвый агент выбирает из пула PASS и сторонится воды, геологии и канцелярии', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  let pickUser = '';
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstormPick') {
        pickUser = String(opts.userMessages?.[0]?.content || '');
        await tool.handler({ pick: 3, why: 'живая клятва, не водосбор' });
      }
    },
  };
  const picked = await pickBrainstormPoolWinner({
    runtime,
    gravity: 'CRISIS',
    config: loadConfig(),
    rng: () => 0,
    pool: [
      { index: 1, chronicle: 'Комиссия сверяет потерянный протокол водосбора.', arena: 'BUILT' },
      { index: 2, chronicle: 'Осыпь грунта закрыла родник в пласте.', arena: 'EARTH' },
      { index: 3, chronicle: 'Двор спорит из-за клятвы, которую нельзя исполнить разом.', arena: 'HUMAN' },
    ].filter((c) => c.index !== 2),
  });
  assert.deepEqual(calls, ['freeformBrainstormPick']);
  assert.match(pickUser, /Выбери один номер: 1, 3/);
  assert.match(pickUser, /Двор спорит из-за клятвы/);
  assert.doesNotMatch(pickUser, /осыпь грунта/);
  assert.equal(picked.source, 'agent');
  assert.equal(picked.pickedIndex, 3);
  assert.equal(picked.winner.chronicle, 'Двор спорит из-за клятвы, которую нельзя исполнить разом.');
  assert.match(picked.why, /клятва/);
  assert.match(picked.prompt, /геолог|водосбор|канцеляр/);
  assert.match(picked.prompt, /pick_freeform_pool_winner/);
  assert.doesNotMatch(picked.prompt, /cityBrief|ОПИСАНИЕ ГОРОДА/);
  const single = await pickBrainstormPoolWinner({
    runtime,
    pool: [{ index: 2, chronicle: 'Один PASS про двор.' }],
    gravity: 'SITUATION',
    config: loadConfig(),
  });
  assert.equal(single.source, 'single');
  assert.equal(single.pickedIndex, 2);
  assert.equal(calls.length, 1);
  const fallback = await pickBrainstormPoolWinner({
    runtime: {
      assembleChat: (opts) => real.assembleChat(opts),
      async run() {},
    },
    pool: [
      { index: 1, chronicle: 'Первый PASS' },
      { index: 3, chronicle: 'Третий PASS' },
    ],
    gravity: 'EPISODE',
    config: loadConfig(),
    rng: () => 0.99,
  });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.winner.chronicle, 'Третий PASS');
});

test('отговорка не считается разгадкой', () => {
  assert.equal(
    isHollowHiddenPremise(
      'неизвестно; садовники и травники расходятся во мнениях, и ни одна проверка пока не дала внятного ответа.',
    ),
    true,
  );
  assert.equal(isHollowHiddenPremise('просто сквозняк в старой галерее'), true);
  assert.equal(
    isHollowHiddenPremise('ночной садовник сеет чужой мох, чтобы скрыть трещину склона'),
    false,
  );
  assert.equal(
    isHollowHiddenPremise('никто не знает, кроме мельника: он спускает воду из скрытой цистерны'),
    false,
  );
  assert.deepEqual(
    keepSeedReveals([
      'неизвестно; мнения расходятся',
      'круги кладёт ночной садовник — сеет мох на трещину',
    ]),
    ['круги кладёт ночной садовник — сеет мох на трещину'],
  );
  assert.equal(hasSeedReveal(['неизвестно, проверка ничего не дала']), false);
  const hollow = fallbackAssembledStory({
    chronicle:
      'На склоне лежат круги.\nНа самом деле: неизвестно; садовники расходятся во мнениях.',
  });
  assert.deepEqual(hollow.hiddenPremises, []);
  assert.equal(hollow.hiddenAnswer, '');
  assert.equal(hollow.chronicle, 'На склоне лежат круги.');
});

test('живой посев бросает шанс тайны, явный флаг его перекрывает', async () => {
  const cfg = loadConfig();
  assert.equal(shouldRequireSeedMystery(cfg, { rng: () => 0.24 }), true);
  assert.equal(shouldRequireSeedMystery(cfg, { rng: () => 0.25 }), false);
  assert.equal(shouldRequireSeedMystery(cfg, { requireMystery: true, rng: () => 0.99 }), true);
  assert.equal(shouldRequireSeedMystery(cfg, { requireMystery: false, rng: () => 0 }), false);
  assert.equal(parseRequireMystery('yes'), true);
});

test('живой посев без флага и без выпавшего шанса сажает историю без разгадки', async () => {
  const extras = [];
  const silentLog = { child: () => silentLog, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const runtime = {
    assembleChat: (opts) => ({
      systemContent: String(opts.extraSystem || ''),
      userContent: String(opts.userMessages?.[0]?.content || ''),
    }),
    async run(opts) {
      extras.push({ agentId: opts.agentId, extraSystem: String(opts.extraSystem || ''), domainId: opts.domainId });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: `Двор чинит мосток у межи ${i}. Доски уже скрипят под возом.`,
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [1, 2, 3].map((i) => ({ index: i, verdict: 'PASS', summary: 'обычный конфликт' })),
        });
      } else if (opts.agentId === 'freeformAssemble') {
        await tool.handler({
          title: 'Мосток у межи',
          chronicle: 'Двор чинит мосток у межи. Доски скрипят под возом.',
          cause: 'Опоры мостка сгнили от воды, стоящей у межи.',
          hiddenPremises: [],
        });
      }
    },
  };
  const config = loadConfig();
  config.logging = { ...config.logging, seedDump: false };
  const planted = await plantStakedStory({
    config,
    runtime,
    domain: { id: 'domain_1', name: 'Аллерия', lore: [], plotlines: [], stats: {} },
    world: { tickIndex: 1, dayIndex: 10, gameDate: { year: 1, month: 1, label: 'Год 1, месяц 1' } },
    seedText: 'У межи скрипит мосток.',
    gravity: 'SITUATION',
    rng: () => 0.99,
    log: silentLog,
  });
  const architect = extras.find((e) => e.agentId === 'freeformBrainstorm');
  const judge = extras.find((e) => e.agentId === 'freeformBrainstormJudge');
  assert.doesNotMatch(architect.extraSystem, /ОБЯЗАТЕЛЬНАЯ ТАЙНА/);
  assert.doesNotMatch(judge.extraSystem, /MYSTERY_PLAUSIBLE/);
  assert.ok(planted?.plot);
  assert.equal(planted.requireMystery, false);
  assert.deepEqual(planted.plot.hiddenPremises, []);
  assert.ok(extras.some((e) => e.agentId === 'freeformBrainstorm'));
  assert.equal(
    extras.some((e) => e.agentId === 'freeformHiddenSplit'),
    true,
    'после хроники разрезчик всегда видит seed',
  );
  assert.match(planted.plot.seed, /мосток у межи/);
  assert.match(planted.plot.synopsis, /мосток/);
  assert.doesNotMatch(planted.plot.synopsis, /На самом деле/i);
  assert.equal(
    extras.some((e) => e.agentId === 'freeformEndings'),
    false,
    'живой посев больше не пишет концовки заранее',
  );
  assert.ok(extras.some((e) => e.agentId === 'freeformUrgency'));
  assert.ok(extras.every((e) => e.domainId === 'domain_1'));
});

test('живой посев с выпавшей тайной просит разгадку у архитектора и судьи', async () => {
  const extras = [];
  const silentLog = { child: () => silentLog, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const runtime = {
    assembleChat: (opts) => ({
      systemContent: String(opts.extraSystem || ''),
      userContent: String(opts.userMessages?.[0]?.content || ''),
    }),
    async run(opts) {
      extras.push({ agentId: opts.agentId, extraSystem: String(opts.extraSystem || '') });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: `Двор чинит мосток у межи ${i}. Доски уже скрипят под возом.`,
            hiddenLayer: 'сосед подпилил балку.',
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [1, 2, 3].map((i) => ({ index: i, verdict: 'PASS', summary: 'тайна держит' })),
        });
      } else if (opts.agentId === 'freeformAssemble') {
        await tool.handler({
          title: 'Мосток у межи',
          chronicle: 'Двор чинит мосток у межи. Доски скрипят под возом.',
          cause: 'Опоры мостка сгнили от воды, стоящей у межи.',
          hiddenPremises: ['сосед подпилил балку, чтобы воз соседа застрял'],
        });
      }
    },
  };
  const config = loadConfig();
  config.logging = { ...config.logging, seedDump: false };
  const planted = await plantStakedStory({
    config,
    runtime,
    domain: { id: 'domain_1', name: 'Аллерия', lore: [], plotlines: [], stats: {} },
    world: { tickIndex: 1, dayIndex: 10, gameDate: { year: 1, month: 1, label: 'Год 1, месяц 1' } },
    seedText: 'У межи скрипит мосток.',
    gravity: 'SITUATION',
    rng: () => 0,
    log: silentLog,
  });
  const architect = extras.find((e) => e.agentId === 'freeformBrainstorm');
  const judge = extras.find((e) => e.agentId === 'freeformBrainstormJudge');
  assert.match(architect.extraSystem, /ОБЯЗАТЕЛЬНАЯ ТАЙНА/);
  assert.match(judge.extraSystem, /MYSTERY_PLAUSIBLE/);
  assert.equal(planted.requireMystery, true);
  assert.match(planted.plot.hiddenAnswer, /подпилил/);
  assert.match(planted.plot.seed, /hiddenLayer:\nсосед подпилил/);
  assert.doesNotMatch(planted.plot.seed, /На самом деле/);
  assert.doesNotMatch(planted.plot.synopsis, /подпилил/);
});

test('скрытый слой отрезается от наблюдаемой хроники', () => {
  const split = splitChronicleHiddenLayer(
    'Двор держит сапог без пары.\n\nНа самом деле: соль сыплется из разлома края.',
  );
  assert.equal(split.chronicle, 'Двор держит сапог без пары.');
  assert.deepEqual(split.hiddenPremises, ['соль сыплется из разлома края.']);
  const fallback = fallbackAssembledStory({
    chronicle: 'Сапог лежит на площади и зовёт хозяина дворами.\nНа самом деле: это не сапог, а край.',
  });
  assert.doesNotMatch(fallback.chronicle, /На самом деле/i);
  assert.equal(fallback.whyMoves, undefined);
  assert.equal(fallback.hiddenAnswer, '');
  assert.deepEqual(fallback.hiddenPremises, []);
  assert.deepEqual(
    leftoverSeedFacts(
      'Сапог лежит на площади и зовёт хозяина дворами.\nНа самом деле: это не сапог, а край.',
      fallback.chronicle,
    ),
    ['это не сапог, а край.'],
  );
  assert.deepEqual(
    leftoverSeedFacts('Сапог лежит на площади и зовёт хозяина дворами.', fallback.chronicle, 'это не сапог, а край.'),
    ['это не сапог, а край.'],
  );
  assert.equal(formatCandidateSeed({ chronicle: 'Сапог лежит.', hiddenLayer: 'это не сапог, а край.' }), 'Сапог лежит.\n\nhiddenLayer:\nэто не сапог, а край.');
  assert.equal(candidateHiddenLayer({ chronicle: 'Сапог лежит.', hiddenLayer: 'это не сапог, а край.' }), 'это не сапог, а край.');
  assert.deepEqual(
    heuristicHiddenSplit(['соль сыплется из разлома края.', 'двор видел расходную книгу деда']),
    {
      hiddenAnswer: 'соль сыплется из разлома края.',
      hiddenPremises: ['двор видел расходную книгу деда'],
    },
  );
  assert.equal(fallback.title, 'История', 'первое предложение хроники в заголовок не копируем');
  const resin =
    'На восточном дереве, где стоит храм Ориона, каменщики и смолокуры давно замечали: в верхних развилках кора сочится гуще.';
  assert.equal(keepStoryTitle(resin, resin), '');
  assert.equal(keepStoryTitle('На восточном дереве, где стоит храм Ориона', resin), '');
  assert.equal(keepStoryTitle('Смола восточного дерева', resin), 'Смола восточного дерева');
  assert.equal(keepStoryTitle('Сапог на площади', 'На площади Грастока двор держит сапог без пары.'), 'Сапог на площади');
  assert.equal(clampFreeformCountdown(0), 1);
  assert.equal(clampFreeformCountdown(9), 8);
  assert.equal(clampFreeformCountdown('3'), 3);
  assert.equal(clampFreeformCountdown('x', 2), 2);
});

test('hiddenSplit не зовут без затравки; иначе выносит не вошедшее в хронику', async () => {
  let called = 0;
  const silentLog = { child: () => silentLog, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const skipped = await splitAssembledHidden({
    runtime: {
      assembleChat: () => ({ systemContent: '', userContent: '' }),
      async run() {
        called += 1;
      },
    },
    story: {
      chronicle: 'Двор чинит мосток у межи.',
      cause: 'Опоры сгнили от воды.',
    },
    domain: { name: 'Грасток', cityBrief: 'ЦИСТЕРНЫ_МАРКЕР питают водосборы.' },
    log: silentLog,
  });
  assert.equal(called, 0);
  assert.equal(skipped.hiddenAnswer, '');
  assert.deepEqual(skipped.hiddenPremises, []);

  const seed = 'На площади Грастока двор держит сапог без пары.';
  const hiddenLayer =
    'Соль сыплется из разлома края, не из склада.\nСтарший видел расходную книгу деда.';
  const runtime = {
    assembleChat: (opts) => ({
      systemContent: String(opts.extraSystem || ''),
      userContent: String(opts.userMessages?.[0]?.content || ''),
    }),
    async run(opts) {
      called += 1;
      const asked = String(opts.userMessages?.[0]?.content || '');
      assert.match(asked, /Хроника:/);
      assert.match(asked, /площади Грастока/);
      assert.match(asked, /Первопричина:/);
      assert.match(asked, /ЗАТРАВКА/);
      assert.match(asked, /hiddenLayer:/);
      assert.match(asked, /разлома края/);
      assert.match(asked, /Соль сыплется/);
      assert.match(asked, /расходную книгу/);
      assert.doesNotMatch(asked, /cityBrief/i);
      assert.match(opts.extraSystem || '', /ЦИСТЕРНЫ_МАРКЕР/);
      assert.match(opts.extraSystem || '', /стандартный бриф/);
      assert.doesNotMatch(opts.extraSystem || '', /cityBrief/i);
      await opts.tools[0].handler({
        hiddenAnswer: 'Соль сыплется из разлома края, не из склада.',
        hiddenPremises: ['Старший видел расходную книгу деда — по ней можно выйти на разлом.'],
      });
    },
  };
  const organized = await splitAssembledHidden({
    runtime,
    story: {
      chronicle: 'На площади Грастока двор держит сапог без пары.',
      cause: 'Соль сыплется из разлома края, и двор не знает, чей это сапог.',
    },
    seed,
    hiddenLayer,
    domain: { name: 'Грасток', cityBrief: 'ЦИСТЕРНЫ_МАРКЕР питают водосборы.' },
    gravity: 'EPISODE',
    config: loadConfig(),
    log: silentLog,
  });
  assert.equal(called, 1);
  assert.match(organized.hiddenAnswer, /Соль сыплется/);
  assert.match(organized.hiddenPremises[0], /расходную книгу/);

  const keepDump = await splitAssembledHidden({
    runtime: {
      assembleChat: () => ({ systemContent: '', userContent: '' }),
      async run(opts) {
        await opts.tools[0].handler({
          hiddenAnswer: '',
          hiddenPremises: ['не надо переписывать в подступы'],
        });
      },
    },
    story: {
      chronicle: 'На площади лежит сапог.',
      cause: 'Край крошится.',
    },
    seed: 'На площади лежит сапог.\nНа самом деле: Соль сыплется из разлома края, не из склада.',
    log: silentLog,
  });
  assert.equal(keepDump.hiddenAnswer, '');
  assert.deepEqual(keepDump.hiddenPremises, ['Соль сыплется из разлома края, не из склада.']);
});

test('имя-агент не принимает пересказ хроники', async () => {
  const chronicle =
    'На восточном дереве, где стоит храм Ориона, каменщики и смолокуры давно замечали: кора сочится гуще.';
  const runtime = {
    assembleChat: () => ({ systemContent: '', userContent: '' }),
    async run(opts) {
      const tool = opts.tools?.[0];
      const clone = await tool.handler({ title: chronicle });
      assert.equal(clone.ok, false);
      const prefix = await tool.handler({ title: 'На восточном дереве, где стоит храм Ориона' });
      assert.equal(prefix.ok, false);
      await tool.handler({ title: 'Смола восточного дерева' });
    },
  };
  const named = await nameAssembledStory({ runtime, chronicle, cityName: 'Аллерия' });
  assert.equal(named.title, 'Смола восточного дерева');
});

test('конструктор собирает хронику и hidden — без countdown-агента', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  const domain = {
    name: 'Грасток',
    cityBrief: 'ЦИСТЕРНЫ_МАРКЕР питают водосборы и колёса.',
    lore: [],
    plotlines: [],
    officers: [{ id: 'o1', office: 'keeper', title: 'Хранитель', name: 'Элана' }],
  };
  const world = {
    tickIndex: 1,
    gameDate: { year: 1, month: 1 },
    namePool: { female: ['Айра', 'Найра'], male: ['Кален'] },
  };
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformAssemble') {
        assert.deepEqual(
          (opts.tools || []).map((t) => t.name),
          ['submit_freeform_story'],
        );
        assert.doesNotMatch(opts.extraSystem || '', /САНОВНИКИ НЕ ГЕРОИ/);
        assert.deepEqual(opts.tools[0].parameters.required, ['chronicle', 'cause']);
        assert.equal(opts.tools[0].parameters.properties.hiddenPremises, undefined);
        assert.equal(opts.tools[0].parameters.properties.whyMoves, undefined);
        await tool.handler({
          chronicle: 'На площади Грастока двор держит сапог без пары.',
          cause: 'Соль сыплется из разлома края, и двор не знает, чей это сапог.',
        });
      } else if (opts.agentId === 'freeformHiddenSplit') {
        const asked = String(opts.userMessages?.[0]?.content || '');
        assert.match(asked, /Хроника:/);
        assert.match(asked, /площади Грастока/);
        assert.match(asked, /Первопричина:/);
        assert.match(asked, /ЗАТРАВКА/);
        assert.match(asked, /hiddenLayer:/);
        assert.match(asked, /разлома края/);
        assert.match(asked, /Соль сыплется/);
        assert.match(asked, /расходную книгу/);
        assert.doesNotMatch(asked, /cityBrief/i);
        assert.match(opts.extraSystem || '', /ЦИСТЕРНЫ_МАРКЕР/);
        assert.match(opts.extraSystem || '', /стандартный бриф/);
        assert.doesNotMatch(opts.extraSystem || '', /cityBrief/i);
        await tool.handler({
          hiddenAnswer: 'Соль сыплется из разлома края, не из склада.',
          hiddenPremises: ['Старший видел расходную книгу деда.'],
        });
      } else if (opts.agentId === 'freeformTitle') {
        const asked = String(opts.userMessages?.[0]?.content || '');
        assert.match(asked, /площади Грастока/);
        assert.doesNotMatch(asked, /На самом деле/i);
        assert.doesNotMatch(asked, /подпилил|скрыт|разгадк/i);
        await tool.handler({ title: 'Сапог на площади' });
      }
    },
  };
  const out = await assembleFreeformLabStory({
    config: loadConfig(),
    runtime,
    domain,
    world,
    candidate: {
      index: 1,
      chronicle: 'Двор держит сапог.',
      hiddenLayer: 'соль сыплется из разлома края.\nСтарший видел расходную книгу деда.',
      arena: 'HUMAN',
      worldRelation: 'NATIVE',
    },
    gravity: 'EPISODE',
  });
  assert.deepEqual(calls, ['freeformAssemble', 'freeformHiddenSplit', 'freeformTitle']);
  assert.equal(out.title, 'Сапог на площади');
  assert.match(out.chronicle, /площади/);
  assert.doesNotMatch(out.chronicle, /На самом деле/i);
  assert.equal(out.whyMoves, undefined);
  assert.match(out.cause, /разлома края/);
  assert.match(out.hiddenAnswer, /Соль/);
  assert.match(out.hiddenPremises[0], /расходную книгу/);
  assert.equal(out.countdown, undefined);
  assert.match(out.assemblePrompt, /submit_freeform_story/);
  assert.doesNotMatch(out.assemblePrompt, /whyMoves|что ситуация сделает следующим/);
  assert.match(out.assemblePrompt, /Первопричина/);
  assert.match(out.assemblePrompt, /стартовое наблюдаемое событие/);
  assert.doesNotMatch(out.assemblePrompt, /hiddenPremises/);
  assert.doesNotMatch(out.assemblePrompt, /claim_character/);
  assert.doesNotMatch(out.assemblePrompt, /Не схлопывай цепочку/);
  assert.doesNotMatch(out.assemblePrompt, /\bdepth\b|countdown|urgency/i);
  assert.doesNotMatch(out.assemblePrompt, /САНОВНИКИ НЕ ГЕРОИ/);
  assert.match(out.hiddenPrompt, /submit_hidden_layer/);
  assert.match(out.hiddenPrompt, /Хроника:/);
  assert.match(out.hiddenPrompt, /Первопричина:/);
  assert.match(out.hiddenPrompt, /ЗАТРАВКА/);
  assert.match(out.hiddenPrompt, /hiddenLayer:/);
  assert.match(out.hiddenPrompt, /ЦИСТЕРНЫ_МАРКЕР/);
  assert.doesNotMatch(out.hiddenPrompt, /cityBrief/i);
  assert.match(out.titlePrompt, /то, что город уже знает/);
  assert.match(out.titlePrompt, /площади Грастока/);
  assert.doesNotMatch(out.titlePrompt, /соль сыплется/);
  assert.doesNotMatch(out.titlePrompt, /hiddenAnswer|hiddenPremises/);
  assert.equal(domain.lore.length, 0);
  const plot = createFreeformPlot({
    domain: { plotlines: [] },
    world: { tickIndex: 1 },
    variant: out,
    config: loadConfig(),
    rng: () => 0,
  });
  assert.equal(plot.type, 'story');
  assert.equal(plot.urgency, 'MEDIUM');
  assert.equal(plot.countdown, null);
  assert.equal(plot.whyMoves, undefined);
  assert.equal(plot.cause, out.cause, 'первопричина живёт на нити, а не только в сборке');
  assert.equal(plot.seed, out.seed);
  assert.match(plot.seed, /hiddenLayer:\nсоль сыплется/);
  assert.doesNotMatch(plot.seed, /На самом деле/);
  assert.equal(plot.synopsis, out.chronicle);
  assert.doesNotMatch(plot.synopsis, /На самом деле/i);
  assert.doesNotMatch(plotCardForPrompt(plot), /Завязка:/);
  assert.match(plotCardForPrompt(plot, { includeSeed: true }), /Завязка:/);
  assert.match(plotCardForPrompt(plot, { includeSeed: true }), /соль сыплется/);
  assert.equal(plot.arena, undefined);
  assert.equal(plot.hook, undefined);
  assert.equal(plot.conflict, undefined);
  assert.equal(plot.depth, 0);
  assert.equal(plot.maxDepth, 2);
  assert.equal(plot.maxFails, 1);
  assert.equal(formatFreeformDepth(plot), 'глубина 0/2');
  const held = { plotlines: [{ ...plot }] };
  normalizePlotlines(held);
  assert.equal(held.plotlines[0].seed, plot.seed);
  const payload = sessionPayload({
    mode: 'story',
    cityName: 'Грасток',
    world: { tickIndex: 1, gameDate: { year: 1, month: 1 } },
    domain: { name: 'Грасток', lore: [], plotlines: [plot] },
    plotId: plot.id,
  });
  assert.match(payload.plot.seed, /соль сыплется/);
  assert.equal(payload.plot.synopsis, plot.synopsis);
});

test('сборщик не пишет hidden, разрезчик берёт остаток затравки', () => {
  const agents = loadConfig().agents;
  assert.match(agents.freeformAssemble.instructions, /обозначить конфликт/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /hiddenPremises/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /На самом деле/);
  assert.match(agents.freeformHiddenSplit.instructions, /не вошедшие в хронику/);
  assert.match(agents.freeformHiddenSplit.instructions, /submit_hidden_layer/);
});

test('системный пакет архитекторов без cityBrief', () => {
  const runtime = new AgentRuntime(loadConfig());
  const packed = runtime.assembleChat({
    agentId: 'freeformArchitectTell',
    extraSystem: '',
    userMessages: [{ role: 'user', content: 'хроника' }],
  });
  assert.doesNotMatch(packed.systemContent, /cityBrief/i);
  assert.match(packed.systemContent, /один абзац/);
  assert.doesNotMatch(packed.systemContent, /ХОДА|whatHappens|closeWhen|архитектор/);
});

test('завязка возвращает полный промпт архитектора (system + user + tools)', async () => {
  const real = new AgentRuntime(configWithLegacyFreeform());
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Сапог зовёт ${i}`));
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 1, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        await tool.handler({
          title: 'Сапог',
          synopsis: 'Гость оставил сапог.',
          closeWhen: ['Найти', 'Бросить'],
          cause: 'Гость ушёл к створу и не вернулся за сапогом.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({ verdict: 'PASS', summary: 'ок', issues: [] });
      }
    },
  };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', cityBrief: 'ЦИСТЕРНЫ_МАРКЕР', plotlines: [], lore: [] },
    world: { tickIndex: 3, gameDate: { year: 1, month: 3 } },
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
  });
  assert.equal(started.ok, true);
  assert.match(started.architectPrompt, /=== SYSTEM ===/);
  assert.match(started.architectPrompt, /=== USER ===/);
  assert.match(started.architectPrompt, /=== TOOLS ===/);
  assert.match(started.architectPrompt, /придумываешь завязки/);
  assert.match(started.architectPrompt, /На площади нашли чужой сапог/);
  assert.match(started.architectPrompt, /GRAVITY: RUPTURE/);
  assert.match(started.architectPrompt, /submit_freeform_seed_blanks/);
  assert.match(started.architectPrompt, /ассоциативн/);
  assert.doesNotMatch(started.architectPrompt, /ЦИСТЕРНЫ_МАРКЕР/);
  assert.doesNotMatch(started.architectPrompt, /плесень|ANTI-ATTRACTOR/);
});

test('GET /freeform отдаёт лабораторию', async () => {
  const server = createWebServer({
    config: { web: { play: true, admin: false }, telegram: {} },
    app: { onOutbound() {} },
    runtime: {},
    storage: {},
  });
  const http = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = http.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/freeform`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Промпты агентов/);
    assert.match(html, /Генератор хроник/);
    assert.match(html, /Судья пачки/);
    assert.match(html, /Конструктор истории/);
    assert.match(html, /Urgency/);
    assert.match(html, /Концовки/);
    assert.match(html, /DIRECT \/ RELATED \/ UNRELATED/);
    assert.match(html, /Конструктор хода/);
    assert.match(html, /Три хроники/);
    assert.match(html, /Из хроники города/);
    assert.match(html, /Из пустоты/);
    assert.match(html, /id="seedMystery"/);
    assert.match(html, /Выполнить дело/);
    assert.match(html, /Автотик/);
    assert.match(html, /Назад/);
    assert.match(html, /Три хода/);
  } finally {
    await new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
  }
});

test('лаборатория не требует Basic auth админки', async () => {
  const server = createWebServer({
    config: {
      web: { play: true, admin: true },
      admin: { user: 'admin', password: 'secret' },
      telegram: {},
    },
    app: { onOutbound() {} },
    runtime: {},
    storage: {},
  });
  const http = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = http.address().port;
    const page = await fetch(`http://127.0.0.1:${port}/freeform`);
    assert.equal(page.status, 200);
    const state = await fetch(`http://127.0.0.1:${port}/api/freeform/state`);
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.cityName, 'Грасток');
  } finally {
    await new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
  }
});
