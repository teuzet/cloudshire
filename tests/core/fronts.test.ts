import { describe, expect, test } from 'vitest';
import { createAssignment } from '../../src/core/world/assignments.js';
import {
  createFront,
  crossedBeat,
  nextFrontEvent,
  progressAt,
  recomputeRate,
  settleProgress,
} from '../../src/core/world/fronts.js';
import { beatThresholds, driftPerDay, officerRate } from '../../src/core/world/scales.js';
import { scheduleFrontJob } from '../../src/core/jobs.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();
const id = ids();

function front(beatCount = 2) {
  return createFront(r, {
    id: id('front'),
    description: 'Поиск рецепта',
    stake: { reveal: { text: 'Рецепт найден.' } },
    effort: 6,
    driftBand: 'NONE',
    beatCount,
    day: 0,
  });
}

function marshalOn(cityFront: ReturnType<typeof front>) {
  const city = blankCity();
  city.fronts.push(cityFront);
  const a = createAssignment({
    id: id('asg'),
    frontId: cityFront.id,
    office: 'marshal',
    text: 'Обыскать башню',
    verdict: { direction: 'forward', efficiency: 'normal', blocks: [], stopWhen: 'stake' },
    day: 0,
  });
  city.assignments.push(a);
  return city;
}

describe('прогресс фронта', () => {
  test('растёт линейно и не выше effort', () => {
    const f = front();
    f.ratePerDay = 1;
    expect(progressAt(f, 2)).toBe(2);
    expect(progressAt(f, 40)).toBe(6);
  });

  test('повторный пересчёт в тот же день не удваивает прогресс', () => {
    const f = front();
    f.ratePerDay = 1;
    settleProgress(f, 3);
    settleProgress(f, 3);
    expect(f.progress).toBe(3);
  });

  test('откат не уводит прогресс ниже нуля', () => {
    const f = front();
    f.ratePerDay = -1;
    expect(progressAt(f, 10)).toBe(0);
  });
});

describe('скорость', () => {
  test('без дрейфа равна скорости поручения', () => {
    const f = front();
    const city = marshalOn(f);
    expect(recomputeRate(r, city, f, 0)).toBe(officerRate(r, { stat: 50, efficiency: 'normal', direction: 'forward' }));
  });

  test('сановник со статом 50 и normal проходит effort 6 за 60 дней', () => {
    expect(6 / officerRate(r, { stat: 50, efficiency: 'normal', direction: 'forward' })).toBeCloseTo(60);
  });

  test('backward отрицателен, none даёт ноль', () => {
    expect(officerRate(r, { stat: 50, efficiency: 'normal', direction: 'backward' })).toBeLessThan(0);
    expect(officerRate(r, { stat: 50, efficiency: 'strong', direction: 'none' })).toBe(0);
  });

  test('дрейф SLOW — полэффорта в месяц', () => {
    expect(driftPerDay(r, 'SLOW') * 30).toBeCloseTo(0.5);
  });
});

describe('события фронта', () => {
  test('пороги расставлены равномерно', () => {
    expect(beatThresholds(6, 2)).toEqual([2, 4]);
    expect(beatThresholds(6, 0)).toEqual([]);
  });

  test('первый порог наступает на двадцатый день', () => {
    const f = front();
    recomputeRate(r, marshalOn(f), f, 0);
    expect(nextFrontEvent(f)).toEqual({ kind: 'front_beat', day: 20 });
  });

  test('без порогов следующее событие — ставка', () => {
    const f = front(0);
    recomputeRate(r, marshalOn(f), f, 0);
    expect(nextFrontEvent(f)).toEqual({ kind: 'front_stake', day: 60 });
  });

  test('стоящий и откатывающийся фронт событий не назначает', () => {
    const f = front();
    f.ratePerDay = 0;
    expect(nextFrontEvent(f)).toBeNull();
    f.ratePerDay = -0.2;
    expect(nextFrontEvent(f)).toBeNull();
  });

  test('сработавший порог не включается снова после отката', () => {
    const f = front();
    f.beatsFired = [0];
    f.ratePerDay = officerRate(r, { stat: 50, efficiency: 'normal', direction: 'forward' });
    expect(nextFrontEvent(f)).toEqual({ kind: 'front_beat', day: 40 });
  });

  test('пройденный порог находится, пока не помечен', () => {
    const f = front();
    f.progress = 2.5;
    expect(crossedBeat(f)).toBe(0);
    f.beatsFired.push(0);
    expect(crossedBeat(f)).toBeNull();
  });

  test('на фронт держится одно ожидающее задание', () => {
    const f = front();
    const city = marshalOn(f);
    recomputeRate(r, city, f, 0);
    scheduleFrontJob(city, f, () => id('job'));
    scheduleFrontJob(city, f, () => id('job'));
    expect(city.jobs.filter((j) => j.state === 'pending')).toHaveLength(1);
  });
});
