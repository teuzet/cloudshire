import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadStarterMysteryPool,
  loadStarterSuspensePool,
  mergeAnnotationCatalog,
  sampleAnnotationShortlist,
  sortShortlistByNovelty,
  climatePenalty,
  recordSeedClimate,
  climateOf,
  unusedAnnotationPool,
  normalizeAnnotationCard,
} from '../src/game/annotationPool.js';
import { mergeWorldMysteryPool, mergeWorldSuspensePool } from '../src/game/annotationCatalog.js';
import { createPlotline, plotConfig, allowSequelAfter } from '../src/game/plotlines.js';
import { loadConfig } from '../src/config.js';
import { normalizeDomain } from '../src/game/models.js';

const human = {
  id: 'a',
  kind: 'mystery',
  title: 'A',
  observed: 'o'.repeat(20),
  truth: 't'.repeat(20),
  axes: { arena: 'HUMAN', manifestation: 'RUMOR', worldRelation: 'NATIVE', tone: 'social' },
};
const earth = {
  id: 'b',
  kind: 'mystery',
  title: 'B',
  observed: 'o'.repeat(20),
  truth: 't'.repeat(20),
  axes: { arena: 'EARTH', manifestation: 'PHYSICAL_TRACE', worldRelation: 'CONTACT', tone: 'eerie' },
};

test('стартовый пул тайны — arena, footprint, ifSolved', () => {
  const pool = loadStarterMysteryPool();
  assert.ok(pool.length >= 30);
  assert.ok(pool.every((c) => c.observed && c.truth && c.ifSolved && c.ifUnsolved));
  assert.ok(pool.every((c) => c.axes.arena && !c.axes.truthArena));
  assert.ok(pool.every((c) => (c.storyFootprint?.domains || []).length || (c.storyFootprint?.motifs || []).length));
});

test('стартовый пул саспенса — situation, threat, footprint', () => {
  const pool = loadStarterSuspensePool();
  assert.ok(pool.length >= 10);
  assert.ok(pool.length <= 15);
  assert.ok(
    pool.every(
      (c) =>
        c.situation &&
        c.threat &&
        c.whyNotSolvedNow &&
        c.escalation &&
        c.pointOfNoReturn &&
        c.ifPrevented &&
        c.ifNotPrevented,
    ),
  );
  assert.ok(pool.every((c) => c.kind === 'suspense' && c.source === 'starter'));
  assert.ok(pool.every((c) => c.axes.arena && !c.axes.truthArena));
  assert.ok(pool.every((c) => (c.storyFootprint?.domains || []).length || (c.storyFootprint?.motifs || []).length));
});

test('normalize принимает truthArena как arena', () => {
  const card = normalizeAnnotationCard({
    id: 'legacy',
    title: 'Старая',
    observed: 'видели след',
    truth: 'причина в грунте',
    axes: { truthArena: 'earth', manifestation: 'landscape', worldRelation: 'native', tone: 'uncanny', gravity: 40 },
  });
  assert.equal(card.axes.arena, 'EARTH');
  assert.equal(card.axes.manifestation, 'LANDSCAPE');
});

test('старый seedClimate разбирается по жанрам', () => {
  const domain = normalizeDomain({
    id: 'd',
    name: 'X',
    stats: {},
    characters: [],
    seedClimate: [
      { tick: 1, storyType: 'mystery', axes: { truthArena: 'HUMAN', manifestation: 'BODY' } },
      { tick: 2, storyType: 'suspense', axes: { arena: 'SKY', manifestation: 'WEATHER' } },
    ],
  });
  assert.equal(domain.seedClimate.length, 0);
  assert.equal(domain.mysteryClimate[0].axes.arena, 'HUMAN');
  assert.equal(domain.suspenseClimate[0].axes.arena, 'SKY');
});

test('климаты тайны и саспенса разделены', () => {
  const domain = normalizeDomain({ id: 'd', name: 'X', stats: {}, characters: [] });
  recordSeedClimate(domain, {
    tick: 10,
    storyType: 'mystery',
    axes: { arena: 'HUMAN', manifestation: 'RUMOR', worldRelation: 'NATIVE', tone: 'social' },
  });
  recordSeedClimate(domain, {
    tick: 10,
    storyType: 'suspense',
    axes: { arena: 'SKY', manifestation: 'WEATHER', worldRelation: 'NATIVE', tone: 'horror' },
  });
  assert.equal(climateOf(domain, 'mystery').length, 1);
  assert.equal(climateOf(domain, 'suspense').length, 1);
  assert.equal(climateOf(domain, 'mystery')[0].axes.arena, 'HUMAN');
  assert.equal(climateOf(domain, 'suspense')[0].axes.arena, 'SKY');
});

test('шортлист равномерный; климат только сортирует', () => {
  const domain = normalizeDomain({ id: 'd', name: 'X', stats: {}, characters: [] });
  recordSeedClimate(domain, {
    tick: 10,
    storyType: 'mystery',
    axes: { arena: 'HUMAN', manifestation: 'RUMOR', worldRelation: 'NATIVE', tone: 'social' },
  });
  const climate = climateOf(domain, 'mystery');
  assert.ok(climatePenalty(human, climate, { nowTick: 11 }) > climatePenalty(earth, climate, { nowTick: 11 }));
  const ranked = sortShortlistByNovelty([human, earth], climate, { nowTick: 11 });
  assert.equal(ranked[0].id, 'b');
  const picked = sampleAnnotationShortlist([human, earth], { n: 2, storyType: 'mystery', rng: () => 0 });
  assert.equal(picked.length, 2);
  const ids = new Set(picked.map((c) => c.id));
  assert.ok(ids.has('a') && ids.has('b'));
});

test('пул мира склеивает стартер и каталог без дублей', () => {
  const world = { mysteryAnnotationPool: [] };
  const extra = [
    {
      id: 'ann_gen_1',
      kind: 'mystery',
      source: 'generated',
      title: 'Новая',
      observed: 'видели',
      truth: 'причина',
      ifSolved: 'стало лучше',
      ifUnsolved: 'стало хуже',
      axes: { arena: 'HUMAN' },
    },
  ];
  mergeWorldMysteryPool(world, extra);
  const n = world.mysteryAnnotationPool.length;
  assert.ok(n > extra.length);
  mergeWorldMysteryPool(world, extra);
  assert.equal(world.mysteryAnnotationPool.length, n);
  const used = unusedAnnotationPool(world.mysteryAnnotationPool, [{ annotationId: extra[0].id }]);
  assert.equal(used.some((c) => c.id === extra[0].id), false);
});

test('саспенс-каталог не смешивается с тайной', () => {
  const world = { suspenseAnnotationPool: [] };
  const extra = {
    id: 'sus_1',
    kind: 'suspense',
    title: 'Кладка',
    situation: 'на склоне уже видны личинки, пастухи обходят полосу',
    threat: 'если не выжечь край, популяция займёт основное пастбище',
    whyNotSolvedNow: 'выжигать нельзя без жертвы раннего выпаса',
    escalation: 'кладки густеют каждую неделю',
    pointOfNoReturn: 'когда личинки уйдут под дерн основного склона',
    ifPrevented: 'стада держат на прежнем склоне',
    ifNotPrevented: 'выпас сокращают на годы',
    axes: { arena: 'ECOLOGY', gravity: 58 },
  };
  mergeWorldSuspensePool(world, [extra]);
  assert.ok(world.suspenseAnnotationPool.length > 1);
  assert.ok(world.suspenseAnnotationPool.every((c) => c.kind === 'suspense'));
  const added = world.suspenseAnnotationPool.find((c) => c.id === 'sus_1');
  assert.ok(added?.ifPrevented);
});

test('mergeAnnotationCatalog не теряет сгенерированные', () => {
  const starter = loadStarterMysteryPool().slice(0, 2);
  const gen = {
    id: 'ann_keep',
    title: 'Keep',
    observed: 'x',
    truth: 'y',
    source: 'generated',
    kind: 'mystery',
  };
  const merged = mergeAnnotationCatalog(starter, [gen]);
  assert.equal(merged.some((c) => c.id === 'ann_keep'), true);
  assert.equal(merged.filter((c) => c.id === starter[0].id).length, 1);
});

test('саспенс-плот хранит ifPrevented и annotationId', () => {
  const plot = createPlotline({
    title: 'Кладка',
    storyType: 'suspense',
    annotationId: 'sus_1',
    ifPrevented: 'удержали склон',
    ifNotPrevented: 'потеряли выпас',
    gravity: 58,
    depth: 2,
  });
  assert.equal(plot.annotationId, 'sus_1');
  assert.match(plot.ifPrevented, /склон/);
  assert.match(plot.ifNotPrevented, /выпас/);
  assert.equal(allowSequelAfter(plot), true);
});

test('конфиг саспенс-аннотаций совпадает по порогам с тайной', () => {
  const cfg = plotConfig(loadConfig());
  assert.equal(cfg.suspenseAnnotation.shortlistSize, 10);
  assert.equal(cfg.mysteryAnnotation.shortlistSize, 10);
  assert.equal(cfg.suspenseAnnotation.poolMin, 10);
  assert.equal(cfg.mysteryAnnotation.poolMin, 10);
  assert.ok(cfg.suspenseAnnotation.tagGroups.some((g) => g.id === 'truthArena'));
});

test('стартер не короче poolMin — фабрика не доливает поверх пула', () => {
  const cfg = plotConfig(loadConfig());
  const mystery = loadStarterMysteryPool();
  const suspense = loadStarterSuspensePool();
  assert.ok(mystery.length >= cfg.mysteryAnnotation.poolMin);
  assert.ok(suspense.length >= cfg.suspenseAnnotation.poolMin);
});
