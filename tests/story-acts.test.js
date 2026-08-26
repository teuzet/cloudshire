import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStoryActMove,
  stakesExceeded,
  formatActMoveForPrompt,
} from '../src/game/storyActs.js';
import {
  isThreeActPlot,
  plotCanFade,
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

const SEED_PAD = 'Дальше история должна жить своей жизнью и не обрываться на полуслове. '.repeat(4);

function mysteryGraph(extra = {}) {
  return {
    nodes: [
      { id: 'A', text: 'Цистерну перестали чистить.' },
      { id: 'B', text: 'В трубах скопился ил.' },
      { id: 'C', text: 'Ночами вода гудит.' },
      { id: 'D', text: 'Нижний ярус слышит гул как знамение.' },
    ],
    edges: [
      { from: 'A', to: 'B', reason: 'без чистки ил растёт' },
      { from: 'B', to: 'C', reason: 'ил сжимает поток' },
    ],
    knowledge: [
      { id: 'A', status: 'hidden' },
      { id: 'B', status: 'hidden' },
      { id: 'C', status: 'observed' },
      { id: 'D', status: 'observed' },
    ],
    ...extra,
  };
}
const ACTS = { acts: { failMultiplier: 2, worsenMin: 1, worsenMax: 1.5, dampMin: 0.8, dampMax: 1 } };
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
    relatedProcessIds: [],
    relatedStats: ['stability'],
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

test('трёхтактными не бывают указы, поручения и сопряжение', () => {
  assert.equal(isThreeActPlot(three()), true);
  assert.equal(isThreeActPlot(three({ kind: 'errand' })), false);
  assert.equal(isThreeActPlot(three({ shared: true })), false);
  assert.equal(isThreeActPlot(three({ confluxId: 'c1' })), false);
  assert.equal(isThreeActPlot(three({ isMainConflux: true })), false);
  assert.equal(isThreeActPlot({ kind: 'story', title: 'старая' }), false);
});

test('движок ставит default поручениям, указам, сопряжению и наследию', () => {
  assert.equal(createPlotline({ title: 'Дело', kind: 'errand' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Указ', kind: 'order' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Стык', kind: 'story', confluxId: 'c1' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Стык', kind: 'story', isMainConflux: true }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Общая', kind: 'story', shared: true, storyType: 'suspense' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Старая', kind: 'story' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Гул', kind: 'story', storyType: 'suspense' }).storyType, 'suspense');
  assert.equal(createPlotline({ title: 'Тайна', kind: 'story', storyType: 'mystery' }).storyType, 'mystery');
  assert.equal(plotBeatAgentId({ kind: 'errand' }), 'storyBeat');
  assert.equal(plotBeatAgentId({ kind: 'story', isMainConflux: true }), 'storyBeat');
  assert.equal(plotBeatAgentId(three()), 'suspenseBeat');
  assert.equal(plotBeatAgentId(three({ storyType: 'mystery' })), 'mysteryBeat');
  assert.equal(storyTypeOf({ kind: 'story' }), 'default');
});

test('саспенс такт 1: холостой тик → такт 2 и worsen', () => {
  const plot = three();
  const move = applyStoryActMove(plot, { trigger: 'auto', rng: minRng, config: ACTS });
  assert.equal(plot.act, 2);
  assert.ok(!plot.ending);
  assert.equal(move.stakes.kind, 'worsen');
  assert.equal(plot.urgency, 40);
});

test('саспенс такт 1: сопряжённый крит сразу закрывает', () => {
  const plot = three();
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    aligned: true,
    finish: 'crit',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.ending, 'crit');
  assert.equal(plot.ending, 'crit');
  assert.equal(plot.act, 1);
});

test('саспенс такт 2: сопряжённый успех закрывает', () => {
  const plot = three({ act: 2 });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    aligned: true,
    finish: 'ok',
    config: ACTS,
  });
  assert.equal(move.ending, 'ok');
  assert.equal(plot.ending, 'ok');
  assert.equal(plot.act, 2);
});

test('саспенс такт 2: несопряжённый крит гасит ставки, такт тот же', () => {
  const plot = three({ act: 2 });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    aligned: false,
    finish: 'crit',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(move.ending, null);
  assert.ok(!plot.ending);
  assert.equal(plot.act, 2);
  assert.equal(move.stakes.kind, 'damp');
  assert.equal(plot.urgency, 32);
  assert.equal(plot.gravity, 32);
});

test('ставки: оба параметра в X раз от старта → провал', () => {
  const plot = three({ act: 2 });
  applyStoryActMove(plot, { trigger: 'auto', rng: maxRng, config: ACTS });
  assert.ok(!plot.ending);
  assert.equal(stakesExceeded(plot, ACTS), false);
  applyStoryActMove(plot, { trigger: 'auto', rng: maxRng, config: ACTS });
  assert.equal(plot.urgency, 90);
  assert.equal(plot.gravity, 90);
  assert.equal(plot.ending, 'fail');
  assert.equal(stakesExceeded(plot, ACTS), true);
});

test('тайна такт 1: сопряжённый успех частично открывает и идёт во второй такт', () => {
  const plot = three({ storyType: 'mystery', truth: 'это был садовник' });
  const move = applyStoryActMove(plot, {
    trigger: 'process_finished',
    aligned: true,
    finish: 'ok',
    rng: minRng,
    config: ACTS,
  });
  assert.equal(plot.act, 2);
  assert.equal(move.reveal, 'partial');
  assert.ok(!plot.ending);
});

test('трёхтактная нить не гаснет по сроку', () => {
  const plot = three({ ageMonths: 12, maxAgeMonths: 5, temperature: 0 });
  assert.equal(plotCanFade({ plotlines: [plot], state: { pendingActions: [] } }, plot), false);
});

test('план битов: трёхтактная с активным делом не тикает сама', () => {
  const plot = three({ id: 'p_busy', relatedProcessIds: ['act_1'] });
  const { beats } = planBeats({
    domain: {
      plotlines: [plot],
      state: { pendingActions: [{ id: 'act_1', status: 'active' }] },
    },
    rng: minRng,
  });
  assert.equal(beats.length, 0);
  assert.equal(plot.act, 1);
});

test('план битов: пауза дела не держит холостой тик', () => {
  const plot = three({ id: 'p_pause', relatedProcessIds: ['act_1'] });
  const domain = {
    plotlines: [plot],
    state: { pendingActions: [{ id: 'act_1', status: 'paused' }] },
  };
  const { beats } = planBeats({ domain, rng: minRng });
  const auto = beats.find((b) => b.reason === 'auto');
  assert.ok(auto);
  assert.equal(auto.skipTint, true);
  assert.equal(domain.plotlines[0].act, 2);
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
        plotAligned: true,
      },
    ],
    rng: () => 1,
  });
  assert.equal(finishBeats[0].reason, 'process_finished');
  assert.equal(finishBeats[0].actMove.ending, 'crit');
  assert.equal(finishDomain.plotlines[0].ending, 'crit');

  const stallDomain = {
    plotlines: [three({ id: 'p_stall', relatedProcessIds: ['act_stall'] })],
    state: { pendingActions: [{ id: 'act_stall', status: 'active' }] },
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
  });
  const board = formatBoardForPrompt({ plotlines: [plot] });
  assert.equal(board.includes('садовник'), false);
  assert.equal(board.includes('Цистерну перестали чистить'), false);
  assert.match(board, /тип=mystery/);
  const publicCard = stripPlotSecrets(plot);
  assert.equal(publicCard.truth, undefined);
  assert.equal(publicCard.truthGraph, undefined);
  assert.equal(publicCard.title, plot.title);
});

test('тактовка для бита говорит закрывать только когда движок решил концовку', () => {
  const plot = three({ act: 2, ending: 'ok' });
  const text = formatActMoveForPrompt(plot, {
    actFrom: 2,
    ending: 'ok',
    stakes: { kind: 'none', before: { urgency: 40, gravity: 40 }, after: { urgency: 40, gravity: 40 } },
  });
  assert.match(text, /КОНЦОВКА УЖЕ РЕШЕНА/);
  assert.match(text, /\[УСПЕХ\]/);
});
