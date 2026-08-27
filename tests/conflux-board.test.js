import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  takeDomainBoardIntoConflux,
  hydrateDomainFromConflux,
  dehydrateDomainToConflux,
  sharePlotWithDomain,
  maybeLeakPlot,
  leakChanceFromImportance,
  revealKnownLore,
  returnBoardsOnUndock,
  createMainConfluxPlot,
  approachingAnnounceText,
  isSharedPlot,
  chronicleReceiversForBeat,
} from '../src/game/confluxBoard.js';
import { createPlotline, isOrderPlot } from '../src/game/plotlines.js';

function domain(id, extra = {}) {
  return {
    id,
    name: id === 'a' ? 'Астра' : 'Берил',
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
    awareness: { a: extra.awA ?? 0, b: extra.awB ?? 0 },
    knownLoreIds: { a: [], b: [] },
    plotlines: [],
    closedPlotlines: [],
    processes: [],
    lore: [],
    etaMonths: 6,
    durationMonths: 3,
    rematch: false,
    ...extra,
  };
}

test('указы остаются на городе, истории уходят на конфлюкс', () => {
  const story = createPlotline({ title: 'Спор у колодца', kind: 'story' });
  const order = createPlotline({ title: 'Налог', kind: 'order' });
  const proc = { id: 'act_1', summary: 'Чинить колодец', status: 'active' };
  story.relatedProcessIds = ['act_1'];
  const a = domain('a', { plotlines: [story, order], processes: [proc] });
  const c = conflux();
  takeDomainBoardIntoConflux(a, c);
  assert.equal(a.plotlines.length, 1);
  assert.equal(a.plotlines[0].kind, 'order');
  assert.equal(c.plotlines.length, 1);
  assert.equal(c.plotlines[0].title, 'Спор у колодца');
  assert.equal(c.processes.length, 1);
  assert.equal(c.processes[0].ownerDomainId, 'a');
  assert.deepEqual(c.plotlines[0].concernsDomainIds, ['a']);
});

test('дело на чужой не-shared нити делает её shared', () => {
  const plot = createPlotline({ title: 'Чужой храм', kind: 'story' });
  plot.concernsDomainIds = ['b'];
  plot.hostDomainId = 'b';
  sharePlotWithDomain(plot, 'a', { reason: 'process' });
  assert.equal(isSharedPlot(plot), true);
  assert.deepEqual(plot.concernsDomainIds.sort(), ['a', 'b']);
  assert.equal(plot.sharedReason, 'process');
});

test('шанс просачивания: 30≈0, 100≈60% при полной информированности', () => {
  assert.equal(leakChanceFromImportance(30, 100), 0);
  assert.ok(Math.abs(leakChanceFromImportance(100, 100) - 0.6) < 1e-9);
  assert.ok(Math.abs(leakChanceFromImportance(100, 50) - 0.3) < 1e-9);
});

test('просачивание не работает до стыковки и при нулевой информированности', () => {
  const plot = createPlotline({ title: 'Тайна', kind: 'story', importance: 100 });
  plot.concernsDomainIds = ['a'];
  const approaching = conflux({ status: 'approaching', awA: 80, awB: 80 });
  assert.equal(maybeLeakPlot(plot, approaching, 'b', () => 0), false);
  const docked = conflux({ status: 'docked', awA: 0, awB: 0 });
  assert.equal(maybeLeakPlot(plot, docked, 'b', () => 0), false);
});

test('известные факты монотонны и не берут secret', () => {
  const c = conflux({ status: 'docked', awA: 100 });
  const partner = domain('b', {
    lore: [
      { id: 'lore_1', text: 'На рынке дешевле хлеб.', tags: ['chronicle'] },
      { id: 'lore_2', text: 'Тайный ход', tags: ['chronicle'], secret: true },
    ],
  });
  const first = revealKnownLore({ conflux: c, viewerId: 'a', partner, rng: () => 0 });
  assert.equal(first.revealed, 1);
  assert.deepEqual(c.knownLoreIds.a, ['lore_1']);
  const second = revealKnownLore({ conflux: c, viewerId: 'a', partner, rng: () => 0 });
  assert.equal(second.revealed, 0);
  assert.deepEqual(c.knownLoreIds.a, ['lore_1']);
});

test('гидратация правителя не показывает чужую нить из одной известной хроники', () => {
  const plot = createPlotline({ title: 'Чужой храм', kind: 'story' });
  plot.concernsDomainIds = ['b'];
  plot.hostDomainId = 'b';
  plot.confluxId = 'conflux_1';
  plot.chronicleIds = ['lore_1'];
  plot.plotAwareness = { b: true };
  const c = conflux({ status: 'docked' });
  c.plotlines = [plot];
  c.knownLoreIds.a = ['lore_1'];
  const a = domain('a');
  hydrateDomainFromConflux(a, c, { mode: 'ruler' });
  assert.equal(a.plotlines.some((p) => p.id === plot.id), false);
  dehydrateDomainToConflux(a, c);
  assert.equal(a.plotlines.every(isOrderPlot), true);
  assert.equal(c.plotlines.length, 1);
});

test('гидратация правителя показывает нить после plotAwareness', () => {
  const plot = createPlotline({ title: 'Чужой храм', kind: 'story' });
  plot.concernsDomainIds = ['b'];
  plot.hostDomainId = 'b';
  plot.confluxId = 'conflux_1';
  plot.plotAwareness = { b: true, a: true };
  const c = conflux({ status: 'docked' });
  c.plotlines = [plot];
  const a = domain('a');
  hydrateDomainFromConflux(a, c, { mode: 'ruler' });
  assert.equal(a.plotlines.some((p) => p.id === plot.id), true);
});

test('главная нить стыка задевает оба города', () => {
  const c = conflux();
  const main = createMainConfluxPlot({
    a: domain('a'),
    b: domain('b'),
    conflux: c,
    world: { tickIndex: 3 },
  });
  assert.equal(main.isMainConflux, true);
  assert.equal(isSharedPlot(main), true);
  assert.deepEqual(main.concernsDomainIds.sort(), ['a', 'b']);
});

test('расстыковка: shared копируется обоим, чужие дела отрезаны; указы не трогаем', async () => {
  const shared = createPlotline({ title: 'Общая драка', kind: 'story' });
  shared.concernsDomainIds = ['a', 'b'];
  shared.shared = true;
  shared.relatedProcessIds = ['act_a', 'act_b'];
  const order = createPlotline({ title: 'Налог', kind: 'order' });
  const a = domain('a', { plotlines: [order] });
  const b = domain('b');
  const c = conflux();
  c.plotlines = [shared];
  c.processes = [
    { id: 'act_a', ownerDomainId: 'a', status: 'active', confluxId: c.id },
    { id: 'act_b', ownerDomainId: 'b', status: 'active', confluxId: c.id },
  ];
  await returnBoardsOnUndock(c, new Map([['a', a], ['b', b]]));
  assert.equal(a.plotlines.filter((p) => p.kind === 'order').length, 1);
  assert.equal(a.plotlines.filter((p) => p.title === 'Общая драка').length, 1);
  assert.equal(b.plotlines.filter((p) => p.title === 'Общая драка').length, 1);
  assert.equal(a.state.pendingActions.map((p) => p.id).join(), 'act_a');
  assert.equal(b.state.pendingActions.map((p) => p.id).join(), 'act_b');
});

test('сообщение о старте конфлюкса — отдельный шаблон, не письмо месяца', () => {
  const text = approachingAnnounceText(domain('a'), domain('b'), 8, false);
  assert.match(text, /Берил/);
  assert.match(text, /8 мес/);
  assert.doesNotMatch(text, /Покровитель/);
});

test('до стыковки хроника нити не идёт в чужой город', () => {
  const a = domain('a');
  const b = domain('b');
  const main = {
    isMainConflux: true,
    concernsDomainIds: ['a', 'b'],
    hostDomainId: null,
  };
  const approaching = conflux({ status: 'approaching' });
  const fromProcess = chronicleReceiversForBeat(
    approaching,
    main,
    { processOutcome: { ownerDomainId: 'a', processId: 'act_a' } },
    [a, b],
  );
  assert.deepEqual(
    fromProcess.map((d) => d.id),
    ['a'],
  );
  const noProcess = chronicleReceiversForBeat(approaching, main, {}, [a, b]);
  assert.equal(noProcess.length, 0);
  const docked = chronicleReceiversForBeat(conflux({ status: 'docked' }), main, {}, [a, b]);
  assert.deepEqual(
    docked.map((d) => d.id).sort(),
    ['a', 'b'],
  );
});
