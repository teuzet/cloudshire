import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlotline,
  plotTypeOf,
  plotBeatAgentId,
  pickStoryType,
  isThreeActPlot,
  isStoryPlot,
  isErrandPlot,
  isConfluxPlot,
} from '../src/game/plotlines.js';
import { engagementOf, applyEngagement } from '../src/game/plotAlign.js';

test('посев городской истории — всегда story', () => {
  assert.equal(pickStoryType(), 'story');
});

test('трёхтактных историй больше нет', () => {
  assert.equal(isThreeActPlot({ type: 'story' }), false);
  assert.equal(isThreeActPlot({ type: 'errand' }), false);
  assert.equal(isThreeActPlot({ type: 'conflux' }), false);
});

test('plotline.type — story / errand / conflux', () => {
  const errand = createPlotline({ title: 'Дело', type: 'errand' });
  assert.equal(errand.type, 'errand');
  assert.equal(isErrandPlot(errand), true);
  assert.equal(isStoryPlot(errand), false);

  const order = createPlotline({ title: 'Указ', kind: 'order' });
  assert.equal(order.type, 'story');

  const leaked = createPlotline({ title: 'Стык', type: 'story', confluxId: 'c1' });
  assert.equal(leaked.type, 'story');
  assert.equal(isConfluxPlot(leaked), false);

  const meeting = createPlotline({ title: 'Стык', type: 'conflux' });
  assert.equal(meeting.type, 'conflux');
  assert.equal(isConfluxPlot(meeting), true);
  assert.equal(isStoryPlot(meeting), false);

  const legacyMeeting = createPlotline({
    title: 'Стык',
    kind: 'story',
    isMainConflux: true,
    storyType: 'freeform',
  });
  assert.equal(legacyMeeting.type, 'conflux');

  const city = createPlotline({ title: 'Гул', type: 'story' });
  assert.equal(city.type, 'story');
  assert.equal(isStoryPlot(city), true);
  assert.equal(isConfluxPlot(city), false);

  assert.equal(createPlotline({ title: 'Тайна', kind: 'story', storyType: 'mystery' }).type, 'story');
  assert.equal(createPlotline({ title: 'Саспенс', kind: 'story', storyType: 'suspense' }).type, 'story');
  assert.equal(createPlotline({ title: 'Лаба', kind: 'story', storyType: 'freeform' }).type, 'story');

  assert.equal(plotBeatAgentId({ type: 'errand' }), 'freeformTell');
  assert.equal(plotBeatAgentId({ type: 'conflux' }), 'freeformTell');
  assert.equal(plotBeatAgentId(city), 'freeformTell');
  assert.equal(plotTypeOf({ kind: 'story' }), 'story');
  assert.equal(plotTypeOf({ kind: 'story', storyType: 'freeform' }), 'story');
  assert.equal(plotTypeOf({ kind: 'story', isMainConflux: true }), 'conflux');
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
