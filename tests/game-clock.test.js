import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS_PER_YEAR,
  DAYS_PER_MONTH,
  realMsPerGameDay,
  gameDaysToRealMs,
  realMsToGameDays,
  startClock,
  syncWorldClock,
  tickIndexFromDay,
  currentDay,
  realTimeOfDay,
  gameDateFromDay,
  worldDateLabel,
  spanBandLabel,
  humanSpan,
  realWaitLabel,
  skipGameDays,
  parseSkipDays,
  MAX_SKIP_DAYS,
  reanchorClock,
} from '../src/game/gameClock.js';

const HOUR = 60 * 60 * 1000;

test('игровой день — четыре реальные минуты', () => {
  assert.equal(realMsPerGameDay(null), 4 * 60 * 1000);
  assert.equal(gameDaysToRealMs(DAYS_PER_YEAR, null), 24 * HOUR);
  assert.equal(gameDaysToRealMs(DAYS_PER_MONTH, null), 2 * HOUR);
});

test('коэффициент конверсии настраивается', () => {
  const cfg = { time: { realHoursPerYear: 48 } };
  assert.equal(gameDaysToRealMs(DAYS_PER_YEAR, cfg), 48 * HOUR);
  assert.equal(Math.round(realMsToGameDays(48 * HOUR, cfg)), DAYS_PER_YEAR);
});

test('часы стартуют один раз и не сбрасывают якорь', () => {
  const world = {};
  startClock(world, 1000);
  const anchor = world.epochAt;
  startClock(world, 999_000);
  assert.equal(world.epochAt, anchor);
});

test('день считается от реального времени, а не от числа вызовов', () => {
  const world = {};
  startClock(world, 0);
  assert.equal(currentDay(world, { now: 0 }), 0);
  assert.equal(currentDay(world, { now: 4 * 60 * 1000 - 1 }), 0);
  assert.equal(currentDay(world, { now: 4 * 60 * 1000 }), 1);
  assert.equal(currentDay(world, { now: 24 * HOUR }), DAYS_PER_YEAR);
});

test('пауза хода правителя откатывает часы домена', () => {
  const world = {};
  startClock(world, 0);
  const now = 40 * 60 * 1000; // 10 игровых дней
  assert.equal(currentDay(world, { now }), 10);
  assert.equal(currentDay(world, { now, pausedMs: 20 * 60 * 1000 }), 5);
});

test('realTimeOfDay обратна currentDay', () => {
  const world = {};
  startClock(world, 5_000);
  const at = realTimeOfDay(world, 30, {});
  assert.equal(currentDay(world, { now: at }), 30);
});

// ─────────────────────────── ручная промотка ───────────────────────────

test('игровой срок переводится в реальное ожидание для игрока', () => {
  assert.equal(realWaitLabel(0), 'вот-вот');
  assert.equal(realWaitLabel(1), '~4 мин');
  assert.equal(realWaitLabel(5), '~20 мин');
  assert.equal(realWaitLabel(20), '~80 мин');
  assert.equal(realWaitLabel(30), '~2 ч', 'игровой месяц — два реальных часа');
  assert.equal(realWaitLabel(360), '~1 сут', 'игровой год — реальные сутки');
  // Скорость времени настраиваемая: ярлык обязан идти за конфигом, а не за константой.
  assert.equal(realWaitLabel(360, { time: { realHoursPerYear: 48 } }), '~2 сут');
});

test('календарь мира считается из якоря, tickIndex — из дня', () => {
  const world = {};
  startClock(world, 0);
  syncWorldClock(world, { now: 2 * HOUR });
  assert.equal(world.dayIndex, DAYS_PER_MONTH);
  assert.equal(world.tickIndex, 1);
  assert.equal(world.gameDate.label, 'Год 1, месяц 2, день 1');
  assert.equal(tickIndexFromDay(0), 0);
  assert.equal(tickIndexFromDay(29), 0);
  assert.equal(tickIndexFromDay(30), 1);
});

test('без якоря часы не сбрасывают уже сохранённый месяц', () => {
  const now = 10_000;
  const world = { tickIndex: 4, gameDate: { year: 1, month: 5 } };
  startClock(world, now);
  syncWorldClock(world, { now });
  assert.equal(world.dayIndex, 120);
  assert.equal(world.tickIndex, 4);
  assert.equal(world.gameDate.year, 1);
  assert.equal(world.gameDate.month, 5);
});

test('промотка двигает якорь, а не заводит второй счётчик', () => {
  const world = {};
  startClock(world, 0);
  const now = 40 * 60 * 1000; // 10 игровых дней
  assert.equal(currentDay(world, { now }), 10);
  assert.equal(skipGameDays(world, DAYS_PER_MONTH, { now }), 40);
  assert.equal(world.dayIndex, 40);
  // Часы после промотки идут прежним ходом: ещё день реального времени — ещё день.
  assert.equal(currentDay(world, { now: now + 4 * 60 * 1000 }), 41);
});

test('промотка не трогает якорь месячного планировщика', () => {
  const world = { scheduler: { epochAt: new Date(0).toISOString() } };
  startClock(world, 0);
  skipGameDays(world, DAYS_PER_YEAR, { now: 0 });
  assert.equal(world.scheduler.epochAt, new Date(0).toISOString());
  assert.equal(world.dayIndex, DAYS_PER_YEAR);
});

test('промотка на ноль дней только сообщает текущий день', () => {
  const world = {};
  startClock(world, 0);
  const anchor = world.epochAt;
  assert.equal(skipGameDays(world, 0, { now: 8 * 60 * 1000 }), 2);
  assert.equal(world.epochAt, anchor);
});

test('промотка с паузой считает от замороженного дня', () => {
  const world = {};
  startClock(world, 0);
  const now = 40 * 60 * 1000;
  const pausedMs = 8 * 60 * 1000;
  assert.equal(currentDay(world, { now, pausedMs }), 8);
  assert.equal(skipGameDays(world, DAYS_PER_MONTH, { now, pausedMs }), 8 + DAYS_PER_MONTH);
});

test('промотка в клиенте принимает 1…год и пустое как fallback', () => {
  assert.equal(parseSkipDays(7), 7);
  assert.equal(parseSkipDays('12'), 12);
  assert.equal(parseSkipDays(1.8), 2);
  assert.equal(parseSkipDays(0), null);
  assert.equal(parseSkipDays(MAX_SKIP_DAYS + 1), null);
  assert.equal(parseSkipDays('', { fallback: DAYS_PER_MONTH }), DAYS_PER_MONTH);
  assert.equal(parseSkipDays(null, { fallback: DAYS_PER_MONTH }), DAYS_PER_MONTH);
});

test('переякорь после загрузки не даёт стене часов уехать вперёд', () => {
  const world = {};
  startClock(world, 0);
  syncWorldClock(world, { now: 40 * 60 * 1000 });
  assert.equal(world.dayIndex, 10);
  const later = 24 * HOUR;
  reanchorClock(world, { day: 10, now: later });
  assert.equal(currentDay(world, { now: later }), 10);
  assert.equal(world.dayIndex, 10);
  assert.equal(world.pausedMs, 0);
  assert.equal(world.clockHeldAt, null);
  assert.equal(currentDay(world, { now: later + 4 * 60 * 1000 }), 11);
});

test('переякорь удерживает паузу, если снимок был на паузе', () => {
  const world = {};
  const later = 24 * HOUR;
  reanchorClock(world, { day: 10, now: later, held: true });
  assert.equal(world.clockHeldAt, later);
  assert.equal(currentDay(world, { now: later }), 10);
  assert.equal(currentDay(world, { now: later + 8 * 60 * 1000, pausedMs: 8 * 60 * 1000 }), 10);
});

test('календарь: 360 дней в году, 30 в месяце', () => {
  assert.deepEqual(gameDateFromDay(0), {
    year: 1,
    month: 1,
    day: 1,
    dayIndex: 0,
    label: 'Год 1, месяц 1, день 1',
  });
  assert.partialDeepStrictEqual(gameDateFromDay(29), { year: 1, month: 1, day: 30 });
  assert.partialDeepStrictEqual(gameDateFromDay(30), { year: 1, month: 2, day: 1 });
  assert.partialDeepStrictEqual(gameDateFromDay(359), { year: 1, month: 12, day: 30 });
  assert.partialDeepStrictEqual(gameDateFromDay(360), { year: 2, month: 1, day: 1 });
});

test('worldDateLabel читает dayIndex', () => {
  assert.equal(worldDateLabel({ dayIndex: 395 }), 'Год 2, месяц 2, день 6');
  assert.equal(worldDateLabel({}), 'Год 1, месяц 1, день 1');
});

test('промежуток отдаётся полосой, а не числом', () => {
  assert.equal(spanBandLabel(2), 'считанные дни');
  assert.equal(spanBandLabel(12), 'дни');
  assert.equal(spanBandLabel(40), 'недели');
  assert.equal(spanBandLabel(120), 'сезон');
  assert.equal(spanBandLabel(300), 'год');
  assert.equal(spanBandLabel(900), 'годы');
});

test('humanSpan говорит человеческим языком', () => {
  assert.equal(humanSpan(0), 'со дня на день');
  assert.equal(humanSpan(9), 'около 9 дней');
  assert.equal(humanSpan(40), 'несколько недель');
  assert.equal(humanSpan(120), 'около 4 мес.');
  assert.equal(humanSpan(370), 'около года');
  assert.equal(humanSpan(1080), 'около 3 лет');
});
