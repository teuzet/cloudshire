import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleSuspenseGravity,
  sampleSuspenseDepth,
  rollSuspenseSeed,
  characterPlotOccupancy,
} from '../src/game/suspenseSeed.js';
import { judgeSuspenseCore, autoTickPrefersDeepen } from '../src/game/suspenseGraph.js';
import { applyStoryActMove } from '../src/game/storyActs.js';
import { plotConfig, createPlotline, judgePlotSeed, stripPlotSecrets } from '../src/game/plotlines.js';
import { addCityEntity } from '../src/game/cityEntities.js';

const ACTS = { acts: { maxEscalations: 3, worsenMin: 1.1, worsenMax: 1.1, dampMin: 0.9, dampMax: 0.9 } };

test('gravity посева: пустая доска 20–100, полная доска уже, сиквел не ниже оригинала', () => {
  const empty = sampleSuspenseGravity({ plotlines: [] }, { rng: () => 0 });
  const emptyHigh = sampleSuspenseGravity({ plotlines: [] }, { rng: () => 0.999 });
  assert.equal(empty, 20);
  assert.equal(emptyHigh, 100);

  const busy = {
    plotlines: [
      { kind: 'story', storyType: 'suspense', gravity: 80, importance: 80 },
    ],
  };
  const lo = sampleSuspenseGravity(busy, { rng: () => 0 });
  const hi = sampleSuspenseGravity(busy, { rng: () => 0.999 });
  assert.equal(lo, 20);
  assert.equal(hi, 70);

  const sequel = sampleSuspenseGravity(busy, { fromClosed: { gravity: 80 }, rng: () => 0 });
  const sequelHi = sampleSuspenseGravity(busy, { fromClosed: { gravity: 80 }, rng: () => 0.999 });
  assert.equal(sequel, 80);
  assert.equal(sequelHi, 100);

  const opening = sampleSuspenseGravity({ plotlines: [] }, { opening: true, rng: () => 0.999 });
  assert.equal(opening, 40);
});

test('depth смещён gravity, четвёрка только при высокой gravity', () => {
  const dLow = sampleSuspenseDepth(22, { rng: () => 0.5 });
  assert.equal(dLow, 1);
  const dMid = sampleSuspenseDepth(50, { rng: () => 0.5 });
  assert.equal(dMid, 2);
  const dHigh = sampleSuspenseDepth(80, { rng: () => 0.5 });
  assert.equal(dHigh, 3);

  let four = 0;
  for (let i = 0; i < 4000; i += 1) {
    if (sampleSuspenseDepth(90, { rng: Math.random, cfg: { suspense: { depth4Chance: 0.03, depth4MinGravity: 75 } } }) === 4) {
      four += 1;
    }
  }
  assert.ok(four > 0 && four < 400, `depth 4 rate ${four}/4000`);

  const forced = sampleSuspenseDepth(90, {
    rng: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n === 1 ? 0.5 : 0.01;
      };
    })(),
    cfg: { suspense: { depth4Chance: 1, depth4MinGravity: 75 } },
  });
  assert.equal(forced, 4);
  assert.equal(
    sampleSuspenseDepth(40, { rng: () => 0.5, cfg: { suspense: { depth4Chance: 1, depth4MinGravity: 75 } } }),
    2,
  );
});

test('judge саспенса depth>=2 требует лестницу и скрытое, без утечки в хронику', () => {
  const draft = {
    title: 'Холодный Ход',
    entry: 'Разведчики нашли пещеру, из которой веет холодом.',
    synopsis: `${'Дальше история должна жить своей жизнью и не обрываться на полуслове. '.repeat(4)} Пещера дышит холодом.`,
    hiddenPremises: ['Холод идёт через древнюю искусственную шахту к нижней стороне острова.', 'В глубине запечатанная камера.'],
    discoveryLadder: [
      { id: 'cold_source', promise: 'выяснить природу холода' },
      { id: 'shaft', promise: 'обнаружить искусственную структуру' },
      { id: 'chamber', promise: 'поставить город перед находкой' },
    ],
    closureGate: 'Город должен узнать глубинную природу хода, не только вход.',
  };
  assert.equal(judgeSuspenseCore(draft, 3), null);
  assert.equal(judgePlotSeed({ plotlines: [] }, draft, { storyType: 'suspense', depth: 3 }), null);
  assert.equal(judgeSuspenseCore({ ...draft, discoveryLadder: draft.discoveryLadder.slice(0, 1) }, 3), 'bad_ladder');
  const leak = {
    ...draft,
    entry: 'Разведчики нашли пещеру. Холод идёт через древнюю искусственную шахту к нижней стороне острова.',
  };
  assert.equal(judgeSuspenseCore(leak, 3), 'hidden_leak');
});

test('бюджет hiddenPremises: depth 1 не больше одной посылки', () => {
  const one = {
    title: 'Капля',
    entry: 'У порога вода вернулась к седьмому удару.',
    synopsis: `${'Дальше история должна жить своей жизнью и не обрываться на полуслове. '.repeat(4)} Удар сбился.`,
    hiddenPremises: ['Седьмой удар открывает лишний сток в нижний ход.'],
  };
  assert.equal(judgeSuspenseCore(one, 1), null);
  assert.equal(
    judgeSuspenseCore(
      {
        ...one,
        hiddenPremises: [
          'Седьмой удар открывает лишний сток в нижний ход.',
          'Старый обряд передал источник городу.',
          'Кладка больше не держит воду.',
        ],
      },
      1,
    ),
    'hidden_over_budget',
  );
});

test('auto-tick deepening не эскалирует сразу, после двух холостых — да', () => {
  assert.equal(autoTickPrefersDeepen('deepening', { unattendedBeats: 0 }), true);
  assert.equal(autoTickPrefersDeepen('deepening', { unattendedBeats: 2 }), false);
  assert.equal(autoTickPrefersDeepen('deadline', { unattendedBeats: 0 }), false);
  assert.equal(autoTickPrefersDeepen('deepening', { closureUnlocked: true }), false);

  const plot = createPlotline({
    title: 'Ход',
    kind: 'story',
    storyType: 'suspense',
    depth: 3,
    dynamic: 'deepening',
    gravity: 40,
    urgency: 40,
    discoveryLadder: [
      { id: 'a', promise: 'один' },
      { id: 'b', promise: 'два' },
      { id: 'c', promise: 'три' },
    ],
  });
  const m1 = applyStoryActMove(plot, { trigger: 'auto', rng: () => 0, config: ACTS });
  assert.equal(m1.progress, 'DEEPEN');
  assert.equal(plot.escalationLevel, 0);
  assert.equal(plot.discoveryLadder[0].revealed, false);
  applyStoryActMove(plot, { trigger: 'auto', rng: () => 0, config: ACTS });
  const m3 = applyStoryActMove(plot, { trigger: 'auto', rng: () => 0, config: ACTS });
  assert.equal(m3.progress, 'SETBACK');
  assert.equal(plot.escalationLevel, 1);
});

test('занятость персонажей считает только открытые нити', () => {
  const domain = {
    characters: [{ name: 'Паэла' }],
    plotlines: [{ id: 'plot_live', kind: 'story' }],
    lore: [
      {
        tags: ['character'],
        name: 'Левра',
        role: 'переписчица',
        relatedPlotlineIds: ['plot_live'],
        status: 'alive',
      },
      {
        tags: ['character'],
        name: 'Кален',
        role: 'страж',
        relatedPlotlineIds: ['plot_old'],
        status: 'alive',
      },
    ],
  };
  const occ = characterPlotOccupancy(domain);
  assert.equal(occ.busy.map((c) => c.name).join(), 'Левра');
  assert.equal(occ.free.map((c) => c.name).join(), 'Кален');
  assert.ok(!occ.busy.find((c) => c.name === 'Паэла'));
  assert.ok(!occ.free.find((c) => c.name === 'Паэла'));
});

test('скрытое саспенса снимается с публичной карточки', () => {
  const plot = createPlotline({
    title: 'Ход',
    kind: 'story',
    storyType: 'suspense',
    depth: 3,
    hiddenPremises: ['шахта к низу острова'],
    discoveryLadder: [
      { id: 'a', promise: 'холод' },
      { id: 'b', promise: 'шахта' },
      { id: 'c', promise: 'камера' },
    ],
    closureGate: 'узнать природу хода',
  });
  const pub = stripPlotSecrets(plot);
  assert.equal(pub.hiddenPremises, undefined);
  assert.equal(pub.discoveryLadder, undefined);
  assert.equal(pub.closureGate, undefined);
  assert.equal(pub.title, 'Ход');
});

test('rollSuspenseSeed кладёт gravity и depth до генератора', () => {
  const cfg = plotConfig({
    tick: {
      plot: {
        tagGroups: [
          { id: 'tone', name: 'Тон', tags: [{ id: 'uncanny', name: 'Жуткий', weight: 1 }] },
          { id: 'source', name: 'Источник', tags: [{ id: 'unknown', name: 'Неизвестное', weight: 1 }] },
          { id: 'situation', name: 'Ситуация', tags: [{ id: 'opportunity', name: 'Возможность', weight: 1 }] },
          { id: 'dynamic', name: 'Динамика', tags: [{ id: 'deepening', name: 'Углубление', weight: 1 }] },
        ],
      },
    },
  });
  const seed = rollSuspenseSeed({ domain: { plotlines: [] }, cfg, rng: () => 0.5 });
  assert.ok(seed.gravity >= 20 && seed.gravity <= 100);
  assert.ok(seed.depth >= 1 && seed.depth <= 4);
  assert.equal(seed.source, 'unknown');
  assert.equal(seed.dynamic, 'deepening');
});

test('addCityEntity не плодит дубли', () => {
  const domain = { cityEntities: [] };
  const a = addCityEntity(domain, { kind: 'place', name: 'Холодный Ход', about: 'Пещера с холодом.' });
  const b = addCityEntity(domain, { kind: 'place', name: 'Холодный Ход', about: 'Другое.' });
  assert.equal(a.name, 'Холодный Ход');
  assert.equal(b.name, a.name);
  assert.equal(domain.cityEntities.length, 1);
});
