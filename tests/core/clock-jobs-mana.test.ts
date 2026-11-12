import { describe, expect, test } from 'vitest';
import { claimJob, dueJobs, failJob, MAX_JOB_ATTEMPTS, nextJobDay, pruneJobs, recoverRunningJobs, scheduleFrontJob, scheduleJob } from '../../src/core/jobs.js';
import { accrueMana, canAfford, manaShown, spendMana, turnCost } from '../../src/core/mana.js';
import { dayAt, gameDate, holdClock, msPerGameDay, newClock, releaseClock, skipDays } from '../../src/core/time.js';
import { createFront } from '../../src/core/world/fronts.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();
const DAY = msPerGameDay(r);

describe('время', () => {
  test('сутки реального времени — игровой год', () => {
    expect(DAY).toBe(4 * 60 * 1000);
    const clock = newClock(0);
    expect(dayAt(clock, 24 * 3600 * 1000, r)).toBe(360);
  });

  test('остановка часов вычитается', () => {
    let clock = holdClock(newClock(0), 10 * DAY);
    expect(dayAt(clock, 50 * DAY, r)).toBe(10);
    clock = releaseClock(clock, 50 * DAY);
    expect(dayAt(clock, 55 * DAY, r)).toBe(15);
  });

  test('промотка двигает день вперёд', () => {
    const clock = skipDays(newClock(0), 30, r);
    expect(dayAt(clock, 0, r)).toBe(30);
  });

  test('дата читается по-человечески', () => {
    expect(gameDate(0).label).toBe('Год 1, месяц 1, день 1');
    expect(gameDate(361).label).toBe('Год 2, месяц 1, день 2');
  });
});

describe('очередь заданий', () => {
  test('просроченные — по дню, при равном — по порядку постановки', () => {
    const city = blankCity();
    scheduleJob(city, { id: 'b', kind: 'seed', dueDay: 5 });
    scheduleJob(city, { id: 'a', kind: 'seed', dueDay: 3 });
    scheduleJob(city, { id: 'c', kind: 'seed', dueDay: 5 });
    scheduleJob(city, { id: 'late', kind: 'seed', dueDay: 9 });
    expect(dueJobs(city, 5).map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(nextJobDay(city)).toBe(3);
  });

  test('после трёх попыток задание гаснет', () => {
    const city = blankCity();
    const job = scheduleJob(city, { id: 'x', kind: 'seed', dueDay: 0 });
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
      expect(claimJob(job)).toBe(true);
      failJob(job, 'boom');
    }
    expect(job.state).toBe('failed');
    expect(claimJob(job)).toBe(false);
  });

  test('упавшее посреди работы возвращается в очередь', () => {
    const city = blankCity();
    const job = scheduleJob(city, { id: 'x', kind: 'seed', dueDay: 0 });
    claimJob(job);
    expect(recoverRunningJobs(city)).toBe(1);
    expect(job.state).toBe('pending');
  });

  test('на фронт одно ожидающее задание', () => {
    const city = blankCity();
    const front = createFront({ id: 'f', form: 'threat', origin: 'story', title: 't', description: 'd', capacity: 10, deadlineDay: 40, day: 0 });
    const next = ids(1);
    scheduleFrontJob(city, front, () => next('job'));
    scheduleFrontJob(city, front, () => next('job'));
    const pending = city.jobs.filter((j) => j.state === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'front_event', dueDay: 40 });
  });

  test('очередь не растёт вечно', () => {
    const city = blankCity();
    for (let i = 0; i < 150; i++) scheduleJob(city, { id: `j${i}`, kind: 'seed', dueDay: 0 }).state = 'done';
    pruneJobs(city);
    expect(city.jobs).toHaveLength(100);
    expect(city.jobs[0]?.id).toBe('j50');
  });
});

describe('мана', () => {
  test('за год приходит столько, сколько веры, не выше потолка', () => {
    const city = blankCity({ mana: { value: 0, day: 0 } });
    accrueMana(r, city, 180);
    expect(city.mana.value).toBeCloseTo(25);
    accrueMana(r, city, 360 * 10);
    expect(city.mana.value).toBe(r.mana.max);
  });

  test('день назад не отнимает ману', () => {
    const city = blankCity({ mana: { value: 10, day: 100 } });
    accrueMana(r, city, 50);
    expect(city.mana).toEqual({ value: 10, day: 100 });
  });

  test('реплика с поручением дороже, в минус не уходим', () => {
    expect(turnCost(r, { acted: true })).toBeGreaterThan(turnCost(r, { acted: false }));
    const city = blankCity({ mana: { value: 1.5, day: 0 } });
    expect(spendMana(city, 2)).toBe(false);
    expect(canAfford(city, 1)).toBe(true);
    expect(spendMana(city, 1)).toBe(true);
    expect(manaShown(city)).toBe(0);
  });
});
