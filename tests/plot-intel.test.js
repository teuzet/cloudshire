import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlotline } from '../src/game/plotlines.js';
import { createLoreFact } from '../src/game/models.js';
import {
  sharePlotWithDomain,
  isContested,
  isSharedPlot,
  overlayConfluxView,
  returnBoardsOnUndock,
} from '../src/game/confluxBoard.js';

function domain(id, extra = {}) {
  return {
    id,
    name: id,
    plotlines: extra.plotlines || [],
    closedPlotlines: [],
    lore: extra.lore || [],
    state: { pendingActions: extra.processes || [] },
    stats: {},
  };
}

function conflux(extra = {}) {
  return {
    id: 'conflux_1',
    domainIds: ['a', 'b'],
    status: extra.status || 'docked',
    plotlines: extra.plotlines || [],
    closedPlotlines: [],
    processes: extra.processes || [],
    lore: extra.lore || [],
    etaMonths: 6,
    durationMonths: 3,
    ...extra,
  };
}

test('sourcePlotId ставится с relatedPlotlineIds', () => {
  const fact = createLoreFact({
    id: 'lore_x',
    text: 'В храме гаснет свет.',
    tags: ['chronicle'],
    relatedPlotlineIds: ['plot_1'],
  });
  assert.equal(fact.sourcePlotId, 'plot_1');
});

test('intel не добавляет concerns и не делает contested', () => {
  const plot = createPlotline({ title: 'Храм', kind: 'story', hostDomainId: 'b' });
  plot.hostDomainId = 'b';
  plot.concernsDomainIds = ['b'];
  plot.relatedProcessIds = ['act_intel', 'act_host'];
  const c = conflux({
    plotlines: [plot],
    processes: [
      { id: 'act_intel', ownerDomainId: 'a', status: 'active', intel: true },
      { id: 'act_host', ownerDomainId: 'b', status: 'active', intel: false },
    ],
  });
  assert.equal(isSharedPlot(plot), false);
  assert.equal(isContested(plot, c), false);
  assert.deepEqual(plot.concernsDomainIds, ['b']);
});

test('два non-intel дела разных городов → contested', () => {
  const plot = createPlotline({ title: 'Храм', kind: 'story', hostDomainId: 'b' });
  plot.hostDomainId = 'b';
  plot.concernsDomainIds = ['a', 'b'];
  plot.shared = true;
  plot.relatedProcessIds = ['act_a', 'act_b'];
  const c = conflux({
    plotlines: [plot],
    processes: [
      { id: 'act_a', ownerDomainId: 'a', status: 'active' },
      { id: 'act_b', ownerDomainId: 'b', status: 'active' },
    ],
  });
  assert.equal(isContested(plot, c), true);
});

test('не-intel вмешательство шарит нить, карточку соседу не показывает', () => {
  const plot = createPlotline({ title: 'Храм', kind: 'story' });
  plot.concernsDomainIds = ['b'];
  plot.hostDomainId = 'b';
  sharePlotWithDomain(plot, 'a', { reason: 'process' });
  assert.equal(isSharedPlot(plot), true);
  assert.ok(plot.concernsDomainIds.includes('a'));
  const c = conflux({ plotlines: [plot] });
  const a = domain('a');
  overlayConfluxView(a, c);
  assert.equal(a.plotlines.some((p) => p.id === plot.id), false);
});

test('расстыковка не отдаёт чужую нить; общая остаётся у хозяина', async () => {
  const hidden = createPlotline({ title: 'Секрет', kind: 'story' });
  hidden.hostDomainId = 'a';
  hidden.concernsDomainIds = ['a'];
  hidden.relatedProcessIds = [];
  const known = createPlotline({ title: 'Мост', kind: 'story' });
  known.hostDomainId = 'a';
  known.concernsDomainIds = ['a', 'b'];
  known.shared = true;
  const a = domain('a', { plotlines: [hidden, known] });
  const b = domain('b');
  const c = conflux();
  await returnBoardsOnUndock(c, new Map([['a', a], ['b', b]]), {
    decideContinuation: async ({ plot, domainId }) => plot.title === 'Мост' && domainId === 'b',
  });
  assert.equal(a.plotlines.some((p) => p.title === 'Секрет'), true);
  assert.equal(b.plotlines.some((p) => p.title === 'Секрет'), false);
  assert.equal(a.plotlines.some((p) => p.title === 'Мост'), true);
  assert.equal(b.plotlines.some((p) => p.title === 'Мост'), false);
  assert.deepEqual(a.plotlines.find((p) => p.title === 'Мост').concernsDomainIds, ['a']);
});
