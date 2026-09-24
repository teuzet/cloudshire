import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THREAT_TARGET_MIN,
  THREAT_TARGET_MAX,
  SEED_REQUEST_MAX_AGE_DAYS,
  ATTEMPT_INTERVAL_DAYS,
  SEED_COOLDOWN_DAYS,
  rollSeedDelay,
  scheduleNextAttempt,
  applySeedCooldown,
  seedAttemptDue,
  inSeedCooldown,
  countLiveThreats,
  saturationFactor,
  decideSeedAttempt,
  offerErrandSeed,
  initSeedLogRecording,
  enqueueSeedRequest,
  dueSeedRequests,
  dropSeedRequest,
  dropSeedRequestsForOrder,
  checkSeedFreshness,
  postponeSeedRequest,
  chronicleSince,
  seedQueue,
} from '../src/game/seedSchedule.js';
import { createThreat, attachThreat, avertThreats } from '../src/game/threats.js';

/** Хроника домена — записи с тегом chronicle в lore. */
function domain({ chronicle = [], ...extra } = {}) {
  return {
    id: 'd1',
    plotlines: [],
    lore: chronicle.map((f) => ({ tags: ['chronicle'], ...f })),
    state: {},
    ...extra,
  };
}

function stakedPlot(id, threatCount = 0) {
  const p = { id, kind: 'story', storyType: 'story', gravity: 'RUPTURE', threats: [], defenseCount: 0 };
  for (let i = 0; i < threatCount; i += 1) {
    attachThreat(p, createThreat({ plot: p, text: 'беда', band: 'SEASON', day: 0, rng: () => 0.5 }));
  }
  return p;
}

test('срок следующей попытки попадает в заданный интервал', () => {
  const d = domain();
  assert.equal(scheduleNextAttempt(d, 100, () => 0), 100 + ATTEMPT_INTERVAL_DAYS[0]);
  assert.equal(scheduleNextAttempt(d, 100, () => 1), 100 + ATTEMPT_INTERVAL_DAYS[1]);
});

test('после посева домен уходит в холодный период на пару реальных часов', () => {
  const d = domain();
  assert.equal(applySeedCooldown(d, 0, () => 0), SEED_COOLDOWN_DAYS[0]);
  assert.equal(applySeedCooldown(d, 0, () => 1), SEED_COOLDOWN_DAYS[1]);
  assert.ok(SEED_COOLDOWN_DAYS[0] >= 22 && SEED_COOLDOWN_DAYS[1] <= 37);
});

test('без записанного срока первая попытка происходит сразу', () => {
  assert.equal(seedAttemptDue(domain(), 0), true);
  const d = domain();
  scheduleNextAttempt(d, 100, () => 0);
  assert.equal(seedAttemptDue(d, 105), false);
  assert.equal(seedAttemptDue(d, 108), true);
});

test('холодный период кончается сам', () => {
  const d = domain();
  applySeedCooldown(d, 0, () => 0);
  assert.equal(inSeedCooldown(d, 10), true);
  assert.equal(inSeedCooldown(d, 100), false);
  assert.equal(inSeedCooldown(domain(), 0), false);
});

test('живые угрозы считаются по всем городским историям', () => {
  const d = domain({ plotlines: [stakedPlot('p1', 2), stakedPlot('p2', 1)] });
  assert.equal(countLiveThreats(d), 3);
  const [first] = d.plotlines[0].threats;
  avertThreats(d.plotlines[0], [first.id], { day: 1 });
  assert.equal(countLiveThreats(d), 2);
});

test('вольные истории в счёт угроз не идут', () => {
  const d = domain({ plotlines: [{ id: 'f', type: 'conflux', threats: [] }] });
  assert.equal(countLiveThreats(d), 0);
});

test('насыщенность гасит посев и разгоняет его при пустоте', () => {
  assert.ok(saturationFactor(0) > 1, 'пустой город сеет охотнее');
  assert.equal(saturationFactor(2), 1);
  assert.ok(saturationFactor(THREAT_TARGET_MIN) < 1);
  assert.ok(saturationFactor(THREAT_TARGET_MAX) < saturationFactor(THREAT_TARGET_MIN));
  assert.equal(saturationFactor(THREAT_TARGET_MAX + 1), 0, 'выше нормы не сеем вовсе');
});

test('пять слотов сановников — городской посев молчит и греется', () => {
  const d = domain({
    plotlines: [stakedPlot('p1', 0)],
  });
  d.plotlines[0].gravity = 'RUPTURE';
  d.plotlines.push({ ...stakedPlot('p2', 0), gravity: 'SITUATION' });
  d.state.seedTemp = { city: 5, errand: 10 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0 });
  assert.equal(res.seed, false);
  assert.equal(res.reason, 'full');
  assert.equal(d.state.seedTemp.city, 6);
});

test('нулевая городская температура не сеет', () => {
  const d = domain();
  d.state.seedTemp = { city: 0, errand: 10 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0 });
  assert.equal(res.seed, false);
  assert.equal(res.reason, 'roll');
});

test('прохладный город не сеет на высоком жребии', () => {
  const d = domain();
  d.state.seedTemp = { city: 3, errand: 10 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0.999 });
  assert.equal(res.seed, false);
  assert.equal(res.reason, 'roll');
  assert.ok(res.chance > 0 && res.chance < 1);
  assert.equal(d.state.seedTemp.city, 5);
});

test('горячий пустой город сеет сразу и остывает', () => {
  const d = domain();
  d.state.seedTemp = { city: 10, errand: 10 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0 });
  assert.equal(res.seed, true);
  assert.equal(res.chance, 1);
  assert.equal(d.state.seedTemp.city, 4);
  assert.ok(['genesis', 'void', 'chronicle'].includes(res.source));
});

test('решение температуры пишется отдельным документом города', async () => {
  const docs = [];
  initSeedLogRecording({
    appendSeedLog: async (doc) => {
      docs.push(doc);
    },
  });
  try {
    const d = domain();
    d.id = 'domain_hot';
    d.name = 'Тихая Гряда';
    d.state.seedTemp = { city: 10, errand: 10 };
    decideSeedAttempt(d, { day: 40, rng: () => 0 });
    offerErrandSeed(
      d,
      { processId: 'p1', summary: 'обелиск', objectiveMonths: 1 },
      { day: 40, rng: () => 0.99 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(docs.length, 2);
    assert.equal(docs[0].kind, 'city');
    assert.equal(docs[0].domainId, 'domain_hot');
    assert.equal(docs[0].domainName, 'Тихая Гряда');
    assert.equal(docs[0].seed, true);
    assert.equal(docs[0].tempBefore, 10);
    assert.equal(docs[0].tempAfter, 4);
    assert.equal(docs[0].day, 40);
    assert.equal(docs[1].kind, 'errand');
    assert.equal(docs[1].seed, false);
    assert.equal(docs[1].reason, 'roll');
    assert.equal(docs[1].months, 1);
    assert.equal(docs[1].summary, 'обелиск');
    assert.equal(docs[1].domainId, 'domain_hot');
  } finally {
    initSeedLogRecording(null);
  }
});

test('четыре слота ещё позволяют посев, масштаб уже стоящей истории легче', () => {
  const d = domain({ plotlines: [{ ...stakedPlot('p1'), gravity: 'RUPTURE' }] });
  d.state.seedTemp = { city: 10, errand: 10 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0 });
  assert.equal(res.seed, true);
  assert.equal(res.occupied, 4);
});

// ────────────────────── очередь отложенных посевов ──────────────────────

test('большинство посевов появляется сразу, часть — с задержкой', () => {
  assert.equal(rollSeedDelay(() => 0), 0);
  assert.ok(rollSeedDelay(() => 0.7) > 0, 'вторая полоса — недели');
  assert.ok(rollSeedDelay(() => 0.9) >= 60, 'третья полоса — до года');
});

test('заявка помнит зерно и день постановки, а не текст', () => {
  const d = domain();
  const req = enqueueSeedRequest(d, {
    source: 'errand',
    seedFactId: 'f7',
    sourceProcessId: 'proc1',
    day: 100,
    delayDays: 180,
  });
  assert.equal(req.appearDay, 280);
  assert.equal(req.requestedDay, 100);
  assert.equal(req.seedFactId, 'f7');
  assert.ok(!('text' in req), 'текст рождается лениво в момент появления');
  assert.equal(seedQueue(d).length, 1);
});

test('заявка всплывает по своему дню', () => {
  const d = domain();
  const req = enqueueSeedRequest(d, { day: 0, delayDays: 180 });
  assert.deepEqual(dueSeedRequests(d, 179), []);
  assert.deepEqual(dueSeedRequests(d, 180).map((r) => r.id), [req.id]);
  assert.equal(dropSeedRequest(d, req.id), true);
  assert.equal(dropSeedRequest(d, req.id), false);
});

test('отмена правила гасит его отложенные последствия', () => {
  const d = domain();
  enqueueSeedRequest(d, { day: 0, sourceOrderId: 'ord1' });
  enqueueSeedRequest(d, { day: 0, sourceOrderId: 'ord1' });
  enqueueSeedRequest(d, { day: 0, sourceOrderId: 'ord2' });
  assert.equal(dropSeedRequestsForOrder(d, 'ord1'), 2);
  assert.equal(seedQueue(d).length, 1);
});

// ────────────────────────────── свежесть ──────────────────────────────

test('слишком старая заявка выбрасывается', () => {
  const d = domain();
  const req = enqueueSeedRequest(d, { day: 0, delayDays: 0 });
  const res = checkSeedFreshness(d, req, { day: SEED_REQUEST_MAX_AGE_DAYS + 1 });
  assert.equal(res.fresh, false);
  assert.equal(res.reason, 'too_old');
});

test('исчезнувшее зерно — не повод сочинять историю', () => {
  const d = domain();
  const req = enqueueSeedRequest(d, { day: 0, seedFactId: 'f7', delayDays: 10 });
  const res = checkSeedFreshness(d, req, { day: 10 });
  assert.equal(res.fresh, false);
  assert.equal(res.reason, 'fact_gone');
});

test('зерно из открытой сейчас истории даёт конфликт канона', () => {
  const d = domain({
    chronicle: [{ id: 'f7', text: 'мемориал поставлен', sourcePlotId: 'p1', day: 0 }],
    plotlines: [stakedPlot('p1')],
  });
  const req = enqueueSeedRequest(d, { day: 0, seedFactId: 'f7', delayDays: 10 });
  const res = checkSeedFreshness(d, req, { day: 10 });
  assert.equal(res.fresh, false);
  assert.equal(res.reason, 'plot_open');
});

test('закрытая история зерно не блокирует', () => {
  const d = domain({ chronicle: [{ id: 'f7', text: 'мемориал поставлен', sourcePlotId: 'p1', day: 0 }] });
  const req = enqueueSeedRequest(d, { day: 0, seedFactId: 'f7', delayDays: 10 });
  assert.equal(checkSeedFreshness(d, req, { day: 10 }).fresh, true);
});

test('дважды из одного зерна не сеем', () => {
  const d = domain({
    chronicle: [{ id: 'f7', text: 'мемориал поставлен', day: 0 }],
    plotlines: [{ ...stakedPlot('p2'), seedFactId: 'f7' }],
  });
  const req = enqueueSeedRequest(d, { day: 0, seedFactId: 'f7', delayDays: 10 });
  const res = checkSeedFreshness(d, req, { day: 10 });
  assert.equal(res.fresh, false);
  assert.equal(res.reason, 'duplicate');
});

test('полная доска — причина подождать, а не выбросить', () => {
  const d = domain();
  const req = enqueueSeedRequest(d, { day: 0, delayDays: 10 });
  const res = checkSeedFreshness(d, req, { day: 10, boardFull: true });
  assert.equal(res.fresh, false);
  assert.equal(res.reason, 'board_full');
  assert.equal(res.postpone, true);
  postponeSeedRequest(req, 10, () => 0);
  assert.equal(req.postponed, 1);
  assert.equal(req.appearDay, 40);
  assert.equal(req.requestedDay, 0, 'возраст заявки продолжает тикать');
});

test('судье и сборщику достаётся один и тот же срез хроники', () => {
  const d = domain({
    chronicle: [
      { id: 'f1', text: 'до заявки', day: 10 },
      { id: 'f2', text: 'после заявки', day: 120 },
      { id: 'f3', text: 'ещё позже', day: 200 },
    ],
  });
  const req = enqueueSeedRequest(d, { day: 100, delayDays: 100 });
  const slice = chronicleSince(d, req);
  assert.deepEqual(slice.map((f) => f.id), ['f2', 'f3']);
});

test('срез хроники ограничен сверху', () => {
  const d = domain({
    chronicle: Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, text: 'запись', day: 100 + i })),
  });
  const req = enqueueSeedRequest(d, { day: 100, delayDays: 0 });
  assert.equal(chronicleSince(d, req, { limit: 12 }).length, 12);
});
