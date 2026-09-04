import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlotline,
  storyTypeOf,
  plotBeatAgentId,
  pickStoryType,
  isThreeActPlot,
  isStakedStory,
  isFreeformPlot,
} from '../src/game/plotlines.js';
import { engagementOf, applyEngagement } from '../src/game/plotAlign.js';
import { applySeedVisibility, normalizeTruthGraph, pickFrontierReveal } from '../src/game/mysteryGraph.js';

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
    maxAgeMonths: 6,
    ageMonths: 0,
    temperature: 30,
    status: 'open',
    ...extra,
  };
}

test('посев городской истории — всегда story', () => {
  assert.equal(pickStoryType(), 'story');
});

test('трёхтактных историй больше нет', () => {
  assert.equal(isThreeActPlot(three()), false);
  assert.equal(isThreeActPlot(three({ kind: 'errand' })), false);
  assert.equal(isThreeActPlot(three({ isMainConflux: true })), false);
});

test('story — город со ставками, freeform — главная нить стыка, default — поручение и указ', () => {
  assert.equal(createPlotline({ title: 'Дело', kind: 'errand' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Указ', kind: 'order' }).storyType, 'default');
  assert.equal(createPlotline({ title: 'Стык', kind: 'story', confluxId: 'c1' }).storyType, 'default');
  const meeting = createPlotline({ title: 'Стык', kind: 'story', isMainConflux: true, storyType: 'freeform' });
  assert.equal(meeting.storyType, 'freeform');
  assert.equal(isFreeformPlot(meeting), true);
  assert.equal(isStakedStory(meeting), false);
  assert.equal(createPlotline({ title: 'Старая', kind: 'story' }).storyType, 'default');
  const city = createPlotline({ title: 'Гул', kind: 'story', storyType: 'story' });
  assert.equal(city.storyType, 'story');
  assert.equal(isStakedStory(city), true);
  assert.equal(isFreeformPlot(city), false);
  assert.equal(createPlotline({ title: 'Тайна', kind: 'story', storyType: 'mystery' }).storyType, 'story');
  assert.equal(createPlotline({ title: 'Саспенс', kind: 'story', storyType: 'suspense' }).storyType, 'story');
  assert.equal(createPlotline({ title: 'Лаба', kind: 'story', storyType: 'freeform' }).storyType, 'story');
  assert.equal(plotBeatAgentId({ kind: 'errand' }), 'storyBeat');
  assert.equal(plotBeatAgentId({ kind: 'story', isMainConflux: true }), 'storyBeat');
  assert.equal(plotBeatAgentId(city), 'freeformTell');
  assert.equal(storyTypeOf({ kind: 'story' }), 'default');
  assert.equal(storyTypeOf({ kind: 'story', storyType: 'freeform' }), 'story');
  assert.equal(storyTypeOf({ kind: 'story', isMainConflux: true }), 'freeform');
});

test('plotAlign: старый boolean и безопасный default', () => {
  assert.equal(engagementOf({ plotEngagement: 'RELEVANT' }), 'RELEVANT');
  assert.equal(engagementOf({ plotAligned: true }), 'DIRECT');
  assert.equal(engagementOf({ plotAligned: false }), 'RELEVANT');
  assert.equal(engagementOf({}), null);
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
