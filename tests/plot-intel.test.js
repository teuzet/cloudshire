import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlotline } from '../src/game/plotlines.js';
import { createLoreFact } from '../src/game/models.js';
import {
  sharePlotWithDomain,
  maybeLeakChronicle,
  cityKnowsPlot,
  isContested,
  isSharedPlot,
  hydrateDomainFromConflux,
  returnBoardsOnUndock,
  applyIntelFinishes,
  nativePlotsForMonth,
  confluxMonthPlots,
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
    awareness: { a: extra.awA ?? 80, b: extra.awB ?? 80 },
    knownLoreIds: { a: extra.knownA || [], b: extra.knownB || [] },
    intelOffers: { a: [], b: [] },
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
  plot.plotAwareness = { b: true };
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
  assert.equal(confluxMonthPlots(c).some((p) => p.id === plot.id), true);
});

test('не-intel вмешательство шарит нить и даёт awareness', () => {
  const plot = createPlotline({ title: 'Храм', kind: 'story' });
  plot.concernsDomainIds = ['b'];
  plot.hostDomainId = 'b';
  plot.plotAwareness = { b: true };
  sharePlotWithDomain(plot, 'a', { reason: 'process' });
  assert.equal(isSharedPlot(plot), true);
  assert.equal(cityKnowsPlot(plot, 'a'), true);
  assert.ok(plot.concernsDomainIds.includes('a'));
});

test('утечка — голая хроника, без карточки и без share', () => {
  const plot = createPlotline({ title: 'Тайна колодца', kind: 'story', storyType: 'story', gravity: 'RUPTURE' });
  plot.concernsDomainIds = ['a'];
  plot.hostDomainId = 'a';
  plot.plotAwareness = { a: true };
  plot.chronicleIds = ['lore_1', 'lore_2'];
  const fact = createLoreFact({
    id: 'lore_1',
    text: 'У колодца ночами стучат.',
    tags: ['chronicle'],
    relatedPlotlineIds: [plot.id],
  });
  const viewer = domain('b');
  const c = conflux({ awA: 100, awB: 100, plotlines: [plot] });
  const leaked = maybeLeakChronicle({
    plot,
    fact,
    conflux: c,
    viewerId: 'b',
    viewerDomain: viewer,
    rng: () => 0,
  });
  assert.equal(leaked, true);
  assert.equal(isSharedPlot(plot), false);
  assert.equal(cityKnowsPlot(plot, 'b'), false);
  assert.equal(c.knownLoreIds.b.includes('lore_1'), true);
  assert.equal(viewer.lore.some((f) => f.leakedFromId === 'lore_1'), true);
  assert.equal(viewer.lore[0].sourcePlotId, plot.id);
  const a = domain('a');
  hydrateDomainFromConflux(a, c, { mode: 'ruler' });
  const bBoard = domain('b');
  hydrateDomainFromConflux(bBoard, c, { mode: 'ruler' });
  assert.equal(bBoard.plotlines.some((p) => p.id === plot.id), false);
});

test('все хроники нити известны → plotAwareness', () => {
  const plot = createPlotline({ title: 'Тайна', kind: 'story', storyType: 'story', gravity: 'RUPTURE' });
  plot.hostDomainId = 'a';
  plot.concernsDomainIds = ['a'];
  plot.plotAwareness = { a: true };
  plot.chronicleIds = ['lore_1'];
  const fact = createLoreFact({
    id: 'lore_1',
    text: 'Стучат.',
    tags: ['chronicle'],
    relatedPlotlineIds: [plot.id],
  });
  const viewer = domain('b');
  const c = conflux({ awA: 100, awB: 100, plotlines: [plot] });
  maybeLeakChronicle({
    plot,
    fact,
    conflux: c,
    viewerId: 'b',
    viewerDomain: viewer,
    domains: [domain('a'), viewer],
    rng: () => 0,
  });
  assert.equal(cityKnowsPlot(plot, 'b'), true);
});

test('успех intel открывает нить и не пишет concerns', () => {
  const plot = createPlotline({ title: 'Храм', kind: 'story' });
  plot.hostDomainId = 'b';
  plot.concernsDomainIds = ['b'];
  plot.plotAwareness = { b: true };
  plot.relatedProcessIds = ['act_i'];
  const spy = domain('a');
  const host = domain('b');
  const c = conflux({
    plotlines: [plot],
    processes: [{ id: 'act_i', ownerDomainId: 'a', intel: true, status: 'done' }],
  });
  applyIntelFinishes({
    conflux: c,
    domains: [spy, host],
    world: { tickIndex: 4, gameDate: { label: '4' } },
    outcomes: [
      {
        processId: 'act_i',
        intel: true,
        finished: true,
        finish: 'crit',
        ownerDomainId: 'a',
        plotlineId: plot.id,
      },
    ],
  });
  assert.equal(cityKnowsPlot(plot, 'a'), true);
  assert.equal(plot.concernsDomainIds.includes('a'), false);
  assert.equal(spy.lore.some((f) => (f.tags || []).includes('intel')), true);
});

test('хозяин тикает uncontested native; contested — на доске стыка', () => {
  const local = createPlotline({ title: 'Колодец', kind: 'story' });
  local.hostDomainId = 'a';
  local.concernsDomainIds = ['a'];
  local.plotAwareness = { a: true };
  const fight = createPlotline({ title: 'Драка', kind: 'story' });
  fight.hostDomainId = 'a';
  fight.concernsDomainIds = ['a', 'b'];
  fight.shared = true;
  fight.relatedProcessIds = ['pa', 'pb'];
  const c = conflux({
    plotlines: [local, fight],
    processes: [
      { id: 'pa', ownerDomainId: 'a', status: 'active' },
      { id: 'pb', ownerDomainId: 'b', status: 'active' },
    ],
  });
  assert.deepEqual(nativePlotsForMonth(c, 'a').map((p) => p.title), ['Колодец']);
  assert.deepEqual(confluxMonthPlots(c).map((p) => p.title), ['Драка']);
});

test('расстыковка не отдаёт нераскрытую нить; keep=false — без финала', async () => {
  const hidden = createPlotline({ title: 'Секрет', kind: 'story' });
  hidden.hostDomainId = 'a';
  hidden.concernsDomainIds = ['a'];
  hidden.plotAwareness = { a: true };
  hidden.relatedProcessIds = [];
  const known = createPlotline({ title: 'Мост', kind: 'story' });
  known.hostDomainId = 'a';
  known.concernsDomainIds = ['a', 'b'];
  known.shared = true;
  known.plotAwareness = { a: true, b: true };
  const a = domain('a');
  const b = domain('b');
  const c = conflux({ plotlines: [hidden, known] });
  await returnBoardsOnUndock(c, new Map([['a', a], ['b', b]]), {
    decideContinuation: async ({ plot, domainId }) => plot.title === 'Мост' && domainId === 'b',
  });
  assert.equal(a.plotlines.some((p) => p.title === 'Секрет'), false);
  assert.equal(b.plotlines.some((p) => p.title === 'Секрет'), false);
  assert.equal(a.plotlines.some((p) => p.title === 'Мост'), false);
  assert.equal(b.plotlines.some((p) => p.title === 'Мост'), true);
});
