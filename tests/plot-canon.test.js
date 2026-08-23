import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePlotline,
  findClosedPlotline,
  plotCanFade,
  plotConfig,
  plotHasActiveProcess,
  pickPlotTags,
  pickSequelSeed,
  plotSeedChance,
  liveStoryImportance,
  judgePlotSeed,
  reopenClosedPlotline,
} from '../src/game/plotlines.js';
import { ensureErrandForProcess, planBeats } from '../src/game/plotEngine.js';
import { peopleUnderWatch, priorPlotChronicle } from '../src/game/storyteller.js';

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
  const beats = planBeats({
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

test('каталог завязки: характер, сфера-статы, источник, масштаб', async () => {
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  const cfg = plotConfig(config);
  const byId = Object.fromEntries(cfg.tagGroups.map((g) => [g.id, g]));
  assert.ok(byId.character && byId.sphere && byId.source && byId.scale);
  assert.equal(byId.spark, undefined);
  assert.ok(byId.sphere.tags.length >= 6);
  const any = byId.source.tags.find((t) => t.id === 'any');
  assert.ok(any && Number(any.weight) > 1);
});

test('жребий масштаба уважает вес: город чаще квартала', () => {
  const cfg = plotConfig({
    tick: {
      plot: {
        tagGroups: [
          {
            id: 'scale',
            name: 'Масштаб',
            tags: [
              { id: 'quarter', name: 'Квартал', weight: 1 },
              { id: 'city', name: 'Город', weight: 3 },
            ],
          },
        ],
      },
    },
  });
  const picks = [0.1, 0.4, 0.7, 0.9].map((r) => pickPlotTags(cfg, () => r)[0].tagId);
  assert.deepEqual(picks, ['quarter', 'city', 'city', 'city']);
});

test('продолжение сеется только с крючком, пустой доской и по шансу', () => {
  const cfg = plotConfig({ tick: { plot: { board: { sequelChance: 0.55 } } } });
  const offer = { id: 'plot_old', hook: 'Осталась неназванная угроза.' };
  assert.equal(pickSequelSeed({ plotlines: [] }, [offer], cfg, () => 0), offer);
  assert.equal(pickSequelSeed({ plotlines: [] }, [offer], cfg, () => 0.9), null);
  assert.equal(pickSequelSeed({ plotlines: [] }, [{ id: 'plot_old', hook: '' }], cfg, () => 0), null);
  assert.equal(
    pickSequelSeed({ plotlines: [{ kind: 'story' }] }, [offer], cfg, () => 0),
    null,
  );
});
