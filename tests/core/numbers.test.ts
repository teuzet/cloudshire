import { describe, expect, test } from 'vitest';
import {
  boundCapacity,
  boundThreat,
  pressureTarget,
  sideQuenchCapacity,
  troubleDays,
  changeCapacity,
  complicationChance,
  gradePoints,
  hindranceRemovalCapacity,
  leadRatePerDay,
  magnitude,
  newObjectCapacity,
  officerFit,
  opportunityCapacity,
  pointsToGrades,
  pointsToRaw,
  pushCapacity,
  quenchCapacity,
  rawToPoints,
  scaleOf,
  severityOf,
  tempoFactor,
  threatCapacity,
} from '../../src/core/world/numbers.js';
import { blankCity, rules } from '../helpers/fixtures.js';

const r = rules();

describe('вклад: агент даёт классы, пункты считает код', () => {
  test('классы переводятся в пункты со знаком', () => {
    const points = gradePoints(r, [
      { stat: 'security', direction: 'up', size: 'large' },
      { stat: 'prosperity', direction: 'down', size: 'small' },
    ]);
    expect(points).toEqual({ prosperity: -2, security: 12, knowledge: 0, influence: 0 });
    expect(magnitude(points)).toBe(14);
  });

  test('пункты показываются агентам ближайшими классами, мелочь отбрасывается', () => {
    expect(pointsToGrades(r, { security: 11, prosperity: -2.4, knowledge: 0.5 })).toEqual([
      { stat: 'prosperity', direction: 'down', size: 'small' },
      { stat: 'security', direction: 'up', size: 'large' },
    ]);
  });

  test('сырые единицы объекта и пункты стата связаны курсом города', () => {
    const city = blankCity({ statScale: 2 });
    expect(pointsToRaw(city, { security: 12 }).security).toBe(6);
    expect(rawToPoints(city, { security: 6 }).security).toBe(12);
  });
});

describe('ёмкость и масштаб', () => {
  test('баллиста: сумма модулей вклада плюс базовая цена вида', () => {
    const capacity = newObjectCapacity(r, 'structure', { security: 12, prosperity: -2 });
    expect(capacity).toBe(22);
    expect(scaleOf(r, capacity)).toEqual({ id: 'major', milestones: 3 });
  });

  test('перемена существующего стоит разницу вклада и половину базовой цены', () => {
    expect(changeCapacity(r, 'building', { knowledge: 5 })).toBe(7);
  });

  test('границы масштаба', () => {
    expect(scaleOf(r, 6).milestones).toBe(1);
    expect(scaleOf(r, 6.5).milestones).toBe(2);
    expect(scaleOf(r, 15).milestones).toBe(2);
    expect(scaleOf(r, 35).milestones).toBe(3);
    expect(scaleOf(r, 36).milestones).toBe(4);
  });

  test('угроза, напряжение, случай, помеха и разовый вклад считаются долей с нижней границей', () => {
    expect(threatCapacity(r, 14)).toBe(14);
    expect(threatCapacity(r, 1)).toBe(2);
    expect(boundCapacity(r, 14)).toBe(5.6);
    expect(sideQuenchCapacity(r, 14)).toBe(7);
    // Срок: не короче заданного, и сановник обычной скорости успевает с запасом в полтора раза.
    expect(troubleDays(r, 2, 1)).toBe(30);
    expect(troubleDays(r, 12, 1)).toBe(135);
    expect(pressureTarget(r)).toBe(10.5);
    expect(quenchCapacity(r, 14)).toBe(2.8);
    expect(quenchCapacity(r, 2)).toBe(1);
    expect(opportunityCapacity(r, 10)).toBe(5);
    expect(hindranceRemovalCapacity(r, 22)).toBe(3.3);
    expect(pushCapacity(r, 22)).toBe(3.3);
    expect(pushCapacity(r, 8)).toBe(2);
  });
});

describe('темп и скорость', () => {
  test('три рычага суммируются: по шагу на каждый', () => {
    expect(tempoFactor(r, 3)).toBe(1.6);
    expect(tempoFactor(r, 0)).toBe(1);
    expect(tempoFactor(r, -3)).toBe(0.4);
  });

  test('поправка сановника: его стат и надбавка за свой профиль', () => {
    const city = blankCity();
    const marshal = city.officers.find((o) => o.office === 'marshal')!;
    expect(officerFit(r, city, marshal, 'knowledge')).toBe(0.9);
    expect(officerFit(r, city, marshal, marshal.statId)).toBe(1.05);
  });

  test('выработка ведущего: четыре единицы в месяц, вердикт и темп множат', () => {
    expect(leadRatePerDay(r, { verdict: 'fits', tempoSum: 0, fit: 1 }) * 30).toBeCloseTo(4);
    expect(leadRatePerDay(r, { verdict: 'spot_on', tempoSum: 3, fit: 1 }) * 30).toBeCloseTo(4 * 1.25 * 1.6);
    expect(leadRatePerDay(r, { verdict: 'off', tempoSum: -1, fit: 1 }) * 30).toBeCloseTo(4 * 0.5 * 0.8);
  });
});

describe('лестница риска', () => {
  test('темп меняет частоту бед', () => {
    expect(complicationChance(r, 'normal', 0)).toBe(0.15);
    expect(complicationChance(r, 'normal', 3)).toBe(0.24);
    expect(complicationChance(r, 'hard', -1)).toBe(0.28);
  });

  test('«безопасно» при спешке бросает как «обычно», без спешки не бросает', () => {
    expect(complicationChance(r, 'safe', 0)).toBe(0);
    expect(complicationChance(r, 'safe', -1)).toBe(0);
    expect(complicationChance(r, 'safe', 1)).toBe(0.18);
  });

  test('«невозможно» не снижается осторожностью', () => {
    expect(complicationChance(r, 'impossible', -3)).toBe(1);
  });

  test('тяжесть и угроза делу растут со ступенью', () => {
    expect(severityOf(r, 'normal', 0)).toBe('light');
    expect(severityOf(r, 'hard', 0.4)).toBe('heavy');
    expect(severityOf(r, 'hard', 0.6)).toBe('light');
    expect(severityOf(r, 'risky', 0.99)).toBe('heavy');
    expect(boundThreat('normal')).toBe('slow');
    expect(boundThreat('hard')).toBe('rollback');
    expect(boundThreat('risky')).toBe('cancel');
    expect(boundThreat('impossible')).toBe('cancel');
  });
});
