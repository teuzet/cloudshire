import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStoryActMove,
  escalationWouldFail,
  formatActMoveForPrompt,
} from '../src/game/storyActs.js';
import {
  isThreeActPlot,
  plotCanFade,
  plotHasAttendingProcess,
  judgePlotSeed,
  formatBoardForPrompt,
  stripPlotSecrets,
  pickStoryType,
  plotConfig,
  createPlotline,
  storyTypeOf,
  plotBeatAgentId,
} from '../src/game/plotlines.js';
import { planBeats } from '../src/game/plotEngine.js';
import { beatChance } from '../src/game/rolls.js';
import { engagementOf, applyEngagement } from '../src/game/plotAlign.js';
import { applySeedVisibility, normalizeTruthGraph, pickFrontierReveal } from '../src/game/mysteryGraph.js';

const SEED_PAD = 'Дальше история должна жить своей жизнью и не обрываться на полуслове. '.repeat(4);

function mysteryGraph(extra = {}) {
  return {
    nodes: [
      { id: 'A', text: 'Цистерну перестали чистить.' },
      { id: 'B', text: 'В трубах скопился ил.' },
      { id: 'C', text: 'Ночами вода гудит.' },
      { id: 'X', text: 'Нижний ярус слышит гул как знамение.' },
    ],
    edges: [
      { from: 'A', to: 'B', reason: 'без чистки ил растёт' },
      { from: 'B', to: 'C', reason: 'ил сжимает поток' },
      { from: 'C', to: 'X', reason: 'гул доходит до яруса' },
    ],
    ...extra,
  };
}

function seededMystery() {
  return applySeedVisibility(normalizeTruthGraph(mysteryGraph()), { shape: 'linear_4' });
}

const ACTS = { acts: { maxEscalations: 3, worsenMin: 1.1, worsenMax: 1.1, dampMin: 0.9, dampMax: 0.9 } };
const maxRng = () => 1;
const minRng = () => 0;

function three(extra = {}) {
  return {
    id: 'plot_1',
    title: 'Гул в цистерне',
    synopsis: 'В нижней цистерне ночами гудит вода.',
    closeWhen: 'Найдут источник гула.',
    kind: 'story',
    storyType: 'suspense',
    act: 1,
    urgency: 40,
    gravity: 40,
    urgency0: 40,
    gravity0: 40,
    escalationLevel: 0,
    maxEscalations: 3,
    relatedProcessIds: [],
    relatedStats: ['security'],
    tags: [],
    chronicleIds: [],
    relatedPlotlineIds: [],
    importance: 40,
    maxAgeMonths: 6,
    ageMonths: 0,
    temperature: 30,
    status: 'open',
    ...extra,
  };
}

test('тип истории: половина тайна, половина саспенс', () => {
  assert.equal(pickStoryType(() => 0), 'mystery');
  assert.equal(pickStoryType(() => 0.5), 'suspense');
});

test('трёхтактными не бывают указы, поручения и главная нить стыка', () => {
  assert.equal(isThreeActPlot(three()), true);
  assert.equal(isThreeActPlot(three({ kind: 'errand' })), false);
  assert.equal(isThreeActPlot(three({ shared: true })), true);
  assert.equal(isThreeActPlot(three({ confluxId: 'c1' })), true);
  assert.equal(isThreeActPlot(three({ isMainConflux: true })), false);
  assert.equal(isThreeActPlot({ kind: 'story', title: 'старая' }), false);
});

test('движок ставит default поручениям, указам, главной нити стыка и наследию', () => {
  assert.equal(createPlotline({ title: 'Дело', kind: 'errand' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Указ', kind: 'order' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Стык', kind: 'story', confluxId: 'c1' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Стык', kind: 'story', isMainConflux: true }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Общая', kind: 'story', shared: true, storyType: 'suspense' }).storyType, 'suspense');
  assert.equal(createPlotline({ title: 'Старая', kind: 'story' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Гул', kind: 'story', storyType: 'suspense' }).storyType, 'suspense');
  assert.equal(createPlotline({ title: 'Тайна', kind: 'story', storyType: 'mystery' }).storyType, 'mystery');
  assert.equal(createPlotline({ title: 'Свободная', kind: 'story', storyType: 'freeform' }).storyType, 'freeform');
  assert.equal(plotBeatAgentId({ kind: 'errand' }), 'storyBeat');
  assert.equal(plotBeatAgentId({ kind: 'story', isMainConflux: true }), 'storyBeat');
  assert.equal(plotBeatAgentId(three()), 'suspenseBeat');
  assert.equal(plotBeatAgentId(three({ storyType: 'mystery' })), 'mysteryBeat');
  assert.equal(plotBeatAgentId(three({ confluxId: 'c1' })), 'suspenseBeat');
  assert.equal(plotBeatAgentId({ kind: 'story', storyType: 'freeform' }), 'freeformTell');
  assert.equal(storyTypeOf({ kind: 'story' }), 'default');
  assert.equal(storyTypeOf({ kind: 'story', storyType: 'freeform' }), 'freeform');
});

test('саспенс такт 1: холостой тик остаётся в экспозиции и эскалирует', () => {
  const plot = three();
  const move = applyStoryActMove(plot, { trigger: 'auto', rng: minRng, config: ACTS });
  assert.equal(plot.act, 1);
  assert.ok(!plot.ending);
  assert.equal(move.stakes.kind, 'worsen');
  assert.equal(plot.escalationLevel, 1);
  assert.equal(plot.urgency, 44);
  assert.equal(plot.gravity, 40);
});

test('саспенс такт 1: DIRECT крит сразу закрывает', () => {
  const plot = three();
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'crit',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.ending, 'crit');
  assert.equal(plot.ending, 'crit');
  assert.equal(plot.act, 1);
  assert.equal(plot.escalationLevel, 0);
});

test('саспенс такт 1: DIRECT успех при depth 2 идёт во второй такт без эскалации', () => {
  const plot = three({
    depth: 2,
    closureUnlocked: false,
    discoveryLadder: [
      { id: 'a', promise: 'первый слой', revealed: false },
      { id: 'b', promise: 'второй слой', revealed: false },
    ],
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'ok',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(plot.act, 2);
  assert.ok(!plot.ending);
  assert.equal(move.pressure, 'NONE');
  assert.equal(plot.escalationLevel, 0);
  assert.equal(plot.urgency, 40);
});

test('саспенс такт 2: DIRECT успех закрывает', () => {
  const plot = three({ act: 2 });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'ok',
    config: ACTS,
  });
  assert.equal(move.ending, 'ok');
  assert.equal(plot.ending, 'ok');
  assert.equal(move.actTo, 3);
});

test('саспенс: UNRELATED крит гасит urgency и ступень, gravity не трогает', () => {
  const plot = three({ act: 2, escalationLevel: 2 });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'UNRELATED',
    finish: 'crit',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.ending, null);
  assert.ok(!plot.ending);
  assert.equal(plot.act, 2);
  assert.equal(move.stakes.kind, 'damp');
  assert.equal(plot.escalationLevel, 1);
  assert.equal(plot.urgency, 36);
  assert.equal(plot.gravity, 40);
});

test('третья эскалация закрывает провалом; gravity не растёт', () => {
  const plot = three({ act: 1, urgency: 80, gravity: 80, escalationLevel: 2 });
  assert.equal(escalationWouldFail(plot, ACTS), true);
  applyStoryActMove(plot, { trigger: 'auto', rng: maxRng, config: ACTS });
  assert.equal(plot.ending, 'fail');
  assert.equal(plot.escalationLevel, 3);
  assert.equal(plot.urgency, 88);
  assert.equal(plot.gravity, 80);
  assert.equal(plot.act, 1);
});

test('саспенс depth 3: DIRECT крит в такте 1 идёт во второй такт и закрывает одну ступень', () => {
  const plot = three({
    depth: 3,
    closureUnlocked: false,
    discoveryLadder: [
      { id: 'cold_source', promise: 'откуда холод', revealed: false },
      { id: 'shaft', promise: 'искусственная шахта', revealed: false },
      { id: 'chamber', promise: 'камера', revealed: false },
    ],
    hiddenPremises: [
      'Холод идёт из древней шахты.',
      'Стены выровнены инструментом.',
      'За затвором техническая камера.',
    ],
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'crit',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.ending, null);
  assert.ok(!plot.ending);
  assert.equal(plot.act, 2);
  assert.equal(move.progress, 'BREAKTHROUGH');
  assert.deepEqual(move.openedLadder, ['cold_source']);
  assert.equal(plot.discoveryLadder[0].revealed, true);
  assert.equal(plot.discoveryLadder[1].revealed, false);
  assert.equal(plot.closureUnlocked, false);
  assert.equal(plot.gravity, 40);
});

test('саспенс depth 1: DIRECT успех сразу закрывает', () => {
  const plot = three({ depth: 1 });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'ok',
    config: ACTS,
  });
  assert.equal(move.ending, 'ok');
  assert.equal(plot.ending, 'ok');
});

test('саспенс depth 1: RELEVANT успех в такте 2 закрывает', () => {
  const plot = three({ depth: 1, act: 2, closureUnlocked: true });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'RELEVANT',
    finish: 'ok',
    config: ACTS,
  });
  assert.equal(move.ending, 'ok');
  assert.equal(plot.ending, 'ok');
});

test('эскалация тайны и саспенса не трогает gravity, urgency +10%', () => {
  const plot = three({
    storyType: 'mystery',
    truthGraph: seededMystery(),
    urgency: 40,
    gravity: 40,
  });
  applyStoryActMove(plot, { trigger: 'auto', rng: minRng, config: ACTS });
  assert.equal(plot.gravity, 40);
  assert.equal(plot.urgency, 44);
  applyStoryActMove(plot, { trigger: 'auto', rng: maxRng, config: ACTS });
  assert.equal(plot.gravity, 40);
  assert.equal(plot.urgency, 48);
});

test('тайна такт 1: DIRECT успех открывает ближайший к концу узел и идёт во второй такт', () => {
  const plot = three({
    storyType: 'mystery',
    truthGraph: seededMystery(),
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'ok',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(plot.act, 2);
  assert.equal(move.reveal, 'partial');
  assert.deepEqual(move.openedNodes, ['C']);
  assert.ok(!plot.ending);
  assert.equal(plot.escalationLevel, 0);
  assert.equal(plot.truthGraph.nodes.find((n) => n.id === 'C').knowledge, 'hidden');
});

test('тайна: DIRECT провал открывает фронтир и поднимает urgency, gravity та же', () => {
  const plot = three({
    storyType: 'mystery',
    truthGraph: seededMystery(),
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'fail',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.reveal, 'partial');
  assert.deepEqual(move.openedNodes, ['C']);
  assert.equal(move.pressure, 'ESCALATE');
  assert.ok(!plot.ending);
  assert.equal(plot.escalationLevel, 1);
  assert.equal(plot.urgency, 44);
  assert.equal(plot.gravity, 40);
  assert.equal(plot.act, 1);
});

test('тайна: DIRECT провал на последнем узле разгадывает дорогой ценой', () => {
  const graph = seededMystery();
  graph.nodes.find((n) => n.id === 'C').knowledge = 'observed';
  graph.nodes.find((n) => n.id === 'B').knowledge = 'observed';
  const plot = three({
    storyType: 'mystery',
    act: 2,
    truthGraph: graph,
    escalationLevel: 2,
    urgency: 80,
    gravity: 70,
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'fail',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.reveal, 'full');
  assert.equal(move.ending, 'ok');
  assert.equal(plot.ending, 'ok');
  assert.equal(move.costlySolve, true);
  assert.equal(move.pressure, 'NONE');
  assert.deepEqual(move.openedNodes, ['A']);
  assert.equal(plot.escalationLevel, 2);
  assert.equal(plot.gravity, 70);
  assert.equal(plot.urgency, 80);
});

test('тайна: DIRECT провал на последней эскалации закрывает, но узел остаётся открытым', () => {
  const plot = three({
    storyType: 'mystery',
    truthGraph: seededMystery(),
    escalationLevel: 2,
    urgency: 80,
    gravity: 70,
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'DIRECT',
    finish: 'fail',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(plot.ending, 'fail');
  assert.equal(move.reveal, 'partial');
  assert.deepEqual(move.openedNodes, ['C']);
  assert.equal(plot.gravity, 70);
  assert.equal(plot.urgency, 88);
});

test('тайна: RELEVANT успех открывает фронтир, остаётся в акте 1 и эскалирует', () => {
  const plot = three({
    storyType: 'mystery',
    truthGraph: seededMystery(),
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'RELEVANT',
    finish: 'ok',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(plot.act, 1);
  assert.equal(move.reveal, 'partial');
  assert.deepEqual(move.openedNodes, ['C']);
  assert.equal(plot.escalationLevel, 1);
  assert.ok(!plot.ending);
});

test('тайна: последний скрытый узел закрывает сюжет', () => {
  const graph = seededMystery();
  graph.nodes.find((n) => n.id === 'C').knowledge = 'observed';
  graph.nodes.find((n) => n.id === 'B').knowledge = 'observed';
  const plot = three({
    storyType: 'mystery',
    act: 2,
    truthGraph: graph,
  });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    relation: 'RELEVANT',
    finish: 'ok',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.reveal, 'full');
  assert.equal(move.ending, 'ok');
  assert.deepEqual(move.openedNodes, ['A']);
  assert.equal(plot.escalationLevel, 0);
});

test('трёхтактная нить не гаснет по сроку', () => {
  const plot = three({ ageMonths: 12, maxAgeMonths: 5, temperature: 0 });
  assert.equal(plotCanFade({ plotlines: [plot], state: { pendingActions: [] } }, plot), false);
});

test('план битов: DIRECT/RELEVANT дело глушит холостой тик, UNRELATED — нет', () => {
  const attending = three({ id: 'p_busy', relatedProcessIds: ['act_1'] });
  const { beats: blocked } = planBeats({
    domain: {
      plotlines: [attending],
      state: { pendingActions: [{ id: 'act_1', status: 'active', plotEngagement: 'DIRECT' }] },
    },
    rng: minRng,
  });
  assert.equal(blocked.length, 0);

  const side = three({ id: 'p_side', relatedProcessIds: ['act_2'] });
  const domain = {
    plotlines: [side],
    state: { pendingActions: [{ id: 'act_2', status: 'active', plotEngagement: 'UNRELATED' }] },
  };
  const { beats: open } = planBeats({ domain, rng: minRng });
  assert.ok(open.find((b) => b.reason === 'auto'));
  assert.equal(domain.plotlines[0].act, 1);
  assert.equal(plotHasAttendingProcess(domain, side), false);
});

test('план битов: пауза дела не держит холостой тик', () => {
  const plot = three({ id: 'p_pause', relatedProcessIds: ['act_1'] });
  const domain = {
    plotlines: [plot],
    state: { pendingActions: [{ id: 'act_1', status: 'paused', plotEngagement: 'DIRECT' }] },
  };
  const { beats } = planBeats({ domain, rng: minRng });
  const auto = beats.find((b) => b.reason === 'auto');
  assert.ok(auto);
  assert.equal(auto.skipTint, true);
  assert.equal(domain.plotlines[0].act, 1);
});

test('план битов: финиш дела прыгает по тактам, stall — нет', () => {
  const finishDomain = {
    plotlines: [three({ id: 'p_fin', relatedProcessIds: ['act_fin'] })],
    state: { pendingActions: [] },
  };
  const { beats: finishBeats } = planBeats({
    domain: finishDomain,
    processOutcomes: [
      {
        processId: 'act_fin',
        summary: 'Найти источник',
        mustNarrate: true,
        finished: true,
        finish: 'crit',
        plotEngagement: 'DIRECT',
      },
    ],
    rng: () => 1,
  });
  assert.equal(finishBeats[0].reason, 'process_finished');
  assert.equal(finishBeats[0].actMove.ending, 'crit');
  assert.equal(finishDomain.plotlines[0].ending, 'crit');

  const stallDomain = {
    plotlines: [three({ id: 'p_stall', relatedProcessIds: ['act_stall'] })],
    state: { pendingActions: [{ id: 'act_stall', status: 'active', plotEngagement: 'DIRECT' }] },
  };
  const { beats: stallBeats } = planBeats({
    domain: stallDomain,
    processOutcomes: [
      {
        processId: 'act_stall',
        summary: 'Найти источник',
        mustNarrate: true,
        finished: false,
        kind: 'stall',
      },
    ],
    rng: minRng,
  });
  assert.equal(stallBeats[0].reason, 'process_stall');
  assert.equal(stallBeats[0].actMove, null);
  assert.equal(stallDomain.plotlines[0].act, 1);
  assert.ok(!stallDomain.plotlines[0].ending);
});

test('шанс холостого тика берётся из urgency', () => {
  const cfg = plotConfig();
  assert.equal(beatChance(three({ urgency: 80 }), cfg), 0.8);
});

test('завязка тайны без графа не проходит', () => {
  const draft = {
    title: 'Ночной гул',
    entry: 'В цистерне гудело.',
    synopsis: `${SEED_PAD} В нижней цистерне ночами гудит вода, и никто не знает откуда.`,
  };
  assert.equal(judgePlotSeed({ plotlines: [] }, draft, { storyType: 'mystery' }), 'missing_graph');
  assert.equal(
    judgePlotSeed({ plotlines: [] }, { ...draft, ...mysteryGraph() }, { storyType: 'mystery' }),
    null,
  );
  assert.equal(judgePlotSeed({ plotlines: [] }, draft), null);
});

test('разгадка не попадает на доску и снимается с публичной карточки', () => {
  const plot = three({
    storyType: 'mystery',
    truth: 'это был садовник',
    truthGraph: mysteryGraph(),
    observedFacts: ['Нижний ярус слышит гул как знамение.'],
    resolutionFacts: ['Почему цистерну перестали чистить'],
  });
  const board = formatBoardForPrompt({ plotlines: [plot] });
  assert.equal(board.includes('садовник'), false);
  assert.equal(board.includes('Цистерну перестали чистить'), false);
  assert.match(board, /тип=mystery/);
  const publicCard = stripPlotSecrets(plot);
  assert.equal(publicCard.truth, undefined);
  assert.equal(publicCard.truthGraph, undefined);
  assert.equal(publicCard.resolutionFacts, undefined);
  assert.deepEqual(publicCard.observedFacts, ['Нижний ярус слышит гул как знамение.']);
  assert.equal(publicCard.title, plot.title);
});

test('тактовка для бита говорит закрывать только когда движок решил концовку', () => {
  const plot = three({ act: 2, ending: 'ok' });
  const text = formatActMoveForPrompt(plot, {
    actFrom: 2,
    actTo: 3,
    ending: 'ok',
    reveal: 'none',
    pressure: 'NONE',
    relation: 'DIRECT',
    finish: 'ok',
    trigger: 'process_finished',
    openedNodes: [],
    openedEdges: [],
    stakes: { kind: 'none', before: { urgency: 40, gravity: 40 }, after: { urgency: 40, gravity: 40 } },
  });
  assert.match(text, /КОНЦОВКА УЖЕ РЕШЕНА/);
  assert.match(text, /\[УСПЕХ\]/);
  assert.match(text, /фаза: 2 → 3/);
});

test('тактовка: DIRECT-провал на разгадке требует жертв, репутации и экономического урона', () => {
  const plot = three({ storyType: 'mystery', act: 2, ending: 'ok' });
  const text = formatActMoveForPrompt(plot, {
    actFrom: 2,
    actTo: 3,
    ending: 'ok',
    reveal: 'full',
    pressure: 'NONE',
    relation: 'DIRECT',
    finish: 'fail',
    costlySolve: true,
    trigger: 'process_finished',
    openedNodes: ['A'],
    openedEdges: [],
    stakes: { kind: 'none', before: { urgency: 80, gravity: 70 }, after: { urgency: 80, gravity: 70 } },
  });
  assert.match(text, /дорогой ценой/);
  assert.match(text, /жертвы среди населения/);
  assert.match(text, /репутационн/);
  assert.match(text, /экономическ/);
});

test('plotAlign: старый boolean и безопасный default', () => {
  assert.equal(engagementOf({ plotEngagement: 'RELEVANT' }), 'RELEVANT');
  assert.equal(engagementOf({ plotAligned: true }), 'DIRECT');
  assert.equal(engagementOf({ plotAligned: false }), 'RELEVANT');
  assert.equal(engagementOf({}), 'UNRELATED');
  const p = {};
  assert.equal(applyEngagement(p, 'DIRECT'), 'DIRECT');
  assert.equal(p.plotAligned, true);
  assert.equal(applyEngagement(p, 'nope'), 'UNRELATED');
  assert.equal(p.plotAligned, false);
});

test('фронтир тайны идёт от конца цепи', () => {
  const g = seededMystery();
  assert.equal(pickFrontierReveal(g, minRng).nodeId, 'C');
  g.nodes.find((n) => n.id === 'C').knowledge = 'observed';
  assert.equal(pickFrontierReveal(g, minRng).nodeId, 'B');
});
