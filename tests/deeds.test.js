import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeed,
  startDeed,
  applyPace,
  deedRemainingDays,
  deedElapsedDays,
  deedDue,
  pauseDeedClock,
  resumeDeedClock,
  deedStat,
  deedMarginFor,
  rollDeedFinish,
  finishDeed,
  deedOutcome,
} from '../src/game/deeds.js';
import { DURATION_SPEC, MIN_OFFICER_DAYS } from '../src/game/bands.js';
import { DAYS_PER_MONTH } from '../src/game/gameClock.js';

const config = { stats: [{ id: 'prosperity' }, { id: 'security' }] };

function deed(extra = {}) {
  return {
    id: 'proc1',
    summary: 'починить стену',
    status: 'active',
    linkedStats: ['prosperity'],
    durationBand: 'WEEKS',
    difficulty: 'PLAIN',
    ...extra,
  };
}

// ───────────────────────────── нормализация ─────────────────────────────

test('дело без дней получает их из старых месяцев', () => {
  const p = normalizeDeed(deed({ durationBand: null, objectiveMonths: 3 }));
  assert.equal(p.objectiveDays, 3 * DAYS_PER_MONTH);
  assert.equal(p.durationBand, 'WEEKS', 'полоса по умолчанию, пока её не назвал оценщик');
});

test('месячные поля остаются производными от дней', () => {
  const p = normalizeDeed(deed({ objectiveDays: 100, scheduledDays: 100 }));
  assert.equal(p.objectiveMonths, 3);
  assert.equal(p.expectedMonths, 3);
  assert.equal(p.durationMonths, 3);
});

test('нормализация идемпотентна', () => {
  const p = normalizeDeed(deed({ objectiveDays: 45 }));
  const first = JSON.stringify(p);
  assert.equal(JSON.stringify(normalizeDeed(p)), first);
});

test('мусорная полоса и мусорный темп не ломают дело', () => {
  const p = normalizeDeed(deed({ durationBand: 'вечность', difficulty: 'ужас', paceShift: -7 }));
  assert.equal(p.durationBand, 'WEEKS');
  assert.equal(p.difficulty, 'PLAIN');
  assert.equal(p.paceShift, -1, 'сдвиг темпа не больше одной ступени');
});

// ───────────────────────────── постановка ─────────────────────────────

test('дело кончается через свой срок от дня начала, а не в конце месяца', () => {
  const p = startDeed(deed(), {
    day: 137,
    judged: { durationBand: 'SEASON', difficulty: 'HARD', objectiveDays: 90 },
  });
  assert.equal(p.startDay, 137);
  assert.equal(p.dueDay, 227);
  assert.equal(p.scheduledDays, 90);
  assert.equal(p.difficulty, 'HARD');
});

test('мгновенное дело занимает столп минимальный срок', () => {
  const p = startDeed(deed(), {
    day: 0,
    judged: { durationBand: 'INSTANT', difficulty: 'TRIVIAL', objectiveDays: 2 },
  });
  assert.equal(p.scheduledDays, 2);
  assert.equal(p.officerDays, MIN_OFFICER_DAYS, 'столп занят дольше, чем идёт дело');
});

test('остаток и прошедшее считаются от дня', () => {
  const p = startDeed(deed(), { day: 10, judged: { objectiveDays: 40 } });
  assert.equal(deedElapsedDays(p, 25), 15);
  assert.equal(deedRemainingDays(p, 25), 25);
  assert.equal(deedDue(p, 25), false);
  assert.equal(deedDue(p, 50), true);
  assert.equal(deedRemainingDays(p, 999), 0, 'остаток не уходит в минус');
});

// ───────────────────────────── темп ─────────────────────────────

test('спешка сдвигает полосу на ступень и сокращает срок', () => {
  const p = startDeed(deed(), { day: 0, judged: { durationBand: 'SEASON', objectiveDays: 100 } });
  const res = applyPace(p, -1, { day: 10, rng: () => 0.5 });
  assert.equal(res.ok, true);
  assert.equal(p.pacedBand, 'WEEKS');
  assert.ok(p.scheduledDays < 100, 'спешка укорачивает срок');
  assert.equal(p.objectiveDays, 100, 'честная оценка не меняется');
});

test('вторая просьба поторопиться получает отказ, а не второе сжатие', () => {
  const p = startDeed(deed(), { day: 0, judged: { durationBand: 'SEASON', objectiveDays: 100 } });
  applyPace(p, -1, { day: 5, rng: () => 0.5 });
  const before = p.scheduledDays;
  const again = applyPace(p, -1, { day: 6, rng: () => 0.5 });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'same_pace');
  assert.equal(p.scheduledDays, before);
});

test('смена темпа не может отправить срок в прошлое', () => {
  const p = startDeed(deed(), { day: 0, judged: { durationBand: 'YEAR', objectiveDays: 300 } });
  applyPace(p, -1, { day: 290, rng: () => 0 });
  assert.ok(p.dueDay > 290, 'уже проделанная работа не исчезает');
});

test('обстоятельность удлиняет срок, но вклад в глубину считается по исходной полосе', () => {
  const p = startDeed(deed(), { day: 0, judged: { durationBand: 'WEEKS', objectiveDays: 30 } });
  applyPace(p, 1, { day: 0, rng: () => 0.5 });
  assert.equal(p.pacedBand, 'SEASON');
  assert.equal(p.durationBand, 'WEEKS', 'исходная полоса — та, по которой считается работа');
  assert.ok(p.scheduledDays > 30);
});

// ───────────────────────────── пауза ─────────────────────────────

test('пауза сохраняет остаток, а снятие сдвигает срок на время простоя', () => {
  const p = startDeed(deed(), { day: 0, judged: { objectiveDays: 40 } });
  pauseDeedClock(p, 10);
  assert.equal(p.pausedRemainingDays, 30);
  assert.equal(p.dueDay, null);
  resumeDeedClock(p, 100);
  assert.equal(p.dueDay, 130, 'простой не съел работу');
  assert.equal(p.pausedRemainingDays, undefined);
});

// ───────────────────────────── бросок ─────────────────────────────

test('стат берётся из связанного стата города', () => {
  const domain = { stats: { prosperity: 72, security: 20 } };
  assert.equal(deedStat(domain, deed(), config), 72);
});

test('без связанного стата берётся средний', () => {
  const domain = { stats: { prosperity: 60, security: 40 } };
  assert.equal(deedStat(domain, deed({ linkedStats: [] }), config), 50);
});

test('маржа падает от сложности и растёт от благословения', () => {
  const domain = { stats: { prosperity: 50 } };
  assert.equal(deedMarginFor(domain, normalizeDeed(deed({ difficulty: 'PLAIN' })), config), 30);
  assert.equal(deedMarginFor(domain, normalizeDeed(deed({ difficulty: 'SEVERE' })), config), -20);
  assert.equal(
    deedMarginFor(domain, normalizeDeed(deed({ difficulty: 'SEVERE', blessed: true })), config),
    -5,
  );
});

test('чужой портфель бьёт по марже', () => {
  const domain = { stats: { prosperity: 60 } };
  const plain = deedMarginFor(domain, normalizeDeed(deed()), config);
  const off = deedMarginFor(domain, normalizeDeed(deed({ offPortfolio: true })), config);
  assert.equal(plain - off, 40);
});

test('невозможное дело проваливается без броска', () => {
  const domain = { stats: { prosperity: 100 } };
  const p = normalizeDeed(deed({ difficulty: 'IMPOSSIBLE', blessed: true }));
  let rolls = 0;
  const res = rollDeedFinish(domain, p, {
    config,
    rng: () => {
      rolls += 1;
      return 0;
    },
  });
  assert.equal(res.finish, 'fail');
  assert.equal(res.impossible, true);
  assert.equal(rolls, 0, 'жребий не кидается вовсе');
});

test('сложное дело слабому городу проваливается там, где простое проходит', () => {
  const domain = { stats: { prosperity: 40 } };
  const rng = () => 0.4;
  const easy = rollDeedFinish(domain, normalizeDeed(deed({ difficulty: 'TRIVIAL' })), { config, rng });
  const hard = rollDeedFinish(domain, normalizeDeed(deed({ difficulty: 'EXTREME' })), { config, rng });
  assert.equal(easy.finish, 'ok');
  assert.equal(hard.finish, 'fail');
  assert.ok(hard.margin < easy.margin);
});

test('благословение сдвигает исход на ступень вверх', () => {
  const domain = { stats: { prosperity: 40 } };
  const rng = () => 0.01;
  const plain = rollDeedFinish(domain, normalizeDeed(deed({ difficulty: 'SEVERE' })), { config, rng });
  const blessed = rollDeedFinish(
    domain,
    normalizeDeed(deed({ difficulty: 'SEVERE', blessed: true })),
    { config, rng },
  );
  assert.equal(plain.finish, 'fail');
  assert.equal(blessed.finish, 'ok');
  assert.equal(blessed.rolled, 'fail', 'сдвиг виден: бросок был провальным');
});

test('спешка режет шанс успеха через paceRatio', () => {
  const domain = { stats: { prosperity: 45 } };
  const even = normalizeDeed(deed({ objectiveDays: 100, scheduledDays: 100 }));
  const rushed = normalizeDeed(deed({ objectiveDays: 100, scheduledDays: 40 }));
  const a = rollDeedFinish(domain, even, { config, rng: () => 0 });
  const b = rollDeedFinish(domain, rushed, { config, rng: () => 0 });
  assert.ok(b.weights.fail > a.weights.fail, 'спешка добавляет провала');
  assert.equal(b.paceRatio, 0.4);
});

// ───────────────────────────── финиш ─────────────────────────────

test('финиш закрывает дело и помечает день', () => {
  const p = startDeed(deed(), { day: 5, judged: { objectiveDays: 20 } });
  finishDeed(p, { day: 25, finish: 'crit' });
  assert.equal(p.status, 'resolved');
  assert.equal(p.finishKind, 'crit');
  assert.equal(p.resolvedDay, 25);
  assert.equal(p.monthsLeft, 0);
});

test('провал ставит статус failed', () => {
  const p = startDeed(deed(), { day: 0, judged: { objectiveDays: 20 } });
  finishDeed(p, { day: 20, finish: 'fail' });
  assert.equal(p.status, 'failed');
});

test('итог дела несёт полосы и выравнивание, а не месяцы', () => {
  const p = startDeed(deed({ plotEngagement: 'DIRECT' }), {
    day: 0,
    judged: { durationBand: 'SEASON', difficulty: 'HARD', objectiveDays: 90 },
  });
  const out = deedOutcome(p, { finish: 'ok', day: 90 });
  assert.equal(out.durationBand, 'SEASON');
  assert.equal(out.difficulty, 'HARD');
  assert.equal(out.alignment, 'DIRECT');
  assert.equal(out.finished, true);
  assert.equal(out.day, 90);
});

test('срок внутри полосы не выходит за её границы', () => {
  for (const band of ['INSTANT', 'DAYS', 'WEEKS', 'SEASON', 'YEAR', 'YEARS']) {
    for (const r of [0, 0.5, 0.999]) {
      const p = startDeed(deed({ durationBand: band, objectiveDays: null }), {
        day: 0,
        judged: { durationBand: band },
        rng: () => r,
      });
      assert.ok(
        p.objectiveDays >= DURATION_SPEC[band].min && p.objectiveDays <= DURATION_SPEC[band].max,
        `${band} при r=${r} дал ${p.objectiveDays}`,
      );
    }
  }
});
