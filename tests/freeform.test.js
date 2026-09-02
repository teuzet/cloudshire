import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlotline,
  isThreeActPlot,
  isFreeformPlot,
  storyTypeOf,
  formatCloseWhen,
  normalizeCloseWhenList,
  normalizeFreeformEndings,
  plotBeatAgentId,
  PLOT_ENDING_MAX,
  PLOT_HOOK_MAX,
} from '../src/game/plotlines.js';
import { advanceWorldMonths, normalizeFinish, freeformConfig, openStoryTitlesLine, formatFreeformGravityForPrompt, formatFreeformChronicleSeed, formatBrainstormCandidateForPrompt, parseFreeformGravity, parseFreeformUrgency, FREEFORM_GRAVITY, clampFreeformCountdown, createFreeformPlot, sampleFreeformMaxDepth, advanceFreeformDepth, formatFreeformDepth, plotCardForPrompt, applyFreeformProgress, freeformTickDecision, rollFreeformCountdown, maxFailsForGravity } from '../src/game/freeform.js';
import { parseFreeformPick, formatFreeformVariants, formatFreeformCardJudgeCase, formatFreeformCardJudgeRepair, parseFreeformPackReview } from '../src/game/freeformJudge.js';
import { normalizeSeedBlank, pickFreeformSeedAxes, pickFreeformSeedAxisPairs, formatFreeformSeedAxesForPrompt, formatFreeformSeedAxisPairsForPrompt } from '../src/game/freeformArchitect.js';
import { listLegalBeatDynamics, pickFreeformBeatDynamics, formatBeatDynamicsForPrompt } from '../src/game/freeformDynamics.js';
import { sessionPayload, snapshotForUndo, pushUndo, popUndo } from '../src/clients/web/freeformLab.js';
import {
  pickFreeformBrainstormRolls,
  formatFreeformBrainstormRollsForPrompt,
  brainstormFreeformSeeds,
  brainstormFreeformPack,
  repairBrainstormPack,
  normalizeBrainstormCandidate,
  pickPassedBrainstormCandidate,
} from '../src/game/freeformBrainstorm.js';
import {
  splitChronicleHiddenLayer,
  fallbackAssembledStory,
  assembleFreeformLabStory,
} from '../src/game/freeformAssemble.js';
import { startFreeformStory, normalizeSeedVariant } from '../src/game/freeformStarter.js';
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
  { id: 'g', text: 'Хозяин найден.', kind: 'GOOD_ENDING' },
  { id: 'n', text: 'Сапог забыт.', kind: 'NEUTRAL_ENDING' },
  { id: 'b', text: 'Сапог проклял двор.', kind: 'BAD_ENDING' },
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
  } else if (opts.agentId === 'freeformUrgency') {
    await tool.handler({ urgency: 'MEDIUM' });
  }
}

test('freeform — отдельный тип, не трёхтакт', () => {
  const plot = createPlotline({
    title: 'Соль на ветру',
    kind: 'story',
    storyType: 'freeform',
    closeWhen: ['Найти источник соли', 'Признать, что соли нет'],
    hiddenPremises: ['Соль сыплется из разлома края, не из склада.'],
    urgency: 70,
    gravity: 'EPISODE',
  });
  assert.equal(plot.storyType, 'freeform');
  assert.equal(isFreeformPlot(plot), true);
  assert.equal(isThreeActPlot(plot), false);
  assert.equal(storyTypeOf(plot), 'freeform');
  assert.equal(plotBeatAgentId(plot), 'freeformTell');
  assert.deepEqual(plot.closeWhen, ['Найти источник соли', 'Признать, что соли нет']);
  assert.match(formatCloseWhen(plot), /1\. Найти источник соли/);
  assert.equal(plot.urgency, 'FAST');
  assert.ok(plot.hiddenPremises.length);
  assert.equal(plot.act, null);
  assert.equal(plot.depth, 0);
  assert.equal(plot.maxDepth, 3);
  assert.equal(plot.failCount, 0);
  assert.equal(plot.maxFails, 1);
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
    storyType: 'freeform',
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
    storyType: 'freeform',
    gravity: 'EPISODE',
    depth: 0,
    maxDepth: 3,
  });
  assert.equal(plot.depth, 0);
  assert.equal(plot.maxDepth, 3);
  assert.equal(formatFreeformDepth(plot), 'глубина 0/3');
  assert.match(plotCardForPrompt(plot), /глубина 0\/3/);
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

test('судья выбирает номер варианта с 1', () => {
  const parsed = parseFreeformPick({ pick: 3, why: 'живее', repair: '', issues: [] }, 5);
  assert.equal(parsed.pick, 3);
  assert.equal(parseFreeformPick({ pick: 99 }, 3).pick, 1);
});

test('конфиг freeform читается из YAML', () => {
  const cfg = freeformConfig(loadConfig());
  assert.equal(cfg.variantsMin, 3);
  assert.equal(cfg.variantsMax, 3);
  assert.deepEqual(cfg.seedAxes, ['truthArena', 'worldRelation']);
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
  assert.equal(agents.freeformBrainstorm.maxTokens, 8000);
  assert.deepEqual(agents.freeformBrainstorm.canon, ['world']);
  assert.match(agents.freeformBrainstorm.instructions, /затравк/);
  assert.match(agents.freeformBrainstorm.instructions, /нарративн/);
  assert.match(agents.freeformBrainstorm.instructions, /4–5 предложен/);
  assert.match(agents.freeformBrainstorm.instructions, /Судьбоносность/);
  assert.match(agents.freeformBrainstorm.instructions, /Расшифровка выбранного уровня/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /четыре поля|четырьмя полями/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /только к полю «последствия»/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /агент брейншторма/);
  assert.match(agents.freeformBrainstorm.instructions, /бюрократическую путаницу/);
  assert.match(agents.freeformBrainstorm.instructions, /бога-покровителя и верховного жреца/);
  assert.match(agents.freeformBrainstorm.instructions, /наблюдаемый слой/);
  assert.match(agents.freeformBrainstorm.instructions, /записей хроники/);
  assert.match(agents.freeformBrainstorm.instructions, /не обязательно из последней строки/);
  assert.match(agents.freeformBrainstorm.instructions, /будущие и текущие сопряжения/);
  assert.match(agents.freeformBrainstorm.instructions, /threatArena/);
  assert.match(agents.freeformBrainstorm.instructions, /HUMAN —/);
  assert.match(agents.freeformBrainstorm.instructions, /emit_freeform_candidates/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /судья|конструктор|cityBrief|recent_themes|actor_scope/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /позже подставит/);
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
  assert.match(agents.freeformBrainstormJudge.instructions, /локальные метафизические/);
  assert.match(agents.freeformBrainstormJudge.instructions, /submit_freeform_pack_review/);
  assert.match(agents.freeformBrainstormJudge.instructions, /GRAVITY/);
  assert.match(agents.freeformBrainstormJudge.instructions, /COSMOLOGY/);
  assert.match(agents.freeformBrainstormJudge.instructions, /TEMPO/);
  assert.match(agents.freeformBrainstormJudge.instructions, /ECONOMY/);
  assert.match(agents.freeformBrainstormJudge.instructions, /PATRON/);
  assert.match(agents.freeformBrainstormJudge.instructions, /CONFLUX/);
  assert.match(agents.freeformBrainstormJudge.instructions, /Угроза или возможность/);
  assert.match(agents.freeformBrainstormJudge.instructions, /Главный персонаж — сам город/);
  assert.match(agents.freeformBrainstormJudge.instructions, /На самом деле/);
  assert.match(agents.freeformBrainstormJudge.instructions, /верховный жрец/);
  assert.match(agents.freeformBrainstormJudge.instructions, /СОВЕТЫ/);
  assert.match(agents.freeformBrainstormJudge.instructions, /не повод для FAIL/);
  assert.match(agents.freeformBrainstormJudge.instructions, /не обязательно из последней строки/);
  assert.match(agents.freeformBrainstormJudge.instructions, /repair всё равно напиши/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /вход для дела/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /4–5 предложен|Шестое/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /четыре поля|четырьмя полями/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /поле «последствия»/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /хранител|инея|плато|звер(ь|я|ю)|договор.{0,40}остров/);
  assert.doesNotMatch(agents.freeformBrainstormJudge.instructions, /конструктор|cityBrief/);
  const authors = freeformConfig(loadConfig()).continuationAuthors;
  assert.ok(authors.length >= 12);
  assert.equal(new Set(authors.map((a) => a.id)).size, authors.length);
  assert.ok(authors.some((a) => a.name.includes('По')));
  assert.equal(agents.freeformArchitectTell.model, 'claude-haiku-4-5');
  assert.deepEqual(agents.freeformArchitectTell.canon, ['world', 'time']);
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
  assert.deepEqual(agents.freeformAssemble.canon, ['world', 'patron', 'ruler', 'time', 'foreign']);
  assert.match(agents.freeformAssemble.instructions, /submit_freeform_story/);
  assert.match(agents.freeformAssemble.instructions, /whyMoves/);
  assert.match(agents.freeformAssemble.instructions, /На самом деле/);
  assert.doesNotMatch(agents.freeformAssemble.instructions, /depth|countdown|urgency|не ставь/i);
  assert.equal(agents.freeformUrgency.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformUrgency.maxTokens, 400);
  assert.deepEqual(agents.freeformUrgency.canon, ['world']);
  assert.match(agents.freeformUrgency.instructions, /set_freeform_urgency/);
  assert.match(agents.freeformUrgency.instructions, /FAST/);
  assert.doesNotMatch(agents.freeformUrgency.instructions, /\bdepth\b/i);
  assert.equal(agents.freeformEndings.model, 'gpt-5.6-luna');
  assert.deepEqual(agents.freeformEndings.canon, ['world', 'time']);
  assert.match(agents.freeformEndings.instructions, /submit_freeform_endings/);
  assert.match(agents.freeformEndings.instructions, /GOOD_ENDING/);
  assert.equal(agents.freeformBeatJudge.model, 'gpt-5.6-luna');
  assert.match(agents.freeformBeatJudge.instructions, /submit_freeform_pack_review/);
  assert.match(agents.freeformAlign.instructions, /DIRECT/);
  assert.match(agents.freeformAlign.instructions, /endingId/);
});

test('gravity для архитектора — enum и расшифровка уровней', () => {
  const cfg = loadConfig();
  assert.deepEqual(FREEFORM_GRAVITY, ['SITUATION', 'EPISODE', 'CRISIS', 'RUPTURE']);
  assert.equal(parseFreeformGravity('crisis'), 'CRISIS');
  assert.equal(parseFreeformGravity(8), 'SITUATION');
  assert.equal(parseFreeformGravity(40), 'EPISODE');
  assert.equal(parseFreeformGravity(60), 'CRISIS');
  assert.equal(parseFreeformGravity(80), 'RUPTURE');
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

test('пакет судьи карточки — абзац, whyMoves, gravity, без угрозы', () => {
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
      whyMoves: 'Хозяин ищет сапог.',
      closeWhen: ['Найти', 'Бросить'],
      hiddenPremises: [],
      urgency: 40,
    },
    gravity: 'RUPTURE',
  });
  assert.match(text, /Сапог зовёт к створу/);
  assert.match(text, /последствия: Площадь неделю спорит/);
  assert.match(text, /whyMoves: Хозяин ищет сапог/);
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

test('завязка: hiddenPremises по умолчанию пустые, лишние режутся', () => {
  const cfg = freeformConfig(loadConfig());
  const empty = normalizeSeedVariant(
    {
      title: 'Долг за камень',
      synopsis: 'Патроны спорят, платить ли каменотёсам сверх уговора.',
      closeWhen: ['Заплатить', 'Отказать'],
      hiddenPremises: [],
      urgency: 40,
    },
    cfg,
  );
  assert.deepEqual(empty.hiddenPremises, []);
  assert.equal(empty.urgency, undefined);
  const clipped = normalizeSeedVariant(
    {
      title: 'Долг за камень',
      synopsis: 'Патроны спорят, платить ли каменотёсам сверх уговора.',
      closeWhen: ['Заплатить', 'Отказать'],
      hiddenPremises: [
        'Первая тайна достаточно длинная для учёта',
        'Вторая тайна тоже достаточно длинная',
      ],
      urgency: 40,
    },
    cfg,
  );
  assert.deepEqual(clipped.hiddenPremises, ['Первая тайна достаточно длинная для учёта']);
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
      { groupId: 'truthArena', tagName: 'HUMAN' },
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
          whyMoves: 'Пока сапог лежит на площади, хозяин ищет его, а двор держит чужака.',
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
  assert.match(started.winner.whyMoves, /сапог/);
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
  assert.match(architect.user, /1\. \w+ · \w+/);
  assert.match(architect.user, /^threatArena$/m);
  assert.match(architect.user, /^HUMAN — /m);
  assert.match(architect.user, /^worldRelation$/m);
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
  assert.match(ctor.user, /whyMoves/);
  assert.ok(!ctor.required.includes('urgency'));
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
          whyMoves: 'Корень растёт и закрывает сток.',
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
          whyMoves: 'Хозяин ищет сапог.',
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
    storyType: 'freeform',
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
    ['freeformArchitectTell', 'freeformBeatJudge', 'freeformTell', 'freeformEndings', 'freeformUrgency'],
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
    storyType: 'freeform',
    closeWhen: ['Найти хозяина'],
    synopsis: 'На площади нашли сапог.',
  });
  plot.whyMoves = 'Пока сапог лежит, хозяин ищет его дворами.';
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
  assert.match(architect.user, /клонилась к тому/);
  assert.match(architect.user, /Пока сапог лежит, хозяин ищет его дворами/);
  assert.doesNotMatch(architect.user, /whyMoves|Дело:|Поступок:/);
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
    storyType: 'freeform',
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
    storyType: 'freeform',
    gravity: 'SITUATION',
  });
  applyFreeformProgress(sit, { autotick: true });
  assert.equal(sit.failCount, 1);
  assert.equal(freeformTickDecision(sit, { autotick: true }).kind, 'closeBad');
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
    storyType: 'freeform',
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
    storyType: 'freeform',
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

test('жребий завязки — арена и worldRelation из саспенс-аннотаций', () => {
  const tags = pickFreeformSeedAxes(loadConfig(), () => 0);
  assert.equal(tags.length, 2);
  assert.equal(tags[0].groupId, 'truthArena');
  assert.equal(tags[0].tagId, 'human');
  assert.equal(tags[1].groupId, 'worldRelation');
  assert.equal(tags[1].tagId, 'native');
  assert.match(formatFreeformSeedAxesForPrompt(tags), /threatArena: HUMAN/);
  assert.match(formatFreeformSeedAxesForPrompt(tags), /worldRelation: NATIVE/);
  assert.match(formatFreeformSeedAxesForPrompt(tags), /уклад|долг|права/);
  assert.match(formatFreeformSeedAxesForPrompt(tags), /решения|обещания|мода/);
  const contactLine = formatFreeformSeedAxesForPrompt([
    { groupId: 'truthArena', tagName: 'HUMAN' },
    { groupId: 'worldRelation', tagId: 'contact', tagName: 'CONTACT' },
  ]);
  assert.match(contactLine, /привычное вошло/);
  assert.doesNotMatch(contactLine, /прибыл/);
  const pairText = formatFreeformSeedAxisPairsForPrompt([[tags[0], tags[1]]]);
  assert.match(pairText, /1\. HUMAN · NATIVE/);
  assert.match(pairText, /четыре поля/);
  assert.match(pairText, /ассоциативн/);
  const skyOnly = formatFreeformSeedAxisPairsForPrompt([
    [
      { groupId: 'truthArena', tagId: 'sky', tagName: 'SKY' },
      { groupId: 'worldRelation', tagId: 'native', tagName: 'NATIVE' },
    ],
  ]);
  assert.match(skyOnly, /^threatArena$/m);
  assert.match(skyOnly, /^HUMAN — /m);
  assert.match(skyOnly, /существа живущие в небесах/);
  assert.match(skyOnly, /^worldRelation$/m);
  assert.match(skyOnly, /^NATIVE — /m);
  const freeText = formatFreeformSeedAxisPairsForPrompt([
    tags,
    [
      { groupId: 'truthArena', tagId: 'free', tagName: 'FREE' },
      { groupId: 'worldRelation', tagId: 'free', tagName: 'FREE' },
    ],
  ]);
  assert.match(freeText, /2\. FREE · FREE/);
  assert.match(freeText, /вайлдкард/i);
  assert.equal((freeText.match(/FREE · FREE/g) || []).length, 1);
  const pairs = pickFreeformSeedAxisPairs(loadConfig(), 5, () => 0);
  assert.equal(pairs.length, 5);
  const freeSlots = pairs.filter((p) => p[0].tagId === 'free' && p[1].tagId === 'free');
  assert.equal(freeSlots.length, 1);
  assert.ok(pairs.filter((p) => p[0].tagId !== 'free').every((p) => p[0].tagId === 'human' && p[1].tagId === 'native'));
});

test('жребий брейншторма — уникальные conflictSource и temporalShape, один FREE/FREE', () => {
  const cfg = loadConfig();
  const zero = pickFreeformBrainstormRolls(cfg, 3, () => 0);
  assert.equal(zero.length, 3);
  assert.equal(zero.filter((r) => r.pair[0].tagId === 'free' && r.pair[1].tagId === 'free').length, 1);
  assert.equal(zero[0].conflictSource.id, 'EXTERNAL_THREAT');
  assert.equal(zero[0].temporalShape.id, 'FRESH_INCIDENT');
  assert.equal(new Set(zero.map((r) => r.conflictSource.id)).size, 3);
  assert.equal(new Set(zero.map((r) => r.temporalShape.id)).size, 3);
  assert.equal(new Set(zero.map((r) => r.author.id)).size, 3);
  assert.equal(zero[0].author.name, 'Эдгар Аллан По');
  for (let i = 0; i < 20; i += 1) {
    const rolls = pickFreeformBrainstormRolls(cfg, 3);
    assert.equal(new Set(rolls.map((r) => r.conflictSource.id)).size, 3);
    assert.equal(new Set(rolls.map((r) => r.temporalShape.id)).size, 3);
    assert.equal(new Set(rolls.map((r) => r.author.id)).size, 3);
    assert.equal(rolls.filter((r) => r.pair[0].tagId === 'free' && r.pair[1].tagId === 'free').length, 1);
  }
  const text = formatFreeformBrainstormRollsForPrompt(zero);
  assert.match(text, /conflictSource EXTERNAL_THREAT/);
  assert.match(text, /temporalShape FRESH_INCIDENT/);
  assert.match(text, /SYSTEMIC_CRISIS/);
  assert.match(text, /CYCLICAL_PATTERN/);
  assert.match(text, /1\. threatArena FREE · worldRelation FREE · conflictSource EXTERNAL_THREAT · temporalShape FRESH_INCIDENT · автор Эдгар Аллан По/);
  assert.doesNotMatch(text, /не канцелярия|ассоциативн|кликбейт|ориентир|четыре поля|четырьмя полями/);
  const blank = normalizeBrainstormCandidate(
    {
      chronicle: 'На площади нашли сапог, и двор спорит, чей это знак.',
      conflictSource: 'MORAL_DILEMMA',
      temporalShape: 'ALREADY_CLIMAX',
    },
    zero[0],
    1,
  );
  assert.equal(blank.chronicle, 'На площади нашли сапог, и двор спорит, чей это знак.');
  assert.equal(blank.hook, blank.chronicle);
  assert.equal(blank.text, blank.chronicle);
  assert.equal(blank.conflict, undefined);
  assert.equal(blank.conflictSource, 'EXTERNAL_THREAT');
  assert.equal(blank.temporalShape, 'FRESH_INCIDENT');
  assert.equal(blank.authorName, 'Эдгар Аллан По');
  assert.equal(blank.index, 1);
  assert.equal(normalizeBrainstormCandidate({ hook: 'Сапог на площади.' }, zero[0], 2).chronicle, 'Сапог на площади.');
  assert.equal(normalizeBrainstormCandidate({}, zero[0], 1), null);
  const shown = formatBrainstormCandidateForPrompt(blank, 1);
  assert.match(shown, /хроника: На площади нашли сапог/);
  assert.doesNotMatch(shown, /конфликт:|динамика:|последствия:|автор:/);
  assert.match(formatBrainstormCandidateForPrompt(blank, 1, { includeAuthor: true }), /автор: Эдгар Аллан По/);
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
          conflictSource: 'MORAL_DILEMMA',
          temporalShape: 'ALREADY_CLIMAX',
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
    assert.equal(c.conflictSource, drafted.rolls[i].conflictSource.id);
    assert.equal(c.temporalShape, drafted.rolls[i].temporalShape.id);
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
  assert.match(drafted.prompt, /conflictSource/);
  assert.match(drafted.prompt, /temporalShape/);
  const user = String(drafted.prompt.split('=== USER ===')[1] || '').split('=== TOOLS ===')[0];
  assert.match(user, /GRAVITY: RUPTURE/);
  assert.match(user, /ЗАТРАВКА/);
  assert.match(user, /ОСИ/);
  assert.match(user, /На площади нашли чужой сапог/);
  assert.doesNotMatch(user, /не канцелярия|ассоциативн|кликбейт|Верни ровно|emit_freeform_candidates/);
  assert.doesNotMatch(user, /Судьбоносность/);
  assert.doesNotMatch(drafted.prompt, /ЦИСТЕРНЫ/);
  assert.doesNotMatch(drafted.prompt, /ХРОНИКА/);
  assert.doesNotMatch(drafted.prompt, /агент брейншторма/);
  assert.doesNotMatch(drafted.prompt, /судья|конструктор|позже подставит/);
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

test('пачка: два PASS после первого судьи — без правки и второго цикла', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
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
        await tool.handler({
          reviews: [
            {
              index: 1,
              verdict: 'FAIL',
              summary: 'новый закон мира',
              repair: 'убери новый закон, оставь угрозу внутри данного порядка',
              issues: [{ code: 'COSMOLOGY', reason: 'посадка держится на новом законе мира' }],
            },
            { index: 2, verdict: 'PASS', summary: 'держит полосу', repair: 'обостри динамику' },
            { index: 3, verdict: 'PASS', summary: 'держит полосу', repair: '' },
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
  assert.equal(packed.ok, true);
  assert.deepEqual(calls, ['freeformBrainstorm', 'freeformBrainstormJudge']);
  assert.equal(packed.drafts[0].chronicle, 'Хроника сапога 1');
  assert.equal(packed.candidates[0].chronicle, packed.drafts[0].chronicle);
  assert.equal(packed.reviews[0].verdict, 'FAIL');
  assert.equal(packed.reviews[1].verdict, 'PASS');
  assert.equal(packed.finalReviews.length, 0);
  assert.equal(packed.winner.chronicle, 'Хроника сапога 2');
  assert.equal(packed.pickedIndex, 2);
  assert.equal(packed.repairPrompt, '');
  assert.equal(packed.finalJudgePrompt, '');
  assert.match(packed.judgePrompt, /submit_freeform_pack_review/);
  assert.match(packed.judgePrompt, /PATRON/);
  assert.match(packed.judgePrompt, /CONFLUX/);
  assert.doesNotMatch(packed.judgePrompt, /хранител|инея/);
  assert.doesNotMatch(packed.judgePrompt, /автор:/);
  assert.doesNotMatch(packed.judgePrompt, /cityBrief/i);
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
      if (opts.agentId === 'freeformBrainstorm') {
        const isRepair = /ДОРАБОТКА/.test(opts.userMessages?.[0]?.content || '');
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: isRepair ? `Починка ${i}` : `Хроника сапога ${i}`,
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        await tool.handler({
          reviews:
            judgeN === 1
              ? [
                  {
                    index: 1,
                    verdict: 'FAIL',
                    summary: 'новый закон мира',
                    repair: 'убери новый закон',
                    issues: [{ code: 'COSMOLOGY', reason: 'новый закон' }],
                  },
                  {
                    index: 2,
                    verdict: 'FAIL',
                    summary: 'мелко',
                    repair: 'подними посадку',
                    issues: [{ code: 'GRAVITY', reason: 'эпизод' }],
                  },
                  { index: 3, verdict: 'PASS', summary: 'держит полосу', repair: 'обостри' },
                ]
              : [
                  { index: 1, verdict: 'PASS', summary: 'починилось' },
                  { index: 2, verdict: 'FAIL', summary: 'всё ещё мелко' },
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
  assert.deepEqual(calls, ['freeformBrainstorm', 'freeformBrainstormJudge', 'freeformBrainstorm', 'freeformBrainstormJudge']);
  assert.match(packed.repairPrompt, /правка: без изменений/);
  assert.match(packed.repairPrompt, /убери новый закон/);
  assert.equal(packed.candidates[2].chronicle, 'Хроника сапога 3');
  assert.equal(packed.candidates[0].chronicle, 'Починка 1');
  assert.equal(packed.finalReviews[0].verdict, 'PASS');
  assert.equal(packed.finalReviews[1].verdict, 'FAIL');
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
      if (opts.agentId === 'freeformBrainstorm') {
        const isRepair = /ДОРАБОТКА/.test(opts.userMessages?.[0]?.content || '');
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: isRepair ? `Починка ${i}` : `Хроника сапога ${i}`,
          })),
        });
      } else if (opts.agentId === 'freeformBrainstormJudge') {
        judgeN += 1;
        await tool.handler({
          reviews:
            judgeN === 1
              ? [
                  { index: 1, verdict: 'FAIL', repair: 'чини 1', summary: 'дыряво' },
                  { index: 2, verdict: 'PASS', summary: 'держит' },
                  { index: 3, verdict: 'FAIL', repair: 'чини 3', summary: 'мелко' },
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

test('правка пропускается, если судья ничего не просит', async () => {
  const calls = [];
  const drafts = [1, 2, 3].map((i) => ({
    index: i,
    chronicle: `Хроника ${i}`,
    hook: `Хроника ${i}`,
    arena: 'HUMAN',
    worldRelation: 'NATIVE',
    conflictSource: 'EXTERNAL_THREAT',
    temporalShape: 'FRESH_INCIDENT',
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
    conflictSource: 'EXTERNAL_THREAT',
    temporalShape: 'FRESH_INCIDENT',
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

test('лабораторный payload отдаёт затравки без сюжета', () => {
  const payload = sessionPayload({
    mode: 'seeds',
    cityName: 'Грасток',
    world: { tickIndex: 1, gameDate: { year: 1, month: 1 } },
    domain: { name: 'Грасток', lore: [], plotlines: [] },
    lastChronicle: 'На площади нашли чужой сапог и двор его держит.',
    lastGravity: 'RUPTURE',
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

test('из PASS берётся случайный, без PASS победителя нет', () => {
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
  assert.match(fallback.whyMoves, /зовёт/);
  assert.equal(clampFreeformCountdown(0), 1);
  assert.equal(clampFreeformCountdown(9), 8);
  assert.equal(clampFreeformCountdown('3'), 3);
  assert.equal(clampFreeformCountdown('x', 2), 2);
});

test('конструктор собирает хронику, hidden и whyMoves — без countdown-агента', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformAssemble') {
        await tool.handler({
          title: 'Чужой сапог',
          chronicle: 'На площади Грастока двор держит сапог без пары.',
          whyMoves: 'Пока сапог лежит, хозяин ищет его дворами.',
          hiddenPremises: ['Соль сыплется из разлома края, не из склада.'],
        });
      }
    },
  };
  const out = await assembleFreeformLabStory({
    config: loadConfig(),
    runtime,
    domain: { name: 'Грасток', lore: [], plotlines: [] },
    world: { tickIndex: 1, gameDate: { year: 1, month: 1 } },
    candidate: {
      index: 1,
      chronicle: 'Двор держит сапог.\nНа самом деле: соль сыплется из разлома края.',
      arena: 'HUMAN',
      worldRelation: 'NATIVE',
    },
    gravity: 'EPISODE',
  });
  assert.deepEqual(calls, ['freeformAssemble']);
  assert.equal(out.title, 'Чужой сапог');
  assert.match(out.chronicle, /площади/);
  assert.doesNotMatch(out.chronicle, /На самом деле/i);
  assert.match(out.whyMoves, /хозяин/);
  assert.match(out.hiddenPremises[0], /Соль/);
  assert.equal(out.countdown, undefined);
  assert.match(out.assemblePrompt, /submit_freeform_story/);
  assert.doesNotMatch(out.assemblePrompt, /\bdepth\b|countdown|urgency/i);
  const plot = createFreeformPlot({
    domain: { plotlines: [] },
    world: { tickIndex: 1 },
    variant: out,
    config: loadConfig(),
    rng: () => 0,
  });
  assert.equal(plot.storyType, 'freeform');
  assert.equal(plot.urgency, 'MEDIUM');
  assert.equal(plot.countdown, null);
  assert.equal(plot.whyMoves, out.whyMoves);
  assert.equal(plot.arena, 'HUMAN');
  assert.equal(plot.depth, 0);
  assert.equal(plot.maxDepth, 2);
  assert.equal(plot.maxFails, 1);
  assert.equal(formatFreeformDepth(plot), 'глубина 0/2');
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
          whyMoves: 'Хозяин ищет сапог.',
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
