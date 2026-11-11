import { describe, expect, test } from 'vitest';
import { createObject, deleteObject } from '../../src/core/world/objects.js';
import {
  addToLedger,
  clipToBudget,
  faithOf,
  genesisStats,
  objectContribution,
  recomputeStats,
  statEpithet,
} from '../../src/core/world/stats.js';
import { emptyStatMap, STAT_IDS } from '../../src/core/rules.js';
import { blankCity, ids, rules, zeroLedgerCity } from '../helpers/fixtures.js';

const r = rules();
const id = ids();

describe('вклад объекта', () => {
  test('бюджет веса делится по модулю профиля, знак сохраняется', () => {
    const c = objectContribution(r, 'SIGNIFICANT', { security: 4, prosperity: -1, knowledge: 1 });
    expect(c.security).toBeCloseTo(2);
    expect(c.prosperity).toBeCloseTo(-0.5);
    expect(c.knowledge).toBeCloseTo(0.5);
    expect(c.influence).toBe(0);
  });

  test('нулевой профиль ничего не даёт', () => {
    expect(objectContribution(r, 'MAJOR', {})).toEqual(emptyStatMap());
  });
});

describe('статы из объектов', () => {
  test('масштаб умножает сумму вкладов', () => {
    const city = zeroLedgerCity();
    city.statScale = 2;
    city.objects.push(
      createObject(r, { id: id('obj'), type: 'building', name: 'Склад', description: '', statEffect: { prosperity: 7 }, day: 0 }),
    );
    recomputeStats(city);
    expect(city.stats.prosperity).toBe(14);
  });

  test('ledger двигает стат и не трогает объекты', () => {
    const city = zeroLedgerCity();
    const obj = createObject(r, { id: id('obj'), type: 'building', name: 'Склад', description: '', statEffect: { prosperity: 2 }, day: 0 });
    city.objects.push(obj);
    addToLedger(city, { prosperity: 2 });
    expect(city.stats.prosperity).toBe(4);
    expect(obj.statEffect.prosperity).toBe(2);
  });

  test('удаление объекта снимает его вклад', () => {
    const city = zeroLedgerCity();
    const obj = createObject(r, { id: id('obj'), type: 'structure', name: 'Стена', description: '', statEffect: { security: 6 }, day: 0 });
    city.objects.push(obj);
    recomputeStats(city);
    expect(city.stats.security).toBe(6);
    deleteObject(obj, 1);
    recomputeStats(city);
    expect(city.stats.security).toBe(0);
  });

  test('стат зажат в 0..100', () => {
    const city = zeroLedgerCity();
    addToLedger(city, { prosperity: 500, security: -40 });
    expect(city.stats.prosperity).toBe(100);
    expect(city.stats.security).toBe(0);
  });

  test('вера — среднее четырёх статов', () => {
    const city = blankCity({ stats: { prosperity: 40, security: 60, knowledge: 50, influence: 70 } });
    expect(faithOf(city)).toBe(55);
  });
});

describe('генезис статов', () => {
  test('сумма ровно бюджет, каждый в коридоре, подгонка в ledger', () => {
    const contributions = [
      { prosperity: 10, security: 0, knowledge: 0, influence: 0 },
      { prosperity: 0, security: 1, knowledge: 1, influence: 1 },
    ];
    const g = genesisStats(r, contributions);
    const total = STAT_IDS.reduce((a, k) => a + g.stats[k], 0);
    expect(total).toBe(r.genesis.statBudget);
    for (const k of STAT_IDS) {
      expect(g.stats[k]).toBeGreaterThanOrEqual(r.genesis.statMin);
      expect(g.stats[k]).toBeLessThanOrEqual(r.genesis.statMax);
    }
    const city = zeroLedgerCity();
    city.statScale = g.statScale;
    city.statLedger = g.ledger;
    contributions.forEach((c, i) =>
      city.objects.push(createObject(r, { id: `o${i}`, type: 'building', name: `o${i}`, description: '', statEffect: c, day: 0 })),
    );
    expect(recomputeStats(city)).toEqual(g.stats);
  });

  test('неположительный вклад — ошибка', () => {
    expect(() => genesisStats(r, [emptyStatMap()])).toThrow();
  });

  test('clipToBudget доводит до суммы и держит коридор', () => {
    const out = clipToBudget([10, 100, 55, 55], { budget: 220, min: 35, max: 75 });
    expect(out.reduce((a, b) => a + b, 0)).toBe(220);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(35);
    expect(Math.max(...out)).toBeLessThanOrEqual(75);
  });
});

test('эпитет берёт ближайшую нижнюю ступень', () => {
  expect(statEpithet(r, 0)).toBe('ужасающе');
  expect(statEpithet(r, 55)).toBe('обычно');
  expect(statEpithet(r, 100)).toBe('божественно');
});
