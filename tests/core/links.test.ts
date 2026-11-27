import { describe, expect, test } from 'vitest';
import type { City, Front, StakeOp } from '../../src/core/city.js';
import { createAssignment } from '../../src/core/world/assignments.js';
import { changedFrontIds, describeChanges } from '../../src/core/world/changes.js';
import { tensionToThreat } from '../../src/core/world/complications.js';
import { refreshTargets } from '../../src/core/world/echo.js';
import { closeFront, createFront, dueEvent, frontObjectIds, neighbors, nextEventDay, recomputeRate } from '../../src/core/world/fronts.js';
import { holdersOf, isAsleep } from '../../src/core/world/hold.js';
import { createObject } from '../../src/core/world/objects.js';
import { applyStake } from '../../src/core/world/stake.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();
const zero = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };

function ctx(day: number, seed = 3) {
  return { day, newId: ids(seed) };
}

function front(city: City, id: string): Front {
  return city.fronts.find((f) => f.id === id)!;
}

/** Островок с башней прибился к городу и скоро отчалит; в башню идёт экспедиция. */
function islet() {
  const city = blankCity();
  city.objects.push(
    createObject(r, { id: 'islet', type: 'site', name: 'Прибившийся островок', description: 'Обломок чужой земли у кромки.', day: 0 }),
    createObject(r, { id: 'tower', type: 'building', name: 'Башня на островке', description: 'Старая башня с ловушками.', parentId: 'islet', day: 0 }),
    createObject(r, { id: 'pier', type: 'structure', name: 'Причал', description: 'Городской причал.', statEffect: { prosperity: 4 }, day: 0 }),
  );
  city.fronts.push(
    createFront({ id: 'drift', form: 'clock', origin: 'story', title: 'Островок отчалит', description: 'Островок уносит ветром.', capacity: 0, deadlineDay: 100, livesOn: 'islet', stake: [{ op: 'retire', target: 'islet', forever: true }], refs: ['islet'], day: 0 }),
    createFront({ id: 'trip', form: 'find', origin: 'story', title: 'Экспедиция в башню', description: 'Найти рецепт в башне.', capacity: 12, milestones: 3, livesOn: 'tower', refs: ['tower'], day: 0 }),
  );
  recomputeStats(city, r);
  return city;
}

function chains(effect: 'stop' | 'slow' | 'hurry' = 'stop'): StakeOp {
  return { op: 'create', object: { type: 'object', name: 'Цепи', description: 'Цепи держат островок у причала.', points: zero, refs: ['islet', 'pier'], holds: [{ frontId: 'drift', effect }] }, result: true };
}

describe('держит: якорь и срок беды', () => {
  test('якорь останавливает срок: фронт спит, событий у него нет; якорь пал — срок идёт с того места, где встал', () => {
    const city = islet();
    const made = applyStake(r, city, [chains()], ctx(40));
    const drift = front(city, 'drift');
    expect(made.changes.map((c) => c.kind)).toEqual(['object_created', 'front_held']);
    expect(drift.deadlineDay).toBeNull();
    expect(drift.sleepLeft).toBe(60);
    expect(isAsleep(drift)).toBe(true);
    expect(nextEventDay(drift)).toBeNull();
    expect(dueEvent(drift, 500)).toBeNull();

    const out = applyStake(r, city, [{ op: 'delete', target: made.resultId! }], ctx(300, 4));
    expect(out.changes.map((c) => c.kind)).toEqual(['object_removed', 'front_freed']);
    expect(drift.deadlineDay).toBe(360);
    expect(isAsleep(drift)).toBe(false);
    expect(drift.status).toBe('active');
  });

  test('якорь замедляет: оставшееся идёт вдвое дольше, прошедшее под якорем засчитано наполовину', () => {
    const city = islet();
    const made = applyStake(r, city, [chains('slow')], ctx(40));
    const drift = front(city, 'drift');
    expect(drift.deadlineDay).toBe(40 + 60 / r.fronts.hold.slowFactor);
    applyStake(r, city, [{ op: 'delete', target: made.resultId! }], ctx(100, 4));
    // За 60 дней под якорем ушло 30 дней обычного хода из 60.
    expect(drift.deadlineDay).toBe(130);
  });

  test('якорь торопит: срок ближе', () => {
    const city = islet();
    applyStake(r, city, [chains('hurry')], ctx(40));
    expect(front(city, 'drift').deadlineDay).toBe(40 + 60 / r.fronts.hold.hurryFactor);
  });

  test('два якоря: стоит, пока цел тот, что останавливает; потом идёт медленно', () => {
    const city = islet();
    applyStake(r, city, [chains('slow')], ctx(40));
    const stop = applyStake(r, city, [chains('stop')], ctx(40, 4));
    const drift = front(city, 'drift');
    expect(drift.sleepLeft).toBe(60);
    applyStake(r, city, [{ op: 'delete', target: stop.resultId! }], ctx(200, 5));
    expect(drift.deadlineDay).toBe(200 + 120);
  });

  test('выбывший объект не держит: беда вывела якорь из строя, срок пошёл', () => {
    const city = islet();
    const made = applyStake(r, city, [chains()], ctx(40));
    const out = applyStake(r, city, [{ op: 'delete', target: made.resultId! }], { ...ctx(90, 4), trouble: 'Буря' });
    const obj = city.objects.find((o) => o.id === made.resultId)!;
    expect(obj.status).toBe('active');
    expect(obj.out?.cause).toBe('Буря');
    expect(out.changes.map((c) => c.kind)).toEqual(['object_out', 'front_freed']);
    expect(front(city, 'drift').deadlineDay).toBe(150);
    expect(holdersOf(city, 'drift')).toEqual([]);
  });

  test('существующий объект становится якорем операцией hold; повтор ничего не меняет', () => {
    const city = islet();
    const op: StakeOp = { op: 'hold', target: 'pier', frontId: 'drift', effect: 'stop', word: true };
    expect(applyStake(r, city, [op], ctx(10)).changes).toMatchObject([{ kind: 'front_held', objectId: 'pier', effect: 'stop', motion: 'clock' }]);
    expect(applyStake(r, city, [op], ctx(20)).changes).toEqual([]);
    expect(city.objects.find((o) => o.id === 'pier')!.holds).toMatchObject([{ frontId: 'drift', effect: 'stop', word: true, day: 10 }]);
    expect(front(city, 'drift').sleepLeft).toBe(90);
  });

  test('фронт закрыт: якорю больше нечего держать', () => {
    const city = islet();
    const made = applyStake(r, city, [chains()], ctx(40));
    closeFront(r, city, front(city, 'drift'), 'cancelled', 50);
    expect(city.objects.find((o) => o.id === made.resultId)!.holds).toEqual([]);
  });

  test('напряжение под якорем прорывается в угрозу со сроком по своему ходу', () => {
    const city = islet();
    city.fronts.push(createFront({ id: 'murmur', form: 'tension', origin: 'echo', title: 'Ропот', description: '', capacity: 6, deadlineDay: 60, atStake: 10, day: 0 }));
    const plain = structuredClone(front(city, 'murmur'));
    tensionToThreat(r, plain, 60);
    applyStake(r, city, [{ op: 'hold', target: 'pier', frontId: 'murmur', effect: 'slow' }], ctx(0));
    const murmur = front(city, 'murmur');
    expect(murmur.deadlineDay).toBe(120);
    tensionToThreat(r, murmur, 120);
    expect(murmur.deadlineDay! - 120).toBe((plain.deadlineDay! - 60) / r.fronts.hold.slowFactor);
  });
});

describe('держит: якорь и дело', () => {
  function work() {
    const city = islet();
    const trip = front(city, 'trip');
    createAssignment(city, { id: 'a', front: trip, officer: city.officers[2]!, day: 0 });
    const base = recomputeRate(r, city, trip, 0);
    return { city, trip, base };
  }

  test('торопит и замедляет работу на свои единицы в месяц; останавливает совсем', () => {
    const { city, trip, base } = work();
    expect(base).toBeGreaterThan(0);
    applyStake(r, city, [{ op: 'hold', target: 'pier', frontId: 'trip', effect: 'hurry' }], ctx(0));
    expect(trip.ratePerDay).toBeCloseTo(base + r.fronts.hold.unitsPerMonth / 30);
    applyStake(r, city, [{ op: 'hold', target: 'islet', frontId: 'trip', effect: 'slow' }], ctx(0));
    expect(trip.ratePerDay).toBeCloseTo(base);
    applyStake(r, city, [{ op: 'hold', target: 'tower', frontId: 'trip', effect: 'stop' }], ctx(0));
    expect(trip.ratePerDay).toBe(0);
    // У дела якорь держит работу, срока он не трогает.
    expect(trip.deadlineDay).toBeNull();
    expect(trip.sleepLeft ?? null).toBeNull();
  });

  test('риск: якорь сдвигает ступень, пока цел', () => {
    const { city, trip } = work();
    trip.risk = 'normal';
    const made = applyStake(r, city, [{ op: 'create', object: { type: 'community', name: 'Проводники', description: 'Знают ловушки.', points: zero, holds: [{ frontId: 'trip', effect: 'safer' }] }, result: true }], ctx(5));
    expect(trip.risk).toBe('safe');
    applyStake(r, city, [{ op: 'hold', target: 'islet', frontId: 'trip', effect: 'riskier' }], ctx(6));
    expect(trip.risk).toBe('normal');
    applyStake(r, city, [{ op: 'delete', target: made.resultId! }], ctx(7, 4));
    expect(trip.risk).toBe('hard');
  });

  test('риск у беды якорь не трогает; на краю лестницы якорь не встаёт', () => {
    const { city, trip } = work();
    expect(applyStake(r, city, [{ op: 'hold', target: 'pier', frontId: 'drift', effect: 'riskier' }], ctx(1)).changes).toEqual([]);
    trip.risk = 'risky';
    expect(applyStake(r, city, [{ op: 'hold', target: 'pier', frontId: 'trip', effect: 'riskier' }], ctx(1)).changes).toEqual([]);
    trip.risk = 'safe';
    expect(applyStake(r, city, [{ op: 'hold', target: 'pier', frontId: 'trip', effect: 'safer' }], ctx(1)).changes).toEqual([]);
  });

  test('исход: пока якорь цел, у фронта другая ставка; второй такой якорь не встаёт', () => {
    const city = islet();
    const drift = front(city, 'drift');
    const original = drift.stake;
    const softer: StakeOp[] = [{ op: 'fact', text: 'Островок отнесло к дальней отмели.' }];
    applyStake(r, city, [{ op: 'hold', target: 'pier', frontId: 'drift', effect: 'outcome', stake: softer }], ctx(10));
    expect(drift.stake).toBe(softer);
    expect(applyStake(r, city, [{ op: 'hold', target: 'tower', frontId: 'drift', effect: 'outcome', stake: [] }], ctx(11)).changes).toEqual([]);
    expect(applyStake(r, city, [{ op: 'hold', target: 'tower', frontId: 'drift', effect: 'outcome' }], ctx(11)).changes).toEqual([]);
    applyStake(r, city, [{ op: 'delete', target: 'pier' }], ctx(20));
    expect(drift.stake).toBe(original);
  });
});

describe('живёт на: носитель исчез, фронт кончился без ставки', () => {
  test('беда уходит вместе с носителем, дело упущено; ведущий свободен, ставки не исполнены', () => {
    const city = islet();
    city.fronts.push(createFront({ id: 'rebels', form: 'threat', origin: 'story', title: 'Бунтовщики в башне', description: 'Бунтовщики засели в башне.', capacity: 9, deadlineDay: 200, livesOn: 'tower', failStake: [{ op: 'delete', target: 'pier' }], day: 0 }));
    const officer = city.officers[1]!;
    createAssignment(city, { id: 'a', front: front(city, 'rebels'), officer, day: 0 });
    const out = applyStake(r, city, [{ op: 'delete', target: 'tower' }], ctx(30));
    expect(front(city, 'rebels')).toMatchObject({ status: 'cancelled', resolvedDay: 30 });
    expect(front(city, 'trip').status).toBe('cancelled');
    expect(front(city, 'drift').status).toBe('active');
    expect(officer.assignmentId).toBeNull();
    expect(city.objects.find((o) => o.id === 'pier')!.status).toBe('active');
    expect(out.changes.filter((c) => c.kind === 'front_closed')).toEqual([
      { kind: 'front_closed', frontId: 'trip', title: 'Найти рецепт в башне', outcome: 'expired', cause: 'Башня на островке' },
      { kind: 'front_closed', frontId: 'rebels', title: 'Бунтовщики засели в башне', outcome: 'gone', cause: 'Башня на островке' },
    ]);
    expect(describeChanges(r, out.changes)).toContain('Ушло само: «Бунтовщики засели в башне». Не стало того, на чём это держалось: Башня на островке');
  });

  test('носитель выбыл от беды: фронт на нём тоже кончился; дочерние фронты закрыты', () => {
    const city = islet();
    city.fronts.push(
      createFront({ id: 'toll', form: 'tension', origin: 'echo', title: 'Поборы на причале', description: 'На причале растут поборы.', capacity: 6, deadlineDay: 90, livesOn: 'pier', day: 0 }),
      createFront({ id: 'bribe', form: 'deed', origin: 'deed', title: 'Подкупить сборщиков', description: '', capacity: 2, parentId: 'toll', day: 0 }),
    );
    const out = applyStake(r, city, [{ op: 'delete', target: 'pier' }], { ...ctx(30), trouble: 'Пожар' });
    expect(city.objects.find((o) => o.id === 'pier')!.out?.cause).toBe('Пожар');
    expect(front(city, 'toll').status).toBe('cancelled');
    expect(front(city, 'bribe').status).toBe('cancelled');
    expect(out.changes.map((c) => c.kind)).toEqual(['object_out', 'front_closed', 'front_closed']);
  });

  test('ушло навсегда: объект уходит со всем вложенным, в памяти остаётся как утраченное', () => {
    const city = islet();
    const out = applyStake(r, city, [{ op: 'retire', target: 'islet', forever: true }], { ...ctx(30), trouble: 'Островок отчалил' });
    const gone = city.objects.filter((o) => o.id === 'islet' || o.id === 'tower');
    expect(gone.map((o) => [o.status, o.out?.forever, o.out?.cause])).toEqual([
      ['deleted', true, 'Островок отчалил'],
      ['deleted', true, 'Островок отчалил'],
    ]);
    expect(out.changes.map((c) => c.kind)).toEqual(['object_removed', 'object_removed', 'front_closed', 'front_closed']);
    expect(front(city, 'trip').status).toBe('cancelled');
    expect(front(city, 'drift').status).toBe('cancelled');
  });

  test('носитель среди объектов фронта', () => {
    expect(frontObjectIds(createFront({ id: 'x', form: 'find', origin: 'story', title: 'x', description: '', capacity: 2, livesOn: 'tower', day: 0 }))).toEqual(['tower']);
  });
});

describe('история с цепями целиком', () => {
  test('цепи держат островок; в башне селятся бунтовщики; цепи сбиты — островок уносит всё с собой', () => {
    const city = islet();
    const made = applyStake(r, city, [chains()], ctx(40));
    const drift = front(city, 'drift');
    // Гонки со временем больше нет: экспедиция идёт без срока, часы спят.
    expect(nextEventDay(drift)).toBeNull();

    city.fronts.push(createFront({ id: 'rebels', form: 'threat', origin: 'story', title: 'Бунтовщики в башне', description: 'Бунтовщики засели в башне.', capacity: 9, deadlineDay: 700, livesOn: 'tower', failStake: [{ op: 'delete', target: 'pier' }], day: 500 }));

    applyStake(r, city, [{ op: 'delete', target: made.resultId! }], ctx(520, 4));
    expect(drift.deadlineDay).toBe(580);
    expect(dueEvent(drift, 580)).toBe('deadline');

    // Срок вышел: поток закрывает часы и исполняет их ставку.
    const changes = closeFront(r, city, drift, 'done', 580, { outcome: 'failed' });
    changes.push(...applyStake(r, city, drift.stake, { ...ctx(580, 5), frontId: drift.id, trouble: drift.title }).changes);
    expect(city.fronts.map((f) => [f.id, f.status])).toEqual([
      ['drift', 'done'],
      ['trip', 'cancelled'],
      ['rebels', 'cancelled'],
    ]);
    expect(city.objects.find((o) => o.id === 'pier')!.status).toBe('active');
    expect(describeChanges(r, changes)).toEqual([
      'Случилось: «Островок уносит ветром»',
      'Исчезло: Прибившийся островок',
      'Исчезло: Башня на островке',
      'Упущено: «Найти рецепт в башне». Не стало того, на чём это держалось: Башня на островке',
      'Ушло само: «Бунтовщики засели в башне». Не стало того, на чём это держалось: Башня на островке',
    ]);
  });
});

describe('условия фронта изменились: обновляются он сам и соседи', () => {
  test('сосед — и тот, кто касается объекта, в который вложен наш', () => {
    const city = islet();
    city.fronts.push(createFront({ id: 'far', form: 'deed', origin: 'player', title: 'Маяк', description: '', capacity: 4, refs: ['pier'], day: 0 }));
    expect(neighbors(city, front(city, 'trip')).map((f) => f.id)).toEqual(['drift']);
    expect(neighbors(city, front(city, 'drift')).map((f) => f.id)).toEqual(['trip']);
  });

  test('якорь делает соседями фронт и всё, что касается якоря', () => {
    const city = islet();
    city.fronts.push(createFront({ id: 'far', form: 'deed', origin: 'player', title: 'Маяк', description: '', capacity: 4, refs: ['pier'], day: 0 }));
    applyStake(r, city, [{ op: 'hold', target: 'pier', frontId: 'drift', effect: 'stop' }], ctx(10));
    expect(neighbors(city, front(city, 'drift')).map((f) => f.id)).toEqual(['trip', 'far']);
  });

  test('якорь встал: экспедиция в списке на обновление, хотя её объекты не менялись', () => {
    const city = islet();
    city.fronts.push(createFront({ id: 'far', form: 'deed', origin: 'player', title: 'Маяк', description: '', capacity: 4, refs: ['wall'], day: 0 }));
    const made = applyStake(r, city, [chains()], ctx(40));
    expect(changedFrontIds(made.changes)).toEqual(['drift']);
    expect(refreshTargets(r, city, [], [], changedFrontIds(made.changes)).map((f) => f.id)).toEqual(['trip']);
    expect(refreshTargets(r, city, [], ['trip'], changedFrontIds(made.changes))).toEqual([]);
    expect(refreshTargets(r, city, [], [])).toEqual([]);
  });

  test('перемены якоря словами мира', () => {
    const city = islet();
    const made = applyStake(r, city, [chains()], ctx(40));
    expect(describeChanges(r, made.changes)).toEqual(['Появилось: Цепи (вещь)', 'Пока держится Цепи, не случится: «Островок уносит ветром»']);
    const out = applyStake(r, city, [{ op: 'delete', target: made.resultId! }], ctx(50, 4));
    expect(describeChanges(r, out.changes)).toEqual(['Исчезло: Цепи', 'Больше не держит: Цепи. Снова надвигается: «Островок уносит ветром»']);
  });
});
