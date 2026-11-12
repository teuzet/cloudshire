import { describe, expect, test } from 'vitest';
import { accrueMana } from '../../src/core/mana.js';
import { faithImpulse, faithOf, settleFaith } from '../../src/core/world/faith.js';
import { blankCity, rules } from '../helpers/fixtures.js';

const r = rules();

describe('вера: пятая ось', () => {
  test('лениво тянется к среднему статов', () => {
    const city = blankCity({ faith: { value: 80, day: 0 } });
    expect(settleFaith(r, city, 30)).toBeCloseTo(77);
    expect(settleFaith(r, city, 60)).toBeCloseTo(74.3);
    expect(city.faith.day).toBe(60);
  });

  test('у среднего стоит на месте', () => {
    const city = blankCity();
    expect(settleFaith(r, city, 900)).toBe(50);
  });

  test('импульс: случай и силу даёт агент, число даёт таблица', () => {
    const city = blankCity();
    expect(faithImpulse(r, city, { case: 'harm_willed', strength: 'grave' }, 0)).toBe(-6);
    expect(faithImpulse(r, city, { case: 'harm_averted', strength: 'notable' }, 0)).toBe(2);
    expect(faithImpulse(r, city, { case: 'none', strength: 'shock' }, 0)).toBe(0);
    expect(faithOf(city)).toBe(46);
  });

  test('вера зажата в 0..100', () => {
    const city = blankCity({ faith: { value: 5, day: 0 } });
    expect(faithImpulse(r, city, { case: 'harm_willed', strength: 'shock' }, 0)).toBe(-5);
    expect(city.faith.value).toBe(0);
  });

  test('мана приходит от веры, а не от статов', () => {
    const city = blankCity({ faith: { value: 90, day: 0 }, mana: { value: 0, day: 0 } });
    expect(accrueMana(r, city, 360)).toBe(Math.min(r.mana.max, 90));
  });
});
