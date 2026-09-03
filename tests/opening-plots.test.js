import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { seedOpeningPlots, OPENING_STORY_GRAVITIES, voidSeedPackArgs } from '../src/game/storyteller.js';
import { isStakedStory } from '../src/game/plotlines.js';

const ENDINGS = [
  { id: 'g', text: 'Уладили.', kind: 'GOOD_ENDING' },
  { id: 'n', text: 'Привыкли.', kind: 'NEUTRAL_ENDING' },
  { id: 'b', text: 'Сломалось.', kind: 'BAD_ENDING' },
];

function openingRuntime(calls) {
  let n = 0;
  return {
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformBrainstorm') {
        n += 1;
        calls.push({
          extra: String(opts.extraSystem || ''),
          user: String(opts.userMessages?.[0]?.content || ''),
        });
        await tool.handler({
          candidates: [1, 2, 3].map((i) => ({
            chronicle: `В городе началось дело ${n}.${i}. Дома спорят, кто виноват. Пока никто не решает, ярус давит на соседний.`,
            title: `История ${n}.${i}`,
          })),
        });
        return;
      }
      if (opts.agentId === 'freeformBrainstormJudge') {
        await tool.handler({
          reviews: [1, 2, 3].map((i) => ({ index: i, verdict: 'PASS', summary: 'ок', issues: [] })),
        });
        return;
      }
      if (opts.agentId === 'freeformAssemble') {
        await tool.handler({
          title: `История ${n}`,
          chronicle: `На мостках Варшелы случилось ${n}.`,
          whyMoves: `Если не вмешаться, ${n} спустится к корням.`,
          hiddenPremises: [],
        });
        return;
      }
      if (opts.agentId === 'freeformEndings') {
        await tool.handler({ keep: false, endings: ENDINGS });
        return;
      }
      if (opts.agentId === 'freeformUrgency') {
        await tool.handler({ urgency: 'MEDIUM' });
      }
    },
  };
}

test('генезис сажает ситуацию и эпизод из описания города', async () => {
  assert.deepEqual(OPENING_STORY_GRAVITIES, ['SITUATION', 'EPISODE']);
  const domain = {
    id: 'domain_test',
    name: 'Варшела',
    cityBrief: 'Вертикальный город вокруг Праотца, джунгли давят на край освоенного ядра.',
    stats: { prosperity: 40 },
    plotlines: [],
    lore: [],
  };
  const world = { tickIndex: 0, gameDate: { year: 1, month: 1 } };
  const calls = [];
  const planted = await seedOpeningPlots({
    config: loadConfig(),
    runtime: openingRuntime(calls),
    domain,
    world,
  });
  assert.equal(planted.length, 2);
  assert.equal(domain.plotlines.length, 2);
  assert.equal(domain.plotlines[0].gravity, 'SITUATION');
  assert.equal(domain.plotlines[1].gravity, 'EPISODE');
  assert.ok(domain.plotlines.every((p) => isStakedStory(p)));
  assert.equal((domain.lore || []).length, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.extra, /ОПИСАНИЕ ГОРОДА/);
    assert.match(call.user, /Вертикальный город вокруг Праотца/);
    assert.doesNotMatch(call.extra, /НЕТ ЗАТРАВКИ/);
  }
});

test('пустой посев: 50% генезис города, иначе настоящая пустота', () => {
  const domain = {
    cityBrief: 'Вертикальный город вокруг Праотца.',
  };
  const fromCity = voidSeedPackArgs(domain, { rng: () => 0 });
  assert.equal(fromCity.grain, 'genesis');
  assert.equal(fromCity.fromGenesis, true);
  assert.equal(fromCity.fromVoid, false);
  assert.match(fromCity.seedText, /Праотца/);
  const fromVoid = voidSeedPackArgs(domain, { rng: () => 0.9 });
  assert.equal(fromVoid.grain, 'void');
  assert.equal(fromVoid.fromVoid, true);
  assert.equal(fromVoid.fromGenesis, false);
  assert.equal(fromVoid.seedText, '');
  const noCity = voidSeedPackArgs({}, { rng: () => 0 });
  assert.equal(noCity.grain, 'void');
  assert.equal(noCity.fromVoid, true);
});
