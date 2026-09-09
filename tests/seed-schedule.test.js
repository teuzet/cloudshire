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
  enqueueSeedRequest,
  dueSeedRequests,
  dropSeedRequest,
  dropSeedRequestsForOrder,
  checkSeedFreshness,
  postponeSeedRequest,
  chronicleSince,
  seedQueue,
} from '../src/game/seedSchedule.js';
import { createThreat, attachThreat, defendThreat } from '../src/game/threats.js';

function domain(extra = {}) {
  return {
    id: 'd1',
    plotlines: [],
    chronicle: [],
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
  defendThreat(d.plotlines[0], first, { day: 1 });
  assert.equal(countLiveThreats(d), 2);
});

test('вольные истории в счёт угроз не идут', () => {
  const d = domain({ plotlines: [{ id: 'f', kind: 'story', storyType: 'freeform', threats: [] }] });
  assert.equal(countLiveThreats(d), 0);
});

test('насыщенность гасит посев и разгоняет его при пустоте', () => {
  assert.ok(saturationFactor(0) > 1, 'пустой город сеет охотнее');
  assert.equal(saturationFactor(2), 1);
  assert.ok(saturationFactor(THREAT_TARGET_MIN) < 1);
  assert.ok(saturationFactor(THREAT_TARGET_MAX) < saturationFactor(THREAT_TARGET_MIN));
  assert.equal(saturationFactor(THREAT_TARGET_MAX + 1), 0, 'выше нормы не сеем вовсе');
});

test('перенасыщенный город не сеет', () => {
  const d = domain({ plotlines: [stakedPlot('p1', 3), stakedPlot('p2', 3)] });
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0 });
  assert.equal(res.seed, false);
  assert.equal(res.reason, 'saturated');
});

test('в холодном периоде попытка не сеет', () => {
  const d = domain();
  applySeedCooldown(d, 0, () => 0);
  const res = decideSeedAttempt(d, { day: 5, rng: () => 0 });
  assert.equal(res.seed, false);
  assert.equal(res.reason, 'cooldown');
});

test('холодные каналы не сеют', () => {
  const d = domain();
  d.state.seedTemp = { chronicle: 0, void: 0, errand: 0 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0 });
  assert.equal(res.seed, false);
  assert.equal(res.reason, 'cold');
});

test('высокий жребий не сеет на прохладных каналах', () => {
  const d = domain();
  d.state.seedTemp = { chronicle: 3, void: 3, errand: 3 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0.999 });
  assert.equal(res.seed, false);
  assert.equal(res.reason, 'roll');
  assert.ok(res.chance > 0 && res.chance < 1);
});

test('пустой город с горячим поручением сеет наверняка', () => {
  const d = domain();
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0.999 });
  assert.equal(res.seed, true);
  assert.equal(res.chance, 1);
});

test('насыщенная доска сбивает шанс, не обнуляя его', () => {
  const cold = { chronicle: 5, void: 5, errand: 5 };
  const empty = domain();
  empty.state.seedTemp = { ...cold };
  const busy = domain({ plotlines: [stakedPlot('p1', 3)] });
  busy.state.seedTemp = { ...cold };
  const a = decideSeedAttempt(empty, { day: 0, rng: () => 0.999 });
  const b = decideSeedAttempt(busy, { day: 0, rng: () => 0.999 });
  assert.ok(b.chance < a.chance);
  assert.ok(b.chance > 0);
});

test('канал выбирается взвешенно по температуре, а не по порогу', () => {
  const d = domain();
  d.state.seedTemp = { chronicle: 10, void: 0.0001, errand: 0.0001 };
  const res = decideSeedAttempt(d, { day: 0, rng: () => 0 });
  assert.equal(res.seed, true);
  assert.equal(res.source, 'chronicle');
});

test('холодный канал всё же может выпасть', () => {
  const d = domain();
  d.state.seedTemp = { chronicle: 5, void: 5, errand: 5 };
  let i = 0;
  // Первый жребий — сеять; второй — почти в конец распределения.
  const rng = () => (i++ === 0 ? 0 : 0.99);
  const res = decideSeedAttempt(d, { day: 0, rng });
  assert.equal(res.seed, true);
  assert.equal(res.source, 'errand', 'последний канал по порядку весов');
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
