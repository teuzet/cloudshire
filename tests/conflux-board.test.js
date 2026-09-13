import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  takeDomainBoardIntoConflux,
  overlayConfluxView,
  stampNewBoardItems,
  stripConfluxView,
  sharePlotWithDomain,
  returnBoardsOnUndock,
  createEmptyContainer,
  approachingAnnounceText,
  isSharedPlot,
  chronicleReceiversForBeat,
} from '../src/game/confluxBoard.js';
import { createPlotline, isThreeActPlot, normalizePlotlines, closePlotline, formatBoardForSpeech, releaseInactiveProcessesFromOpenPlots } from '../src/game/plotlines.js';

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

test('нити остаются у хозяина, на конфлюксе — ссылки; правила города не уезжают', () => {
  const story = createPlotline({ title: 'Спор у колодца', kind: 'story' });
  const proc = { id: 'act_1', summary: 'Чинить колодец', status: 'active' };
  story.relatedProcessIds = ['act_1'];
  const a = domain('a', { plotlines: [story], processes: [proc] });
  a.modifiers = [{ id: 'cmod_1', text: 'Налог вдвое' }];
  const c = conflux();
  takeDomainBoardIntoConflux(a, c);
  assert.equal(a.plotlines.length, 1, 'нить не уезжает с домена');
  assert.equal(a.modifiers.length, 1, 'правила города на доску не уезжают');
  assert.equal(c.plotRefs.length, 1);
  assert.equal(c.plotRefs[0].plotId, story.id);
  assert.equal(c.plotRefs[0].hostDomainId, 'a');
  assert.equal(story.confluxId, c.id);
  assert.deepEqual(story.concernsDomainIds, ['a']);
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

test('карточка нити соседа на доску не попадает', () => {
  const plot = createPlotline({ title: 'Чужой храм', kind: 'story' });
  plot.concernsDomainIds = ['b'];
  plot.hostDomainId = 'b';
  plot.confluxId = 'conflux_1';
  plot.chronicleIds = ['lore_1'];
  plot.plotAwareness = { b: true };
  const c = conflux({ status: 'docked' });
  c.plotlines = [plot];
  const a = domain('a');
  overlayConfluxView(a, c);
  assert.equal(a.plotlines.some((p) => p.id === plot.id), false);
  stampNewBoardItems(a, c);
  stripConfluxView(a);
  assert.equal(a.plotlines.length, 0);
  assert.equal(c.plotlines.length, 1);
});

test('гидратация правителя не показывает чужую нить даже с plotAwareness', () => {
  const plot = createPlotline({ title: 'Чужой храм', kind: 'story' });
  plot.concernsDomainIds = ['b'];
  plot.hostDomainId = 'b';
  plot.confluxId = 'conflux_1';
  plot.plotAwareness = { b: true, a: true };
  const c = conflux({ status: 'docked' });
  c.plotlines = [plot];
  const a = domain('a');
  overlayConfluxView(a, c);
  assert.equal(a.plotlines.some((p) => p.id === plot.id), false);
});

test('главная нить стыка задевает оба города', () => {
  const c = conflux();
  const main = createEmptyContainer({
    a: domain('a'),
    b: domain('b'),
    conflux: c,
    world: { tickIndex: 3 },
  });
  assert.equal(main.isMainConflux, true);
  assert.equal(main.storyType, 'freeform');
  assert.equal(isSharedPlot(main), true);
  assert.deepEqual(main.concernsDomainIds.sort(), ['a', 'b']);
});

test('расстыковка: общая нить остаётся у хозяина, второй город уходит из concerns', async () => {
  const shared = createPlotline({ title: 'Общая драка', kind: 'story' });
  shared.concernsDomainIds = ['a', 'b'];
  shared.hostDomainId = 'a';
  shared.shared = true;
  shared.confluxId = 'conflux_1';
  const a = domain('a', { plotlines: [shared] });
  const b = domain('b');
  const c = conflux();
  await returnBoardsOnUndock(c, new Map([['a', a], ['b', b]]), {
    decideContinuation: async () => true,
  });
  assert.equal(a.plotlines.filter((p) => p.title === 'Общая драка').length, 1);
  assert.equal(b.plotlines.filter((p) => p.title === 'Общая драка').length, 0);
  assert.deepEqual(a.plotlines[0].concernsDomainIds, ['a']);
  assert.equal(a.plotlines[0].shared, false);
  assert.equal(a.plotlines[0].confluxId, null);
});

test('сообщение о старте конфлюкса — отдельный шаблон, не письмо месяца', () => {
  const text = approachingAnnounceText(domain('a'), domain('b'), 8, false);
  assert.match(text, /Берил/);
  assert.match(text, /8 мес/);
  assert.doesNotMatch(text, /Покровитель/);
  assert.doesNotMatch(text, /примета|слух|час/);
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

test('городская история при регистрации ссылки остаётся story и держит скрытые посылки', () => {
  const plot = createPlotline({
    title: 'Седьмая капля',
    kind: 'story',
    storyType: 'suspense',
    depth: 1,
    hiddenPremises: ['Седьмой удар открывает лишний сток.'],
    closeWhen: 'Происхождение удара установлено.',
    mootWhen: 'Порог закрыли и обряд больше не держат.',
  });
  const a = domain('a', { plotlines: [plot] });
  const c = conflux({ status: 'approaching' });
  takeDomainBoardIntoConflux(a, c);
  assert.equal(a.plotlines[0], plot);
  assert.equal(c.plotRefs[0].plotId, plot.id);
  assert.equal(isThreeActPlot(plot), false);
  assert.equal(plot.storyType, 'story');
  assert.equal(plot.hiddenPremises.length, 1);
  normalizePlotlines(a);
  assert.equal(plot.storyType, 'story');
  assert.equal(plot.hiddenPremises[0], 'Седьмой удар открывает лишний сток.');
  assert.equal(plot.mootWhen.includes('обряд'), true);
});

test('закрытие на наложенном виде снимает оверлей, нить остаётся у хозяина', () => {
  const plot = createPlotline({
    title: 'Седьмая капля',
    kind: 'story',
    storyType: 'suspense',
    depth: 1,
    hostDomainId: 'a',
  });
  const a = domain('a', { plotlines: [plot] });
  const c = conflux({ status: 'approaching' });
  plot.confluxId = c.id;
  plot.hostDomainId = 'a';
  overlayConfluxView(a, c);
  assert.equal(a.plotlines[0], plot);
  closePlotline(a, plot.id, { tick: 21, reason: 'успех' });
  stampNewBoardItems(a, c);
  stripConfluxView(a);
  assert.equal(a.closedPlotlines.filter((p) => p.id === plot.id).length, 1);
  assert.equal(a.plotlines.some((p) => p.id === plot.id), false);
});

test('речь правителя не отдаёт заголовок нити в кавычках', () => {
  const plot = createPlotline({
    title: 'Седьмая капля',
    kind: 'story',
    storyType: 'suspense',
    synopsis: 'После обряда вода вернулась к седьмому удару.',
  });
  const speech = formatBoardForSpeech({ plotlines: [plot] });
  assert.equal(speech.includes('«Седьмая капля»'), false);
  assert.equal(speech.includes(plot.id), true);
  assert.equal(speech.includes('седьмому удару'), true);
});

test('речь правителя не видит концовки', () => {
  const plot = createPlotline({
    title: 'Сочение',
    kind: 'story',
    storyType: 'story',
    synopsis: 'Из коры течёт густая тёмная смола, у смолокуров немеют пальцы.',
    closeWhen: ['Развилки вскрывают и очищают от насекомых и поражённой коры.'],
    hiddenAnswer: 'Мелкие паразитические насекомые выходят из-под коры.',
  });
  const open = createPlotline({
    title: 'Гул',
    kind: 'story',
    synopsis: 'Ночами в цистерне гудит вода.',
    closeWhen: 'Найдут источник гула.',
  });
  const speech = formatBoardForSpeech({ plotlines: [plot, open] });
  assert.doesNotMatch(speech, /насеком/i);
  assert.doesNotMatch(speech, /К чему идёт/);
  assert.doesNotMatch(speech, /Найдут источник/);
  assert.match(speech, /густая тёмная смола/);
  assert.match(speech, /гудит вода/);
});

test('регистрация не забирает resolved дело с домена', () => {
  const closed = createPlotline({ title: 'Мост', kind: 'errand' });
  closed.status = 'closed';
  closed.relatedProcessIds = ['act_done'];
  const proc = { id: 'act_done', summary: 'Мост', status: 'resolved', plotlineId: closed.id };
  const a = domain('a', { processes: [proc] });
  a.plotlines = [];
  a.closedPlotlines = [closed];
  const c = conflux();
  takeDomainBoardIntoConflux(a, c);
  assert.equal(a.state.pendingActions.length, 1, 'дело остаётся у хозяина');
  assert.equal(a.closedPlotlines.some((p) => p.id === closed.id), true);
});

test('снятие вида не переносит сироту на конфлюкс — дело остаётся на домене', () => {
  const closed = createPlotline({ title: 'Мост', kind: 'errand' });
  closed.status = 'closed';
  closed.relatedProcessIds = ['act_done'];
  const c = conflux();
  c.closedPlotlines = [closed];
  const a = domain('a', {
    processes: [{ id: 'act_done', summary: 'Мост', status: 'resolved', plotlineId: closed.id }],
  });
  stampNewBoardItems(a, c);
  stripConfluxView(a);
  assert.equal(a.state.pendingActions.length, 1);
  assert.equal((c.processes || []).some((p) => p.id === 'act_done'), false);
});

test('снятие вида не снимает законченный id: это после битов, в конце тика', () => {
  const story = createPlotline({ title: 'Смола', kind: 'story', synopsis: 'Лопнул мост.' });
  story.relatedProcessIds = ['act_old', 'act_live'];
  const c = conflux();
  c.plotlines = [story];
  c.processes = [
    { id: 'act_old', status: 'resolved', confluxId: c.id, ownerDomainId: 'a' },
    { id: 'act_live', status: 'active', confluxId: c.id, ownerDomainId: 'a' },
  ];
  const a = domain('a');
  overlayConfluxView(a, c);
  stampNewBoardItems(a, c);
  stripConfluxView(a);
  assert.deepEqual(story.relatedProcessIds, ['act_old', 'act_live']);
});

test('release снимает законченные id с открытой нити, живое оставляет', () => {
  const story = createPlotline({ title: 'Смола', kind: 'story', synopsis: 'Лопнул мост.' });
  story.relatedProcessIds = ['act_old', 'act_live'];
  releaseInactiveProcessesFromOpenPlots({
    plotlines: [story],
    state: {
      pendingActions: [
        { id: 'act_old', status: 'resolved' },
        { id: 'act_live', status: 'active' },
      ],
    },
  });
  assert.deepEqual(story.relatedProcessIds, ['act_live']);
});

test('речь не считает законченное дело живым', () => {
  const plot = createPlotline({
    title: 'Смола',
    kind: 'story',
    synopsis: 'Лопнул канатный мост у оврага.',
  });
  plot.relatedProcessIds = ['act_old'];
  const speech = formatBoardForSpeech({
    plotlines: [plot],
    state: { pendingActions: [{ id: 'act_old', status: 'resolved' }] },
  });
  assert.match(speech, /поручения ещё нет/);
  assert.equal(speech.includes('дело уже идёт'), false);
});
