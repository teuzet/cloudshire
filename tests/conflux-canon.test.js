import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chronicleConcernFromData,
  placeForBeat,
  PLACE_PAIR,
  hasLeakedToPair,
  markLeakedToPair,
  appendPairEntry,
  freezePlotSynopsis,
  formatPairArchive,
  FROZEN_SYNOPSIS_PREFIX,
  spreadChronicleToPair,
  judgeChronicleLeak,
} from '../src/game/confluxCanon.js';
import { createPlotline } from '../src/game/plotlines.js';

function city(id, name) {
  return { id, name, lore: [], plotlines: [] };
}

function pair() {
  return {
    id: 'cf1',
    status: 'docked',
    domainIds: ['a', 'b'],
    lore: [],
  };
}

test('без стыковки хроника касается одного города', () => {
  const plot = createPlotline({ title: 'Набеги', kind: 'story' });
  plot.hostDomainId = 'a';
  plot.concernsDomainIds = ['a'];
  assert.equal(
    chronicleConcernFromData({
      plot,
      domain: city('a', 'Аллерия'),
      partner: city('b', 'Керсай'),
      conflux: { status: 'approaching' },
    }),
    'one',
  );
});

test('дело с целью за проходом касается обоих без судьи', () => {
  assert.equal(
    chronicleConcernFromData({
      process: { targetDomainId: 'b' },
      domain: city('a', 'Аллерия'),
      partner: city('b', 'Керсай'),
      conflux: pair(),
    }),
    'both',
  );
});

test('дело в нити соседа касается обоих без судьи', () => {
  const plot = createPlotline({ title: 'Набеги', kind: 'story' });
  plot.hostDomainId = 'b';
  plot.concernsDomainIds = ['b'];
  assert.equal(
    chronicleConcernFromData({
      process: { id: 'act_1' },
      plot,
      domain: city('a', 'Аллерия'),
      partner: city('b', 'Керсай'),
      conflux: pair(),
    }),
    'both',
  );
});

test('домашняя история на стыковке — решение судьи', () => {
  const plot = createPlotline({ title: 'Набеги', kind: 'story' });
  plot.hostDomainId = 'a';
  plot.concernsDomainIds = ['a'];
  assert.equal(
    chronicleConcernFromData({
      process: { id: 'act_1' },
      plot,
      domain: city('a', 'Аллерия'),
      partner: city('b', 'Керсай'),
      conflux: pair(),
    }),
    'judge',
  );
});

test('поручение без цели за проходом остаётся своим', () => {
  assert.equal(
    chronicleConcernFromData({
      process: { id: 'act_home' },
      domain: city('a', 'Аллерия'),
      partner: city('b', 'Керсай'),
      conflux: pair(),
    }),
    'one',
  );
});

test('место: удар по соседу — на проходе, иначе у себя', () => {
  const a = city('a', 'Аллерия');
  const b = city('b', 'Керсай');
  assert.equal(placeForBeat({ process: { targetDomainId: 'b' }, domain: a, partner: b }), PLACE_PAIR);
  assert.equal(placeForBeat({ process: { id: 'act' }, domain: a, partner: b }), 'a');
});

test('замороженный синопсис попадает в архив с пометкой и никого не будит', () => {
  const plot = createPlotline({ title: 'Набеги', kind: 'story', synopsis: 'Твари бьют у кромки.' });
  plot.hostDomainId = 'a';
  const conflux = pair();
  const world = { tickIndex: 4, gameDate: { label: 'Год 1, месяц 4' } };
  const frozen = freezePlotSynopsis(conflux, world, plot, { day: 40, hostId: 'a' });
  assert.match(frozen.text, new RegExp(FROZEN_SYNOPSIS_PREFIX));
  assert.match(frozen.text, /Твари бьют/);
  assert.equal(frozen.frozenSynopsis, true);
  assert.equal(frozen.place, 'a');
  assert.equal(frozen.importance, 'minor');
  const archive = formatPairArchive(conflux, [city('a', 'Аллерия'), city('b', 'Керсай')]);
  assert.match(archive, /архив: не новость/);
  assert.match(archive, /в «Аллерия»/);
});

test('первое просачивание: синопсис, слепок в пару, запись соседу', async () => {
  const plot = createPlotline({ title: 'Набеги', kind: 'story', synopsis: 'Твари бьют у кромки.' });
  plot.hostDomainId = 'a';
  plot.concernsDomainIds = ['a'];
  const a = city('a', 'Аллерия');
  const b = city('b', 'Керсай');
  const conflux = pair();
  const world = { tickIndex: 5, gameDate: { label: 'Год 1, месяц 5' } };
  const fact = { text: 'Тварей согнали к чужому берегу, и они ушли за проход.', secret: false };
  const runtime = {
    async run({ agentId, tools }) {
      if (agentId === 'confluxLeak') {
        await tools[0].handler({ both: true });
      }
      if (agentId === 'subjectificator') {
        await tools[0].handler({ text: 'С нашего берега пришли чужие твари. Откуда — не сказали.' });
      }
      return {};
    },
  };
  const out = await spreadChronicleToPair({
    runtime,
    world,
    conflux,
    domain: a,
    partner: b,
    plot,
    process: { id: 'act_push' },
    fact,
    day: 50,
  });
  assert.equal(out.concern, 'both');
  assert.equal(out.fromData, 'judge');
  assert.equal(out.first, true);
  assert.equal(hasLeakedToPair(plot), true);
  assert.equal(conflux.lore.filter((f) => f.frozenSynopsis).length, 1);
  assert.equal(conflux.lore.filter((f) => !f.frozenSynopsis).length, 1);
  assert.equal(conflux.lore.find((f) => !f.frozenSynopsis).place, 'a');
  assert.equal(b.lore.length, 1);
  assert.match(b.lore[0].text, /твари/i);
  assert.equal(a.lore.length, 0, 'хозяин уже записал у себя, второй раз не пишем');
});

test('повтор той же истории не кладёт второй замороженный синопсис', async () => {
  const plot = createPlotline({ title: 'Набеги', kind: 'story', synopsis: 'Твари бьют у кромки.' });
  plot.hostDomainId = 'a';
  plot.concernsDomainIds = ['a', 'b'];
  plot.shared = true;
  markLeakedToPair(plot, 50);
  const a = city('a', 'Аллерия');
  const b = city('b', 'Керсай');
  const conflux = pair();
  const world = { tickIndex: 6 };
  const out = await spreadChronicleToPair({
    world,
    conflux,
    domain: a,
    partner: b,
    plot,
    process: { id: 'act_2' },
    fact: { text: 'Твари снова полезли на чужой край.' },
    day: 60,
  });
  assert.equal(out.concern, 'both');
  assert.equal(out.fromData, 'both');
  assert.equal(out.first, false);
  assert.equal(out.frozen, null);
  assert.equal(conflux.lore.some((f) => f.frozenSynopsis), false);
  assert.equal(conflux.lore.length, 1);
  assert.equal(b.lore.length, 1);
});

test('тайная запись в архив пары не идёт', async () => {
  const out = await spreadChronicleToPair({
    conflux: pair(),
    domain: city('a', 'А'),
    partner: city('b', 'Б'),
    fact: { text: 'Лазутчики прошли', secret: true },
  });
  assert.equal(out, null);
});

test('судья без рантайма не выдумывает просачивание', async () => {
  assert.equal(await judgeChronicleLeak({ text: 'В порту чинили сваи.' }), 'one');
});

test('архив помечает проход отдельно от городов', () => {
  const conflux = pair();
  const world = { gameDate: { label: 'сейчас' } };
  appendPairEntry(conflux, world, { text: 'На кромке схватились.', place: PLACE_PAIR });
  const archive = formatPairArchive(conflux, [city('a', 'Аллерия'), city('b', 'Керсай')]);
  assert.match(archive, /на проходе/);
});
