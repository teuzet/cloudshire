import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldConsiderGenesisRewrite,
  maybeRewriteCityGenesis,
  applyCityBriefEdit,
  modifiersNeedCompact,
  endingLabel,
} from '../src/game/genesisRewrite.js';
import { maybeAppendStoryCityModifier } from '../src/game/cityModifier.js';

const brief =
  'Город стоит на уступе над облаками, держит ночной дозор у края и пьёт воду из цистерн верхнего яруса.';

function staked(extra = {}) {
  return {
    id: 'plot_1',
    kind: 'story',
    storyType: 'story',
    title: 'Обвал',
    gravity: 'CRISIS',
    closedTick: 9,
    ending: 'BAD_ENDING',
    ...extra,
  };
}

function closeFact(plotId = 'plot_1') {
  return { plotClosed: true, relatedPlotlineIds: [plotId], text: 'Квартал затопило.' };
}

test('переписывать генезис стоит после critical-хроники или закрытия CRISIS/RUPTURE', () => {
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [] },
      tick: 9,
      chronicleAdds: [{ importance: 'critical', text: 'Стена рухнула.' }],
    }),
    true,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [staked()] },
      tick: 9,
      chronicleAdds: [closeFact()],
    }),
    true,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [staked({ gravity: 'RUPTURE' })] },
      tick: 9,
      chronicleAdds: [closeFact()],
    }),
    true,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [staked({ gravity: 'EPISODE' })] },
      tick: 9,
      chronicleAdds: [closeFact()],
    }),
    false,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [staked()] },
      tick: 9,
      chronicleAdds: [],
    }),
    false,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [] },
      tick: 9,
      chronicleAdds: [{ importance: 'ordinary', text: 'Дождь.' }],
    }),
    false,
  );
});

test('исход закрытой нити в промпт идёт текстом, не [object Object]', () => {
  assert.equal(endingLabel('BAD_ENDING'), 'BAD_ENDING');
  assert.equal(
    endingLabel({ kind: 'BAD_ENDING', text: 'Нодари затопило', endingId: 'storm_ruin' }),
    'BAD_ENDING: Нодари затопило',
  );
  assert.equal(endingLabel(null), '—');
});

test('агент может пропустить правку брифа', async () => {
  const domain = { id: 'd1', name: 'Саркум', cityBrief: brief, closedPlotlines: [staked()] };
  const runtime = {
    async run({ tools }) {
      await tools[0].handler({ skip: true });
    },
  };
  const out = await maybeRewriteCityGenesis({
    runtime,
    domain,
    world: { tickIndex: 9, gameDate: { label: 'Год 1, месяц 10' } },
    chronicleAdds: [closeFact()],
  });
  assert.equal(out, null);
  assert.equal(domain.cityBrief, brief);
});

test('правка подменяет кусок брифа и оставляет остальное', () => {
  const edited = applyCityBriefEdit(brief, {
    find: 'стоит на уступе над облаками',
    replace: 'стоит дальше от обрыва после обвала северного края',
  });
  assert.equal(edited.ok, true);
  assert.match(edited.brief, /стоит дальше от обрыва после обвала северного края/);
  assert.match(edited.brief, /держит ночной дозор у края/);
  assert.match(edited.brief, /пьёт воду из цистерн верхнего яруса/);
  assert.equal(applyCityBriefEdit(brief, { find: brief, replace: 'Новый город с нуля.' }).error, 'whole_brief');
  assert.equal(applyCityBriefEdit(brief, { find: 'нет такого куска в брифе города', replace: 'x' }).error, 'not_found');
});

test('агент правит кусок брифа, если город изменился навсегда', async () => {
  const domain = { id: 'd1', name: 'Саркум', cityBrief: brief, closedPlotlines: [staked()] };
  const runtime = {
    async run({ tools }) {
      await tools[0].handler({
        skip: false,
        find: 'стоит на уступе над облаками',
        replace: 'стоит дальше от обрыва после обвала северного края',
      });
    },
  };
  const out = await maybeRewriteCityGenesis({
    runtime,
    domain,
    world: { tickIndex: 9 },
    chronicleAdds: [closeFact()],
  });
  assert.match(out.brief, /стоит дальше от обрыва после обвала северного края/);
  assert.match(out.brief, /пьёт воду из цистерн верхнего яруса/);
  assert.equal(domain.cityBrief, out.brief);
});

test('накопленные дописки — повод свернуть их в бриф', () => {
  const domain = {
    cityBrief: brief,
    modifiers: [
      { id: 'm1', text: 'Квартал за рекой говорит на чужом языке.' },
      { id: 'm2', text: 'В храме стоит чужой камень с соседнего острова.' },
      { id: 'm3', text: 'У прохода остался рынок, хотя остров ушёл.' },
      { id: 'm4', text: 'Стража помнит чужой берег и ходит иначе.' },
    ],
  };
  assert.equal(modifiersNeedCompact(domain), true);
  assert.equal(
    shouldConsiderGenesisRewrite({ domain, tick: 9, chronicleAdds: [] }),
    true,
  );
});

test('успешная правка брифа очищает дописки', async () => {
  const domain = {
    id: 'd1',
    name: 'Саркум',
    cityBrief: brief,
    modifiers: [
      { id: 'm1', text: 'Квартал за рекой говорит на чужом языке.' },
      { id: 'm2', text: 'В храме стоит чужой камень с соседнего острова.' },
      { id: 'm3', text: 'У прохода остался рынок, хотя остров ушёл.' },
      { id: 'm4', text: 'Стража помнит чужой берег и ходит иначе.' },
    ],
  };
  const runtime = {
    async run({ tools }) {
      await tools[0].handler({
        skip: false,
        find: 'Город стоит на уступе над облаками',
        replace: 'Город стоит на уступе над облаками, и квартал за рекой говорит на чужом языке',
      });
    },
  };
  const out = await maybeRewriteCityGenesis({
    runtime,
    domain,
    world: { tickIndex: 9, gameDate: { label: 'Год 1, месяц 10' } },
  });
  assert.ok(out?.brief);
  assert.equal(domain.modifiers.length, 0);
});

test('модификаторы города больше не дописываются отдельно от компактора', async () => {
  const out = await maybeAppendStoryCityModifier({
    domain: { cityBrief: brief },
    plot: staked(),
    world: { tickIndex: 9 },
  });
  assert.equal(out, null);
});
