import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldConsiderGenesisRewrite,
  maybeRewriteCityGenesis,
  applyCityBriefEdit,
} from '../src/game/genesisRewrite.js';
import { maybeAppendStoryCityModifier } from '../src/game/cityModifier.js';

const brief =
  'Город стоит на уступе над облаками, держит ночной дозор у края и пьёт воду из цистерн верхнего яруса.';

function staked(extra = {}) {
  return {
    kind: 'story',
    storyType: 'story',
    title: 'Обвал',
    gravity: 'CRISIS',
    closedTick: 9,
    ending: 'BAD_ENDING',
    ...extra,
  };
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
      chronicleAdds: [],
    }),
    true,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [staked({ gravity: 'RUPTURE' })] },
      tick: 9,
    }),
    true,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [staked({ gravity: 'EPISODE' })] },
      tick: 9,
    }),
    false,
  );
  assert.equal(
    shouldConsiderGenesisRewrite({
      domain: { closedPlotlines: [staked({ closedTick: 8 })] },
      tick: 9,
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
  });
  assert.match(out.brief, /стоит дальше от обрыва после обвала северного края/);
  assert.match(out.brief, /пьёт воду из цистерн верхнего яруса/);
  assert.equal(domain.cityBrief, out.brief);
});

test('модификаторы города больше не дописываются', async () => {
  const out = await maybeAppendStoryCityModifier({
    domain: { cityBrief: brief },
    plot: staked(),
    world: { tickIndex: 9 },
  });
  assert.equal(out, null);
});
