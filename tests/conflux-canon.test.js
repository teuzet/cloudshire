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
  formatCityViewPrompt,
  stampPairImpact,
  FROZEN_SYNOPSIS_PREFIX,
  spreadChronicleToPair,
  judgeChronicleLeak,
} from '../src/game/confluxCanon.js';
import { createPlotline } from '../src/game/plotlines.js';
import { loadConfig } from '../src/config.js';

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

test('дело с пометкой через проход касается обоих без судьи', () => {
  assert.equal(
    chronicleConcernFromData({
      process: { crossIsland: true },
      domain: city('a', 'Аллерия'),
      partner: city('b', 'Керсай'),
      conflux: pair(),
    }),
    'both',
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

test('поручение без пометки через проход — решение судьи', () => {
  assert.equal(
    chronicleConcernFromData({
      process: { id: 'act_home' },
      domain: city('a', 'Аллерия'),
      partner: city('b', 'Керсай'),
      conflux: pair(),
    }),
    'judge',
  );
});

test('место: удар по соседу — на проходе, иначе у себя', () => {
  const a = city('a', 'Аллерия');
  const b = city('b', 'Керсай');
  assert.equal(placeForBeat({ process: { targetDomainId: 'b' }, domain: a, partner: b }), PLACE_PAIR);
  assert.equal(placeForBeat({ process: { crossIsland: true }, domain: a, partner: b }), PLACE_PAIR);
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

test('кросс-островное поручение без нити сразу идёт в хронику пары', async () => {
  const a = city('a', 'Аллерия');
  const b = city('b', 'Керсай');
  const conflux = pair();
  const world = { tickIndex: 5, gameDate: { label: 'Год 1, месяц 5' } };
  const fact = { text: 'Ночью ударили по Аллерии и увели зерно.', secret: false };
  const runtime = {
    async run({ agentId, tools }) {
      if (agentId === 'confluxLeak') {
        throw new Error('судью утечки звать не должны');
      }
      if (agentId === 'subjectificator') {
        await tools[0].handler({ text: 'Ночью на нас напали с чужого берега.' });
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
    plot: null,
    process: { id: 'act_raid', crossIsland: true, targetDomainId: 'b' },
    fact,
    day: 50,
  });
  assert.equal(out.concern, 'both');
  assert.equal(out.fromData, 'both');
  assert.equal(out.first, false);
  assert.equal(conflux.lore.length, 1);
  assert.equal(b.lore.length, 1);
});

test('непомеченное поручение на стыковке зовёт судью утечки', async () => {
  const a = city('a', 'Аллерия');
  const b = city('b', 'Керсай');
  const conflux = pair();
  const world = { tickIndex: 5, gameDate: { label: 'Год 1, месяц 5' } };
  const fact = { text: 'Ночью ударили по Аллерии и увели зерно.', secret: false };
  const runtime = {
    async run({ agentId, tools }) {
      if (agentId === 'confluxLeak') {
        await tools[0].handler({ both: true });
      }
      if (agentId === 'subjectificator') {
        await tools[0].handler({ text: 'Ночью на нас напали с чужого берега.' });
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
    plot: null,
    process: { id: 'act_home' },
    fact,
    day: 50,
  });
  assert.equal(out.concern, 'both');
  assert.equal(out.fromData, 'judge');
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
  assert.doesNotMatch(archive, /сейчас/);
});

test('взгляд жертвы не переворачивает, кто напал', () => {
  const text = formatCityViewPrompt({
    viewerName: 'Аллерия',
    neighborName: 'Керсай',
    actorName: 'Керсай',
    hostile: true,
    sourceText: 'Маршал Орена провела отряд на Аллерию. Керсай взял зерно.',
  });
  assert.match(text, /действовал город «Керсай»/);
  assert.match(text, /к нам пришли/);
  assert.match(text, /Не пиши, что мы ходили на «Керсай»/);
  assert.match(text, /Календарную дату в текст не пиши/);
});

test('канон мира: сопряжение — событие, а ходят по проходу', () => {
  const cfg = loadConfig();
  assert.match(cfg.world.cosmology, /событие и пора.*а не место/s);
  assert.match(cfg.world.cosmology, /но не "через сопряжение"/);
  assert.match(cfg.world.cosmology, /Ходят по проходу/);
  const view = cfg.agents.subjectificator.instructions;
  assert.match(view, /сопряжение — событие и пора, а не место/);
  assert.match(view, /в запись не переноси\s+ниоткуда/);
  assert.match(view, /И источник, и архив пары писали у соседа/);
  assert.match(view, /пиши развёрнуто, не сводкой/);
});

test('жертве не видно ни чужого замысла, ни нужды соседа', () => {
  const view = loadConfig().agents.subjectificator.instructions;
  assert.match(view, /ЧУЖОЙ ЗАМЫСЕЛ ОТСЮДА ТОЖЕ НЕ ВИДЕН/);
  assert.match(view, /чего ему не хватало/);
  assert.match(view, /Пиши: взяли зерно/);

  const text = formatCityViewPrompt({
    viewerName: 'Аллерия',
    neighborName: 'Керсай',
    actorName: 'Керсай',
    hostile: true,
    sourceText: 'Маршал Орена вывела необходимые Керсаю припасы с чужого берега.',
  });
  assert.match(text, /Зачем это было «Керсай», отсюда тоже не видно/);
  assert.match(text, /чужую нужду и чужой расчёт — нет/);
});

test('жертве не пересказывают проход заново: подробность в случившемся', () => {
  const text = formatCityViewPrompt({
    viewerName: 'Аллерия',
    neighborName: 'Керсай',
    sourceText: 'Ночью через проход пришёл отряд.',
  });
  assert.match(text, /Проход в летописи уже описан/);
  assert.match(text, /не в описании прохода/);
  assert.match(loadConfig().agents.subjectificator.instructions, /Заново его не описывай/);
});

test('жертве не называют чужого сановника, даже если он стоит в источнике', () => {
  const text = formatCityViewPrompt({
    viewerName: 'Аллерия',
    neighborName: 'Керсай',
    actorName: 'Керсай',
    hostile: true,
    sourceText: 'Маршал Орена провела отряд на Аллерию. Керсай взял зерно.',
  });
  assert.match(text, /в запись не переноси ниоткуда/);
  // Архив пары — дословная хроника нападавшего, поблажки по нему быть не может.
  assert.doesNotMatch(text, /Назвать можно/);
  assert.match(text, /Своих называй/);
  // Запись берега — не сводка: жертве есть что описать и без чужих имён.
  assert.match(text, /не короче четырёх предложений/);
});

test('удар с чужого берега помечает след для статов жертвы', () => {
  const fact = { id: 'lore_v' };
  stampPairImpact(fact, {
    process: {
      finishKind: 'crit',
      objectiveDays: 27,
      crossIsland: true,
      durationBand: 'WEEKS',
      difficulty: 'SEVERE',
    },
    actorId: 'a',
    hostile: true,
  });
  assert.equal(fact.pairImpact.hostile, true);
  assert.equal(fact.pairImpact.finish, 'crit');
  assert.equal(fact.pairImpact.objectiveDays, 27);
  // Полосы нужны жертве: своего дела у неё нет, а цену считают по ним.
  assert.equal(fact.pairImpact.crossIsland, true);
  assert.equal(fact.pairImpact.durationBand, 'WEEKS');
  assert.equal(fact.pairImpact.difficulty, 'SEVERE');
});
