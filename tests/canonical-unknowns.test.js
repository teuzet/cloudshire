import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCityBrief,
  formatCityBrief,
  applyCanonicalUnknownReveal,
  matchCanonicalUnknown,
} from '../src/game/cityContext.js';
import { applyCityBriefEdit } from '../src/game/genesisRewrite.js';
import {
  shouldConsiderUnknownsReveal,
  maybeRevealCanonicalUnknowns,
} from '../src/game/unknownsReveal.js';
import { loadConfig } from '../src/config.js';

const body = 'Аллерия стоит ярусами вокруг Праотца, дальше джунгли и северные скалы.';
const unknown = 'источник набегов чудовищ официально не установлен';

function briefWithUnknowns() {
  return formatCityBrief({
    body,
    unknowns: [unknown, 'что на северном плато, люди не видели'],
  });
}

test('parse/format брифа с неизвестностями — круг', () => {
  const text = briefWithUnknowns();
  const parsed = parseCityBrief(text);
  assert.match(parsed.body, /Праотца/);
  assert.deepEqual(parsed.unknowns, [unknown, 'что на северном плато, люди не видели']);
  assert.equal(formatCityBrief(parsed), text);
  assert.equal(parseCityBrief(body).unknowns.length, 0);
});

test('раскрытие снимает пункт и дописывает факт в тело', () => {
  const revealed = 'Следопыты установили: набеги идут из расселины у северных скал.';
  const out = applyCanonicalUnknownReveal(briefWithUnknowns(), { unknown, revealed });
  assert.equal(out.ok, true);
  const parsed = parseCityBrief(out.brief);
  assert.equal(parsed.unknowns.includes(unknown), false);
  assert.deepEqual(parsed.unknowns, ['что на северном плато, люди не видели']);
  assert.match(parsed.body, /расселины у северных скал/);
  assert.equal(applyCanonicalUnknownReveal(out.brief, { unknown, revealed }).error, 'unknown_not_found');
  assert.equal(
    applyCanonicalUnknownReveal(briefWithUnknowns(), { unknown, revealed: 'пока неизвестно' }).error,
    'still_unknown',
  );
});

test('правка места не трогает блок неизвестностей', () => {
  const edited = applyCityBriefEdit(briefWithUnknowns(), {
    find: 'стоит ярусами вокруг Праотца',
    replace: 'стоит дальше от джунглей после вырубки опушки',
  });
  assert.equal(edited.ok, true);
  const parsed = parseCityBrief(edited.brief);
  assert.match(parsed.body, /дальше от джунглей/);
  assert.equal(parsed.unknowns.length, 2);
  assert.equal(matchCanonicalUnknown(parsed.unknowns, unknown), 0);
});

test('агент тика не зовётся без пунктов или без событий месяца', () => {
  assert.equal(
    shouldConsiderUnknownsReveal({
      domain: { cityBrief: body },
      tick: 3,
      chronicleAdds: [{ text: 'Мост рухнул.', author: 'storyteller:beat' }],
    }),
    false,
  );
  assert.equal(
    shouldConsiderUnknownsReveal({
      domain: { cityBrief: briefWithUnknowns() },
      tick: 3,
      chronicleAdds: [{ text: 'Тихий месяц.', author: 'storyteller:quiet' }],
    }),
    false,
  );
  assert.equal(
    shouldConsiderUnknownsReveal({
      domain: { cityBrief: briefWithUnknowns() },
      tick: 3,
      chronicleAdds: [{ text: 'Следопыты нашли логово в расселине.', author: 'storyteller:beat' }],
    }),
    true,
  );
  assert.equal(
    shouldConsiderUnknownsReveal({
      domain: {
        cityBrief: briefWithUnknowns(),
        closedPlotlines: [{ closedTick: 3, ending: 'GOOD_ENDING', synopsis: 'Нашли логово.' }],
      },
      tick: 3,
      chronicleAdds: [],
    }),
    true,
  );
});

test('агент тика закрывает пункт по хронике и пропускает намёк', async () => {
  const domain = { id: 'd1', cityBrief: briefWithUnknowns() };
  const revealed = 'Набеги идут из расселины у северных скал.';
  const runtime = {
    async run({ tools }) {
      await tools[0].handler({ skip: false, unknown, revealed });
    },
  };
  const out = await maybeRevealCanonicalUnknowns({
    runtime,
    domain,
    world: { tickIndex: 4, gameDate: { label: 'Год 1, месяц 5' } },
    chronicleAdds: [{ text: 'Следопыты нашли логово в расселине.', author: 'storyteller:beat' }],
  });
  assert.match(out.revealed, /расселины/);
  assert.equal(parseCityBrief(domain.cityBrief).unknowns.includes(unknown), false);

  const skipped = { id: 'd2', cityBrief: briefWithUnknowns() };
  const skipRuntime = {
    async run({ tools }) {
      await tools[0].handler({ skip: true });
    },
  };
  const none = await maybeRevealCanonicalUnknowns({
    runtime: skipRuntime,
    domain: skipped,
    world: { tickIndex: 4 },
    chronicleAdds: [{ text: 'Рейнджеры ушли в джунгли и вернулись без находки.', author: 'storyteller:beat' }],
  });
  assert.equal(none, null);
  assert.equal(parseCityBrief(skipped.cityBrief).unknowns.length, 2);
});

test('в конфиге есть агент раскрытия неизвестностей', () => {
  const cfg = loadConfig();
  assert.equal(cfg.agents.cityUnknownsReveal.model, 'gpt-5.6-luna');
  assert.match(cfg.agents.cityUnknownsReveal.instructions, /submit_unknowns_reveal/);
  assert.match(cfg.agents.loremaster.instructions, /canonicalUnknowns/);
  assert.match(cfg.agents.cityBrief.instructions, /unknowns/);
});
