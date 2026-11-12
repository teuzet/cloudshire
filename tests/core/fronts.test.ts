import { describe, expect, test } from 'vitest';
import type { City, Front } from '../../src/core/city.js';
import { createAssignment, leadOf } from '../../src/core/world/assignments.js';
import {
  closeFront,
  createFront,
  daysLeft,
  dueEvent,
  isFrozen,
  neighbors,
  nextEventDay,
  occupyFootprint,
  progressAt,
  recomputeRate,
  rollbackMilestone,
  settleProgress,
  tempoSum,
} from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import type { Office } from '../../src/core/rules.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();
const id = ids();

function deed(over: Partial<Parameters<typeof createFront>[0]> = {}): Front {
  return createFront({ id: id('front'), form: 'deed', origin: 'player', title: 'Баллиста', description: 'Строят баллисту', capacity: 12, milestones: 3, risk: 'hard', day: 0, ...over });
}

function lead(city: City, front: Front, office: Office = 'marshal', over: Partial<Parameters<typeof createAssignment>[1]> = {}) {
  const officer = city.officers.find((o) => o.office === office)!;
  return createAssignment(city, { id: id('asg'), front, officer, day: 0, ...over });
}

describe('прогресс', () => {
  test('без ведущего дело стоит и событий не ждёт', () => {
    const city = blankCity();
    const front = deed();
    city.fronts.push(front);
    expect(recomputeRate(r, city, front, 0)).toBe(0);
    expect(nextEventDay(front)).toBeNull();
    expect(daysLeft(front, 0)).toBeNull();
  });

  test('ведущий двигает дело, прогресс досчитывается лениво', () => {
    const city = blankCity();
    const front = deed();
    city.fronts.push(front);
    lead(city, front);
    recomputeRate(r, city, front, 0);
    expect(front.ratePerDay * 30).toBeCloseTo(4 * 0.9);
    expect(progressAt(front, 50)).toBeCloseTo(6);
    expect(daysLeft(front, 0)).toBe(100);
  });

  test('вехи делят шкалу поровну, последняя веха — завершение', () => {
    const city = blankCity();
    const front = deed();
    city.fronts.push(front);
    lead(city, front);
    recomputeRate(r, city, front, 0);
    expect(nextEventDay(front)).toBe(34);
    expect(dueEvent(front, 33)).toBeNull();
    expect(dueEvent(front, 34)).toBe('milestone');
    front.milestonesFired = 2;
    expect(dueEvent(front, 99)).toBeNull();
    expect(dueEvent(front, 100)).toBe('completion');
  });

  test('три рычага темпа суммируются', () => {
    const city = blankCity();
    const front = deed({ tempo: 1 });
    city.fronts.push(front);
    city.officers.find((o) => o.office === 'marshal')!.temper = 'hasty';
    lead(city, front, 'marshal', { tempo: 1, verdict: 'spot_on' });
    expect(tempoSum(city, front)).toBe(3);
    recomputeRate(r, city, front, 0);
    expect(front.ratePerDay * 30).toBeCloseTo(4 * 0.9 * 1.5 * 1.6);
  });

  test('помощник прибавляет, помеха отнимает, ниже нуля скорость не падает', () => {
    const city = blankCity();
    const front = deed();
    city.fronts.push(front);
    city.objects.push(createObject(r, { id: 'help', type: 'community', name: 'Артель', description: '', temporary: true, attach: { frontId: front.id, rate: 2 }, day: 0 }));
    expect(recomputeRate(r, city, front, 0) * 30).toBeCloseTo(2);
    city.objects.push(createObject(r, { id: 'h1', type: 'threat', name: 'Завал', description: '', temporary: true, attach: { frontId: front.id, rate: -2 }, day: 0 }));
    city.objects.push(createObject(r, { id: 'h2', type: 'threat', name: 'Ропот', description: '', temporary: true, attach: { frontId: front.id, rate: -2 }, day: 0 }));
    expect(recomputeRate(r, city, front, 0)).toBe(0);
  });

  test('смена скорости сначала фиксирует набранное', () => {
    const city = blankCity();
    const front = deed();
    city.fronts.push(front);
    const a = lead(city, front);
    recomputeRate(r, city, front, 0);
    a.verdict = 'off';
    recomputeRate(r, city, front, 50);
    expect(front.progress).toBeCloseTo(6);
    expect(progressAt(front, 100)).toBeCloseTo(9);
  });

  test('откат на веху возвращает к предыдущему порогу', () => {
    const front = deed();
    front.progress = 9;
    front.milestonesFired = 2;
    rollbackMilestone(front, 0);
    expect(front.progress).toBe(4);
    expect(front.milestonesFired).toBe(1);
  });
});

describe('сроки и формы', () => {
  test('работа важнее срока: успел в последний день — успел', () => {
    const threat = createFront({ id: 't', form: 'threat', origin: 'complication', title: 'Бунт', description: '', capacity: 4, deadlineDay: 30, day: 0 });
    threat.ratePerDay = 4 / 30;
    expect(dueEvent(threat, 30)).toBe('completion');
    threat.ratePerDay = 0;
    expect(dueEvent(threat, 29)).toBeNull();
    expect(dueEvent(threat, 30)).toBe('deadline');
  });

  test('часы: только срок, ёмкости нет', () => {
    expect(() => createFront({ id: 'c', form: 'clock', origin: 'complication', title: 'x', description: '', capacity: 0, day: 0 })).toThrow(/срока/);
    const clock = createFront({ id: 'c', form: 'clock', origin: 'complication', title: 'x', description: '', capacity: 7, deadlineDay: 120, day: 0 });
    expect(clock.capacity).toBe(0);
    expect(nextEventDay(clock)).toBe(120);
    expect(dueEvent(clock, 120)).toBe('deadline');
  });

  test('месячный бросок приходит по своему дню', () => {
    const front = deed({ pulseDay: 30 });
    expect(nextEventDay(front)).toBe(30);
    expect(dueEvent(front, 30)).toBe('pulse');
  });

  test('дело без ёмкости создать нельзя', () => {
    expect(() => deed({ capacity: 0 })).toThrow(/ёмкости/);
  });
});

describe('привязанная угроза и соседи', () => {
  test('пока жива угроза откатом или срывом, дело стоит; замедление его не останавливает', () => {
    const city = blankCity();
    const front = deed();
    city.fronts.push(front);
    lead(city, front);
    const tension = createFront({ id: 'slow', form: 'tension', origin: 'complication', title: 'Ропот', description: '', capacity: 1, deadlineDay: 60, parentId: front.id, bound: 'slow', day: 0 });
    city.fronts.push(tension);
    expect(isFrozen(city, front)).toBe(false);
    const threat = createFront({ id: 'thr', form: 'threat', origin: 'complication', title: 'Бунт', description: '', capacity: 2, deadlineDay: 30, parentId: front.id, bound: 'rollback', day: 0 });
    city.fronts.push(threat);
    expect(isFrozen(city, front)).toBe(true);
    expect(recomputeRate(r, city, front, 0)).toBe(0);
    closeFront(r, city, threat, 'done', 5);
    expect(recomputeRate(r, city, front, 5)).toBeGreaterThan(0);
  });

  test('соседи — активные фронты с общим объектом', () => {
    const city = blankCity();
    const a = deed({ footprint: [{ objectId: 'guild', relation: 'occupies', reason: '' }] });
    const b = createFront({ id: 'b', form: 'threat', origin: 'echo', title: 'x', description: '', capacity: 2, deadlineDay: 30, refs: ['guild'], day: 0 });
    const c = createFront({ id: 'c', form: 'find', origin: 'story', title: 'y', description: '', capacity: 2, refs: ['tower'], day: 0 });
    city.fronts.push(a, b, c);
    expect(neighbors(city, a).map((f) => f.id)).toEqual(['b']);
  });
});

describe('занятость и закрытие', () => {
  function building() {
    const city = blankCity();
    city.objects.push(createObject(r, { id: 'guild', type: 'organization', name: 'Гильдия', description: '', statEffect: { security: 12 }, day: 0 }));
    recomputeStats(city, r);
    return city;
  }

  test('занятый объект даёт три четверти вклада, пока идёт дело', () => {
    const city = building();
    expect(city.stats.security).toBe(62);
    const front = deed({ footprint: [{ objectId: 'guild', relation: 'occupies', reason: 'мастера на стройке' }] });
    city.fronts.push(front);
    expect(occupyFootprint(city, front)).toEqual(['guild']);
    expect(recomputeStats(city, r).security).toBe(59);
    closeFront(r, city, front, 'done', 10);
    expect(city.stats.security).toBe(62);
  });

  test('закрытие освобождает ведущего, убирает временное и уносит дочерние фронты', () => {
    const city = building();
    const site = createObject(r, { id: 'site', type: 'site', name: 'Стройка', description: '', temporary: true, day: 0 });
    const hindrance = createObject(r, { id: 'h', type: 'threat', name: 'Завал', description: '', temporary: true, attach: { frontId: 'p', rate: -2 }, day: 0 });
    city.objects.push(site, hindrance);
    const front = deed({ id: 'p', siteId: 'site' });
    const child = deed({ id: 'child', origin: 'deed', parentId: 'p', milestones: 1 });
    city.fronts.push(front, child);
    lead(city, front);
    lead(city, child, 'keeper');

    const changes = closeFront(r, city, front, 'done', 20);
    expect(front).toMatchObject({ status: 'done', resolvedDay: 20, ratePerDay: 0 });
    expect(child.status).toBe('cancelled');
    expect(leadOf(city, front.id)).toBeNull();
    expect(city.officers.every((o) => o.assignmentId === null)).toBe(true);
    expect(site.status).toBe('deleted');
    expect(hindrance.status).toBe('deleted');
    expect(changes.map((c) => c.kind)).toEqual(['front_closed', 'object_removed', 'front_closed']);
  });

  test('при отмене начатое остаётся стоять как есть', () => {
    const city = blankCity();
    const site = createObject(r, { id: 'site', type: 'site', name: 'Стройка', description: '', temporary: true, day: 0 });
    city.objects.push(site);
    const front = deed({ siteId: 'site' });
    city.fronts.push(front);
    closeFront(r, city, front, 'cancelled', 20);
    expect(site).toMatchObject({ status: 'active', temporary: false });
  });

  test('закрытый фронт больше не двигается', () => {
    const city = blankCity();
    const front = deed();
    city.fronts.push(front);
    lead(city, front);
    recomputeRate(r, city, front, 0);
    closeFront(r, city, front, 'cancelled', 30);
    expect(settleProgress(front, 90)).toBeCloseTo(3.6);
    expect(dueEvent(front, 900)).toBeNull();
    expect(closeFront(r, city, front, 'done', 40)).toEqual([]);
  });
});
