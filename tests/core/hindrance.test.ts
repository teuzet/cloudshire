import { describe, expect, test } from 'vitest';
import type { StakeOp } from '../../src/core/city.js';
import { createFront, recomputeRate } from '../../src/core/world/fronts.js';
import { hindrancesOf, setAnswered } from '../../src/core/world/hindrance.js';
import { applyStake } from '../../src/core/world/stake.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();
const zero = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };

function town(deadlineDay: number | null) {
  const city = blankCity();
  city.fronts.push(createFront({ id: 'p', form: 'threat', origin: 'story', title: 'Беда', description: '', capacity: 12, milestones: 2, deadlineDay, risk: 'normal', day: 0 }));
  return city;
}

function hinder(effect: 'pace' | 'deadline' | 'risk' | 'outcome'): StakeOp {
  return { op: 'attach', frontId: 'p', rate: r.fronts.hindrance.unitsPerMonth, object: { type: 'threat', name: 'Великаны', description: 'Бродят у кромки.', points: zero }, effect, counters: ['Работать ночью'] };
}

describe('помеха бьёт не только по скорости', () => {
  test('срок: придвигается на долю оставшегося и возвращается, когда помеху обошли', () => {
    const city = town(110);
    applyStake(r, city, [hinder('deadline')], { day: 10, newId: ids(1), frontId: 'p' });
    const front = city.fronts[0]!;
    expect(front.deadlineDay).toBe(110 - 25);
    expect(recomputeRate(r, city, front, 10)).toBe(0);
    setAnswered(r, front, hindrancesOf(city, 'p')[0]!, true, 20);
    expect(front.deadlineDay).toBe(110);
  });

  test('риск: ступень выше, пока помеха бьёт; удаление возвращает прежнюю', () => {
    const city = town(110);
    applyStake(r, city, [hinder('risk')], { day: 10, newId: ids(1), frontId: 'p' });
    const front = city.fronts[0]!;
    expect(front.risk).toBe('hard');
    const obj = hindrancesOf(city, 'p')[0]!;
    applyStake(r, city, [{ op: 'delete', target: obj.id }], { day: 20, newId: ids(2), frontId: 'p' });
    expect(front.risk).toBe('normal');
  });

  test('у дела без срока удар по сроку становится замедлением; обойдённая помеха не тормозит', () => {
    const city = town(null);
    applyStake(r, city, [hinder('deadline')], { day: 10, newId: ids(1), frontId: 'p' });
    const front = city.fronts[0]!;
    const obj = hindrancesOf(city, 'p')[0]!;
    expect(obj.attach?.effect).toBe('pace');
    expect(recomputeRate(r, city, front, 10)).toBe(0);
    setAnswered(r, front, obj, true, 10);
    expect(obj.attach?.answered).toBe(true);
    // Без ведущего и с обойдённой помехой дело просто стоит, без минуса.
    expect(recomputeRate(r, city, front, 10)).toBe(0);
  });
});
