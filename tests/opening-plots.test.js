import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { voidSeedPackArgs } from '../src/game/storyteller.js';
import { openingGrain } from '../src/game/seedChannels.js';
import {
  OPENING_STORY_GRAVITIES,
  OPENING_STORY_GRAINS,
  OPENING_SEED_REAL_MINUTES,
  openingSeedDelays,
  enqueueOpeningSeeds,
  enqueueSeedRequest,
  seedQueue,
} from '../src/game/seedSchedule.js';
import { seedAppearEvent } from '../src/game/worldLoop.js';
import { jobList } from '../src/game/scheduler.js';
import { isStakedStory } from '../src/game/plotlines.js';
import { liveThreats } from '../src/game/threats.js';

const ENDINGS = [
  { id: 'g', text: 'Уладили.', kind: 'GOOD_ENDING' },
  { id: 'n', text: 'Привыкли.', kind: 'NEUTRAL_ENDING' },
  { id: 'b', text: 'Сломалось.', kind: 'BAD_ENDING' },
];

const silentLog = { info() {}, warn() {}, error() {}, child() { return silentLog; } };

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
          hiddenPremises: [],
        });
        return;
      }
      if (opts.agentId === 'threatSmith') {
        await tool.handler({ threats: ['Опора мостков сядет'] });
        return;
      }
      if (opts.agentId === 'freeformUrgency') {
        await tool.handler({ urgency: 'MEDIUM' });
      }
    },
  };
}

function makeDomain() {
  return {
    id: 'domain_test',
    name: 'Варшела',
    cityBrief: 'Вертикальный город вокруг Праотца, джунгли давят на край освоенного ядра.',
    stats: { prosperity: 40 },
    plotlines: [],
    lore: [],
    state: {},
  };
}

test('стартовые нити появляются в окне 5–10 минут, каждая своим днём', () => {
  // Игровой день — 4 реальные минуты, так что окно укладывается в 1–3 дня.
  assert.deepEqual(OPENING_SEED_REAL_MINUTES, [5, 10]);
  for (const rng of [() => 0, () => 0.5, () => 0.999]) {
    const days = openingSeedDelays(2, { rng });
    assert.equal(days.length, 2);
    assert.ok(days[0] >= 1, `первая нить не в день основания: ${days[0]}`);
    assert.ok(days[1] > days[0], `две вести в один день слиплись бы: ${days}`);
    assert.ok(days[1] <= 3, `окно не растянулось: ${days}`);
  }
});

test('генезис ставит одну заявку кризиса из брифа, а не сажает нить на месте', () => {
  const domain = makeDomain();
  const requests = enqueueOpeningSeeds(domain, { day: 223, rng: () => 0.5 });

  assert.deepEqual(OPENING_STORY_GRAVITIES, ['CRISIS']);
  assert.deepEqual(OPENING_STORY_GRAINS, ['genesis']);
  assert.equal(domain.plotlines.length, 0, 'на месте не сажаем: иначе рассказать о ней некому');
  assert.equal(seedQueue(domain).length, 1);
  assert.equal(requests[0].gravity, 'CRISIS');
  assert.equal(requests[0].grain, 'genesis');
  assert.ok(requests[0].appearDay > 223);
});

test('появление стартовой нити рассказывается как новая история', async () => {
  const domain = makeDomain();
  const world = { id: 'w1', tickIndex: 0, dayIndex: 223, jobs: [] };
  const [request] = enqueueOpeningSeeds(domain, { day: 223, rng: () => 0.5 });
  const calls = [];

  const res = await seedAppearEvent({
    config: loadConfig(),
    runtime: openingRuntime(calls),
    domain,
    world,
    day: request.appearDay,
    requestId: request.id,
    rng: () => 0.5,
    log: silentLog,
  });

  assert.equal(res.occasion, 'новая история', 'иначе глашатай про нить промолчит');
  assert.equal(res.plot.gravity, 'CRISIS', 'тяжесть берётся из заявки, а не из броска');
  assert.ok(isStakedStory(res.plot));
  assert.equal(res.fact.day, request.appearDay, 'запись хроники датирована днём появления');
  assert.equal(res.fact.sourcePlotId, res.plot.id);
  assert.ok(liveThreats(res.plot).length >= 1, 'нить без угрозы событий не производит');
  assert.ok(
    jobList(world).some((j) => j.kind === 'pressure_fire'),
    'шкала стартовой нити встала в очередь',
  );
  assert.equal(seedQueue(domain).length, 0, 'стартовая заявка одна и уже разобрана');

  assert.equal(calls.length, 1);
  assert.match(calls[0].extra, /БРИФ ГОРОДА/);
  assert.match(calls[0].user, /Вертикальный город вокруг Праотца/);
  assert.doesNotMatch(calls[0].extra, /НЕТ ЗАТРАВКИ/);
  assert.doesNotMatch(calls[0].user, /cityBrief|Срез каталога/i);
});

test('появление нити из пустоты не берёт бриф', async () => {
  const domain = makeDomain();
  const world = { id: 'w1', tickIndex: 0, dayIndex: 223, jobs: [] };
  const request = enqueueSeedRequest(domain, {
    source: 'void',
    grain: 'void',
    gravity: 'EPISODE',
    day: 223,
    delayDays: 1,
  });
  const calls = [];

  const res = await seedAppearEvent({
    config: loadConfig(),
    runtime: openingRuntime(calls),
    domain,
    world,
    day: request.appearDay,
    requestId: request.id,
    rng: () => 0.5,
    log: silentLog,
  });

  assert.equal(res.occasion, 'новая история');
  assert.equal(res.plot.gravity, 'EPISODE');
  assert.equal(calls.length, 1);
  assert.match(calls[0].extra, /НЕТ ЗАТРАВКИ/);
  assert.doesNotMatch(calls[0].extra, /БРИФ ГОРОДА/);
  assert.doesNotMatch(calls[0].user, /Праотца/);
});

test('зерно стартовой нити — описание города и заданная тяжесть', () => {
  const grain = openingGrain(makeDomain(), { gravity: 'EPISODE' });
  assert.equal(grain.grain, 'genesis');
  assert.equal(grain.gravity, 'EPISODE');
  assert.equal(grain.fromGenesis, true);
  assert.equal(grain.fromVoid, false);
  assert.match(grain.seedText, /Праотца/);
  assert.equal(openingGrain({}, { gravity: 'EPISODE' }), null, 'без описания зерна нет');
});

test('посев из описания города отдаёт стандартный бриф, не каталог сущностей', () => {
  const domain = {
    name: 'Варшела',
    cityBrief: 'Вертикальный город вокруг Праотца, джунгли давят на край освоенного ядра.',
    description: 'Длинный генезис, который агентам тика не нужен.',
    cityEntities: [
      { kind: 'custom', name: 'Обмен хлебом', about: 'На равноденствие дворы меняются караваями.' },
    ],
  };
  const grain = openingGrain(domain, { gravity: 'SITUATION' });
  assert.match(grain.seedText, /Праотца/);
  assert.doesNotMatch(grain.seedText, /Обмен хлебом|Срез каталога|Длинный генезис/);
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
