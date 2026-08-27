import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePlotline,
  findClosedPlotline,
  plotCanFade,
  plotConfig,
  plotHasActiveProcess,
  pickPlotTags,
  pickMysteryPlotTags,
  pickSeedTags,
  formatPlotTagsForPrompt,
  formatMysteryAxesForPrompt,
  mysteryTypeTag,
  openingPlotCount,
  pickSequelSeed,
  allowSequelAfter,
  createPlotline,
  normalizePlotlines,
  plotSeedChance,
  liveStoryImportance,
  judgePlotSeed,
  reopenClosedPlotline,
  plotScale,
} from '../src/game/plotlines.js';
import { ensureErrandForProcess, planBeats } from '../src/game/plotEngine.js';
import { peopleUnderWatch, priorPlotChronicle, mintSeedCast, offerMysterySeedNames } from '../src/game/storyteller.js';

function plot(id, extra = {}) {
  return {
    id,
    title: 'Пустая келья',
    synopsis: 'Иару нашли живой в водосборных лестницах.',
    closeWhen: 'Найдут или похоронят.',
    kind: 'story',
    tags: [],
    relatedStats: ['stability'],
    chronicleIds: ['lore_found'],
    relatedProcessIds: ['act_search'],
    relatedPlotlineIds: [],
    importance: 40,
    maxAgeMonths: 6,
    ageMonths: 2,
    temperature: 40,
    mirrorOf: null,
    confluxId: null,
    partnerGone: false,
    status: 'open',
    createdTick: 1,
    lastBeatTick: 6,
    beatCount: 3,
    ...extra,
  };
}

test('закрытая нить помнит дело и хронику, а не только заголовок', () => {
  const domain = { plotlines: [plot('plot_iara')], closedPlotlines: [] };
  closePlotline(domain, 'plot_iara', { tick: 6, reason: 'Иару нашли.' });
  assert.equal(domain.plotlines.length, 0);
  const archived = findClosedPlotline(domain, 'plot_iara');
  assert.ok(archived);
  assert.deepEqual(archived.relatedProcessIds, ['act_search']);
  assert.deepEqual(archived.chronicleIds, ['lore_found']);
  assert.match(archived.synopsis, /нашли/);
});

test('нить с живым поручением нельзя считать свободной', () => {
  const domain = {
    plotlines: [plot('plot_iara')],
    state: { pendingActions: [{ id: 'act_search', status: 'active' }] },
  };
  assert.equal(plotHasActiveProcess(domain, domain.plotlines[0]), true);
  domain.state.pendingActions[0].status = 'resolved';
  assert.equal(plotHasActiveProcess(domain, domain.plotlines[0]), false);
});

test('живое поручение возвращает закрытую нить, а не заводит пустую карточку', () => {
  const domain = {
    plotlines: [plot('plot_iara')],
    closedPlotlines: [],
    state: { pendingActions: [] },
  };
  closePlotline(domain, 'plot_iara', { tick: 6, reason: 'Иару нашли.' });
  const process = {
    id: 'act_search',
    plotlineId: 'plot_iara',
    summary: 'Повторный розыск Иары',
    detail: 'Снова проверить келью.',
    expectedMonths: 2,
  };
  const result = ensureErrandForProcess(domain, process, { tick: 7 });
  assert.equal(result.created, false);
  assert.equal(result.reopened, true);
  assert.equal(result.plot.id, 'plot_iara');
  assert.match(result.plot.synopsis, /нашли/);
  assert.ok(result.plot.relatedProcessIds.includes('act_search'));
  assert.equal(domain.plotlines.length, 1);
  assert.equal((domain.closedPlotlines || []).length, 0);
});

test('бит видит прошлую хронику нити и людей в розыске', () => {
  const domain = {
    lore: [
      {
        id: 'lore_found',
        tags: ['chronicle'],
        text: 'В лестницах нашли Иару.',
        gameDateLabel: 'Год 1, месяц 7',
        relatedPlotlineIds: ['plot_iara'],
      },
      {
        id: 'lore_levra',
        tags: ['character'],
        name: 'Левра',
        role: 'переписчица',
        about: 'Работает в храме.',
        status: 'alive',
      },
    ],
    plotlines: [plot('plot_iara')],
    state: {
      pendingActions: [
        {
          id: 'act_hunt',
          status: 'active',
          summary: 'Задержание и разбор угроз Левры',
          detail: 'Разыскать и задержать Левру.',
        },
      ],
    },
  };
  const prior = priorPlotChronicle(domain, domain.plotlines[0]);
  assert.equal(prior.length, 1);
  assert.match(prior[0], /нашли Иару/);
  const watched = peopleUnderWatch(domain);
  assert.equal(watched.length, 1);
  assert.equal(watched[0].name, 'Левра');
});

test('просроченная нить гаснет только без дел и без внимания', () => {
  const cold = plot('p_cold', { ageMonths: 6, maxAgeMonths: 5, temperature: 8, relatedProcessIds: [] });
  const busy = plot('p_busy', { ageMonths: 6, maxAgeMonths: 5, temperature: 8, relatedProcessIds: ['act_1'] });
  const hot = plot('p_hot', { ageMonths: 6, maxAgeMonths: 5, temperature: 40, relatedProcessIds: [] });
  assert.equal(plotCanFade({ plotlines: [cold], state: { pendingActions: [] } }, cold), true);
  assert.equal(
    plotCanFade(
      { plotlines: [busy], state: { pendingActions: [{ id: 'act_1', status: 'active' }] } },
      busy,
    ),
    false,
  );
  assert.equal(plotCanFade({ plotlines: [hot], state: { pendingActions: [] } }, hot), false);
  assert.equal(
    plotCanFade(
      { plotlines: [plot('p_young', { ageMonths: 2, maxAgeMonths: 5, temperature: 0, relatedProcessIds: [] })] },
      plot('p_young', { ageMonths: 2, maxAgeMonths: 5, temperature: 0, relatedProcessIds: [] }),
    ),
    false,
  );
});

test('план битов: забытую нить гасит тихо, живую просроченную не финалит', () => {
  const forgotten = plot('p_fade', {
    ageMonths: 6,
    maxAgeMonths: 5,
    temperature: 5,
    relatedProcessIds: [],
  });
  const watched = plot('p_hot', {
    ageMonths: 6,
    maxAgeMonths: 5,
    temperature: 50,
    relatedProcessIds: [],
  });
  const { beats } = planBeats({
    domain: { plotlines: [forgotten, watched], state: { pendingActions: [] } },
    rng: () => 1,
  });
  const fade = beats.find((b) => b.plotId === 'p_fade');
  const hot = beats.find((b) => b.plotId === 'p_hot');
  assert.equal(fade?.fade, true);
  assert.equal(fade?.finale, false);
  assert.equal(fade?.reason, 'fade');
  assert.equal(hot, undefined);
});

test('тонкий архив без синопсиса всё равно поднимает развязку в карточку', () => {
  const domain = {
    plotlines: [],
    closedPlotlines: [
      {
        id: 'plot_old',
        title: 'Пустая келья',
        reason: 'Иару нашли, виновный переписчик задержан.',
        beatCount: 3,
        closedTick: 6,
      },
    ],
  };
  const plotline = reopenClosedPlotline(domain, 'plot_old');
  assert.match(plotline.synopsis, /Иару нашли/);
});

test('пустая доска всегда сеет историю, пауза не глушит', () => {
  const cfg = plotConfig({ tick: { plot: { board: { seedCooldownMonths: 2 } } } });
  assert.equal(plotSeedChance({ plotlines: [] }, cfg, 10), 1);
  assert.equal(plotSeedChance({ plotlines: [{ kind: 'errand', createdTick: 10 }] }, cfg, 10), 1);
});

const SEED_PAD = 'Дальше история должна жить своей жизнью и не обрываться на полуслове. '.repeat(4);

test('близнец завязки только при семи общих словах', () => {
  const domain = {
    plotlines: [
      {
        title: 'Мутная чаша',
        synopsis:
          'Под настилом центральной чаши нашли каменный колодец с колоколом. Водосбор очистили, серая плёнка осталась в баках.',
      },
    ],
  };
  assert.equal(
    judgePlotSeed(domain, {
      title: 'Сухой гром',
      entry: 'Над островом прошёл гром.',
      synopsis: `${SEED_PAD} После грома на настиле у чаши выступил иней.`,
    }),
    null,
  );
  assert.equal(
    judgePlotSeed(domain, {
      title: 'Мутная чаша',
      entry: 'Под настилом снова ударил колокол.',
      synopsis: `${SEED_PAD} Под настилом центральной чаши нашли каменный колодец с колоколом. Водосбор очистили.`,
    }),
    'twin',
  );
});

test('три мелкие истории не глушат посев, полный вес глушит', () => {
  const cfg = plotConfig({
    tick: { plot: { board: { targetImportance: 100, seedCooldownMonths: 2, seedMaxChance: 0.5 } } },
  });
  const small = [
    { kind: 'story', importance: 25, createdTick: 10 },
    { kind: 'story', importance: 20, createdTick: 9 },
    { kind: 'story', importance: 22, createdTick: 8 },
  ];
  assert.equal(liveStoryImportance({ plotlines: small }), 67);
  assert.ok(plotSeedChance({ plotlines: small }, cfg, 10) > 0);
  assert.equal(
    plotSeedChance({ plotlines: [{ kind: 'story', importance: 70 }, { kind: 'story', importance: 40 }] }, cfg, 10),
    0,
  );
});

test('закрытая нить помнит крючок на продолжение', () => {
  const domain = { plotlines: [plot('plot_iara')], closedPlotlines: [] };
  closePlotline(domain, 'plot_iara', {
    tick: 6,
    reason: 'Нашли живой.',
    sequelHook: 'Осталась угроза, из‑за которой человек бежал.',
  });
  const archived = findClosedPlotline(domain, 'plot_iara');
  assert.match(archived.sequelHook, /угроза/);
});

test('стартер тайны может пометить, что история просит сиквела', () => {
  const seeded = createPlotline({
    title: 'Гул в трубах',
    storyType: 'mystery',
    asksSequel: true,
    observedFacts: ['Ярус слышит гул.', 'На площади спорят, колокол это или вода.'],
    resolutionFacts: ['Почему гудит цистерна', 'Кто перестал её чистить'],
  });
  assert.equal(seeded.asksSequel, true);
  assert.equal(seeded.observedFacts.length, 2);
  assert.equal(seeded.resolutionFacts.length, 2);
  const domain = { plotlines: [seeded], closedPlotlines: [] };
  normalizePlotlines(domain);
  assert.equal(domain.plotlines[0].asksSequel, true);
  closePlotline(domain, seeded.id, { tick: 4, reason: 'Разгадали.', sequelHook: 'Яд шёл из соседней мастерской.' });
  assert.equal(findClosedPlotline(domain, seeded.id).asksSequel, true);
  assert.equal(allowSequelAfter({ storyType: 'mystery', asksSequel: true, kind: 'story' }), true);
  assert.equal(allowSequelAfter({ storyType: 'mystery', asksSequel: false, kind: 'story' }), false);
  assert.equal(allowSequelAfter({ storyType: 'suspense', kind: 'story' }), true);
  assert.equal(allowSequelAfter({ kind: 'errand' }), false);
});

test('каталог завязки: тон, сфера, причинная сила, ситуация, динамика', async () => {
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const cfg = plotConfig(config);
  const byId = Object.fromEntries(cfg.tagGroups.map((g) => [g.id, g]));
  assert.ok(byId.tone && byId.sphere && byId.source && byId.situation && byId.dynamic);
  assert.equal(byId.scale, undefined);
  assert.equal(byId.character, undefined);
  assert.equal(byId.spark, undefined);
  assert.ok(byId.sphere.tags.length >= 6);
  assert.equal(byId.source.tags.find((t) => t.id === 'any'), undefined);
  assert.ok(byId.source.tags.find((t) => t.id === 'unknown'));
  assert.ok(cfg.suspense.gravityFloor >= 20);
  assert.equal(cfg.suspense.legacyMinGravity, 25);
});

test('каталог тайны: поле и тип', async () => {
  const { loadConfig } = await import('../src/config.js');
  const cfg = plotConfig(loadConfig());
  const byId = Object.fromEntries(cfg.mysteryTagGroups.map((g) => [g.id, g]));
  assert.ok(byId.association && byId.type);
  assert.equal(byId.dynamic, undefined);
  assert.equal(byId.kind, undefined);
  assert.ok(byId.association.tags.length >= 16);
  assert.ok(byId.type.tags.length >= 12);
  assert.ok(byId.type.tags.length <= 16);
  assert.ok(cfg.mysteryGraph.minNodes >= 3);
  assert.ok(cfg.mysteryGraph.maxNodes >= cfg.mysteryGraph.minNodes);
  const shapeIds = cfg.mysteryGraph.shapes.map((s) => s.id || s);
  assert.ok(shapeIds.includes('linear_4'));
  assert.ok(shapeIds.includes('linear_5'));
  assert.ok(shapeIds.includes('linear_side'));
  const byShape = Object.fromEntries(cfg.mysteryGraph.shapes.map((s) => [s.id || s, Number(s.weight)]));
  assert.equal(byShape.linear_5, 0);
  assert.ok(byShape.linear_4 > 0);
  assert.equal(byShape.linear_side, 0);
  assert.equal(cfg.mysteryGraph.sideRevealChance, 0.5);
  assert.ok(cfg.mysteryEntities.minCatalog >= 24);
  assert.equal(cfg.mysteryEntities.pickMin, 1);
  assert.equal(cfg.mysteryEntities.pickMax, 2);
  assert.ok(cfg.mysteryEntities.twoChance > 0);
  assert.ok(cfg.mysteryEntities.twoChance < 0.5);
  const raw = loadConfig();
  assert.match(String(raw.world?.cosmology || ''), /low-magic/);
  assert.match(String(raw.world?.cosmology || ''), /не проявляется повсеместно/);
  assert.match(String(raw.canon?.world || ''), /low-magic/);
  const tags = pickMysteryPlotTags(cfg, () => 0.1);
  assert.deepEqual(
    tags.map((t) => t.groupId).sort(),
    ['association', 'type'],
  );
  assert.ok(mysteryTypeTag(tags)?.tagName);
  const opening = pickSeedTags(cfg, { storyType: 'mystery', opening: true, rng: () => 0.01 });
  assert.equal(opening.some((t) => t.groupId === 'scale'), false);
  const known = new Set(['id', 'name', 'weight', 'people', 'kind', 'about']);
  for (const g of cfg.mysteryTagGroups) {
    for (const t of g.tags) {
      const extra = Object.keys(t).filter((k) => !known.has(k));
      assert.deepEqual(extra, [], `${g.id}/${t.id}: YAML разрезал имя на лишние ключи`);
    }
  }
  const formatted = formatMysteryAxesForPrompt([
    { groupId: 'association', groupName: 'Ассоциативное поле', tagName: 'остаток' },
    { groupId: 'type', groupName: 'Тип тайны', tagName: 'заговор', about: 'скрытая воля' },
  ]);
  assert.match(formatted, /ТИП ТАЙНЫ \(обязателен\): заговор/);
  assert.match(formatted, /АССОЦИАТИВНОЕ ПОЛЕ \(очень слабый импульс\): «остаток»/);
  assert.equal(formatted.includes('всё мягко'), false);
  const hard = formatPlotTagsForPrompt([
    { groupId: 'tone', groupName: 'Тон', tagName: 'Жуткие странности' },
  ]);
  assert.equal(hard.includes('ассоциации'), false);
});

test('посев тайны даёт 1–2 имени без готовых карточек', () => {
  const domain = { characters: [{ name: 'Паэла' }], lore: [] };
  const one = offerMysterySeedNames({
    world: { namePool: { female: ['Айра', 'Найра', 'Вера'], male: ['Кален', 'Норвел'] } },
    domain,
    rng: () => 0.1,
  });
  assert.equal(one.length, 1);
  assert.ok(one[0].name);
  assert.notEqual(String(one[0].name).toLowerCase(), 'паэла');
  assert.ok(['male', 'female'].includes(one[0].gender));
  assert.equal(one[0].role, undefined);
  assert.equal(one[0].about, undefined);
  const two = offerMysterySeedNames({
    world: { namePool: { female: ['Айра', 'Найра'], male: ['Кален', 'Норвел'] } },
    domain,
    rng: () => 0.9,
  });
  assert.equal(two.length, 2);
  assert.notEqual(two[0].name, two[1].name);
});

test('посев даёт 1–2 готовых человека из пула', () => {
  const domain = { characters: [{ name: 'Паэла' }], lore: [] };
  const one = mintSeedCast({
    world: { namePool: { female: ['Айра', 'Найра', 'Вера'], male: ['Кален', 'Норвел'] } },
    domain,
    rng: () => 0.1,
  });
  assert.equal(one.length, 1);
  assert.ok(one[0].name);
  assert.notEqual(String(one[0].name).toLowerCase(), 'паэла');
  assert.ok(['male', 'female'].includes(one[0].gender));
  assert.ok(one[0].role);
  assert.ok(one[0].about);
  assert.ok(one[0].ageYears >= 18);
  const two = mintSeedCast({
    world: { namePool: { female: ['Айра', 'Найра'], male: ['Кален', 'Норвел'] } },
    domain,
    rng: () => 0.9,
  });
  assert.equal(two.length, 2);
  assert.notEqual(two[0].name, two[1].name);
  assert.notEqual(two[0].role, two[1].role);
});

test('жребий источника уважает вес: unknown чаще economic', () => {
  const cfg = plotConfig({
    tick: {
      plot: {
        tagGroups: [
          {
            id: 'source',
            name: 'Источник',
            tags: [
              { id: 'economic', name: 'Экономическая сила', weight: 1 },
              { id: 'unknown', name: 'Неизвестное', weight: 3 },
            ],
          },
        ],
      },
    },
  });
  const picks = [0.1, 0.4, 0.7, 0.9].map((r) => pickPlotTags(cfg, () => r)[0].tagId);
  assert.deepEqual(picks, ['economic', 'unknown', 'unknown', 'unknown']);
});

test('стартовый посев считает 1–2 истории', () => {
  assert.equal(openingPlotCount({ genesis: { openingPlots: { min: 1, max: 1 } } }), 1);
  assert.equal(openingPlotCount({ genesis: { openingPlots: { min: 2, max: 2 } } }), 2);
});

test('продолжение сеется с крючком в освободившийся слот, даже если другие истории живы', () => {
  const cfg = plotConfig({ tick: { plot: { board: { sequelChance: 0.55, maxOpen: 5 } } } });
  const offer = { id: 'plot_old', hook: 'Осталась неназванная угроза.' };
  assert.equal(pickSequelSeed({ plotlines: [] }, [offer], cfg, () => 0), offer);
  assert.equal(pickSequelSeed({ plotlines: [] }, [offer], cfg, () => 0.9), null);
  assert.equal(pickSequelSeed({ plotlines: [] }, [{ id: 'plot_old', hook: '' }], cfg, () => 0), null);
  assert.equal(
    pickSequelSeed({ plotlines: [{ kind: 'story' }] }, [offer], cfg, () => 0),
    offer,
  );
  assert.equal(
    pickSequelSeed(
      { plotlines: [{ kind: 'story' }, { kind: 'story' }, { kind: 'story' }, { kind: 'story' }, { kind: 'story' }] },
      [offer],
      cfg,
      () => 0,
    ),
    null,
  );
});

test('нити указов не заполняют доску и не глушат посев', () => {
  const cfg = plotConfig({ tick: { plot: { board: { seedCooldownMonths: 2 } } } });
  assert.equal(plotSeedChance({ plotlines: [{ kind: 'order', createdTick: 10 }] }, cfg, 10), 1);
  assert.equal(liveStoryImportance({ plotlines: [{ kind: 'order', importance: 80 }] }), 0);
});

test('процессы занимают лимит тика, случайная история в остаток не проходит', () => {
  const domain = {
    plotlines: [
      plot('p_proc', { kind: 'errand', relatedProcessIds: ['act_1'] }),
      plot('p_story', { kind: 'story', relatedProcessIds: [], temperature: 90, importance: 80 }),
    ],
    state: { pendingActions: [{ id: 'act_1', status: 'active' }] },
  };
  const { beats, slotsUsed, cap } = planBeats({
    domain,
    config: { tick: { plot: { beats: { maxPerTick: 1, minChance: 1, maxChance: 1, baseChance: 1 } } } },
    processOutcomes: [{ processId: 'act_1', mustNarrate: true, finished: true, kind: 'normal', summary: 'Ров' }],
    rng: () => 0,
  });
  assert.equal(cap, 1);
  assert.equal(slotsUsed, 1);
  assert.ok(beats.some((b) => b.plotId === 'p_proc' && b.mandatory));
  assert.equal(beats.some((b) => b.plotId === 'p_story' && !b.fade), false);
});

test('масштаб трёхтактной истории берётся из gravity, не из importance', () => {
  assert.equal(plotScale({ kind: 'story', storyType: 'suspense', gravity: 80, importance: 10 }), 80);
  assert.equal(plotScale({ kind: 'story', importance: 55 }), 55);
  assert.equal(
    liveStoryImportance({
      plotlines: [
        { kind: 'story', storyType: 'mystery', gravity: 70, importance: 10 },
        { kind: 'story', importance: 20 },
        { kind: 'errand', importance: 90 },
      ],
    }),
    90,
  );
});
