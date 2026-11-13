import { describe, expect, test } from 'vitest';
import type { City, Front } from '../../src/core/city.js';
import { createAssignment } from '../../src/core/world/assignments.js';
import { accidentLoss, buildBound, buildOpportunity, buildSide, hindranceOp, tensionToThreat, type EventDress } from '../../src/core/world/complications.js';
import { candidateWeight, candidates, drawOrder, rollRisk, shapeFor, weightedOrder } from '../../src/core/world/dynamics.js';
import { refreshTargets } from '../../src/core/world/echo.js';
import { createFront } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { themeNames } from '../../src/core/world/themes.js';
import { blankCity, ids, rng, rules } from '../helpers/fixtures.js';

const r = rules();
const id = ids();
const dress: EventDress = { title: 'Ропот гильдии', description: 'Каменщики недовольны', outburst: 'Гильдия бросит работу', newObject: null };

function town(risk: Front['risk'] = 'hard') {
  const city = blankCity();
  city.objects.push(
    createObject(r, { id: 'guild', type: 'organization', name: 'Гильдия каменщиков', description: '', statEffect: { prosperity: 5 }, day: 0 }),
    createObject(r, { id: 'quarter', type: 'community', name: 'Жители квартала', description: '', day: 0 }),
    createObject(r, { id: 'market', type: 'district', name: 'Рынок', description: '', refs: ['guild'], day: 0 }),
    createObject(r, { id: 'tower', type: 'structure', name: 'Сторожевая башня', description: '', statEffect: { security: 5 }, day: 0 }),
  );
  const front = createFront({
    id: 'p',
    form: 'deed',
    origin: 'player',
    title: 'Баллиста',
    description: 'Строят баллисту',
    capacity: 22,
    milestones: 3,
    risk,
    footprint: [
      { objectId: 'guild', relation: 'occupies', reason: 'мастера заняты на стройке' },
      { objectId: 'quarter', relation: 'pressures', reason: 'стройка шумит под окнами' },
    ],
    day: 0,
  });
  city.fronts.push(front);
  return { city, front };
}

function withLead(city: City, front: Front) {
  createAssignment(city, { id: id('asg'), front, officer: city.officers[1]!, day: 0 });
}

const idsOf = (list: ReturnType<typeof candidates>) => [...new Set(list.map((c) => c.dynamic.id))].sort();

describe('словарь динамик: кто подходит технически', () => {
  test('лёгкая беда на вехе: роли берутся из отпечатка', () => {
    const { city, front } = town();
    withLead(city, front);
    const list = candidates(r, city, front, { moment: 'milestone', kind: 'light' });
    expect(idsOf(list)).toEqual(expect.arrayContaining(['bystanders', 'key-refuse', 'occupied-strained', 'touched-resist', 'weather', 'omen']));
    expect(list.find((c) => c.dynamic.id === 'key-refuse')).toMatchObject({ object: { id: 'guild' }, shape: 'tension', touch: 'мастера заняты на стройке' });
    expect(list.find((c) => c.dynamic.id === 'bystanders')?.object?.id).toBe('market');
  });

  test('дело без ведущего открывает свою запись, тяжёлая беда на высокой ступени — аварию', () => {
    const { city, front } = town('risky');
    const list = candidates(r, city, front, { moment: 'milestone', kind: 'heavy' });
    expect(idsOf(list)).toContain('squatters');
    expect(idsOf(list)).toContain('accident');
    expect(list.find((c) => c.dynamic.id === 'accident')).toMatchObject({ object: null, shape: 'accident' });
    withLead(city, front);
    expect(idsOf(candidates(r, city, front, { moment: 'milestone', kind: 'heavy' }))).not.toContain('squatters');
  });

  test('ступень ниже порога записи её не пускает; плюсовым записям ступень не важна', () => {
    const { city, front } = town('safe');
    expect(candidates(r, city, front, { moment: 'milestone', kind: 'light' })).toEqual([]);
    expect(idsOf(candidates(r, city, front, { moment: 'milestone', kind: 'plus' }))).toEqual(expect.arrayContaining(['find-at-works', 'new-craft']));
  });

  test('только побочные: привязанных к делу записей нет', () => {
    const { city, front } = town();
    const list = candidates(r, city, front, { moment: 'milestone', kind: 'heavy', sideOnly: true });
    expect(list.every((c) => c.dynamic.class === 'side')).toBe(true);
    expect(idsOf(list)).toEqual(expect.arrayContaining(['bystanders', 'occupied-strained', 'neglected-duty']));
  });

  test('при завершении записи бьют по результату; без результата их нет', () => {
    const { city, front } = town();
    city.objects.push(createObject(r, { id: 'ballista', type: 'structure', name: 'Баллиста', description: '', day: 0 }));
    const list = candidates(r, city, front, { moment: 'completion', kind: 'light', resultId: 'ballista' });
    expect(idsOf(list)).toEqual(expect.arrayContaining(['abuse', 'displacement', 'touched-revenge']));
    expect(list.find((c) => c.dynamic.id === 'displacement')?.object?.id).toBe('tower');
    expect(candidates(r, city, front, { moment: 'completion', kind: 'light' }).some((c) => c.dynamic.hits === 'result')).toBe(false);
  });

  test('при срыве роли берутся из того, по чему ударила беда, и его соседей', () => {
    const { city } = town();
    const threat = createFront({ id: 't', form: 'threat', origin: 'story', title: 'Пожар на рынке', description: '', capacity: 4, deadlineDay: 10, refs: ['market'], day: 0 });
    city.fronts.push(threat);
    const light = candidates(r, city, threat, { moment: 'failure', kind: 'light' });
    expect(light.find((c) => c.dynamic.id === 'homeless')?.object?.id).toBe('market');
    expect(light.filter((c) => c.dynamic.id === 'blame').map((c) => c.object?.id)).toContain('guild');
    expect(light.every((c) => c.dynamic.when.includes('failure'))).toBe(true);
    expect(idsOf(candidates(r, city, threat, { moment: 'failure', kind: 'plus' }))).toEqual(expect.arrayContaining(['salvage']));
  });

  test('запись без такой тяжести не предлагается', () => {
    const accident = r.fronts.dynamics.find((d) => d.id === 'accident')!;
    expect(shapeFor(accident, 'light')).toBeNull();
    expect(shapeFor(accident, 'heavy')).toBe('accident');
    expect(shapeFor(accident, 'plus')).toBeNull();
  });
});

describe('режиссёрский жребий', () => {
  test('свежий объект и давно не игравшая запись весят больше', () => {
    const { city, front } = town();
    const [guild, quarter] = candidates(r, city, front, { moment: 'milestone', kind: 'light' }).filter((c) => c.dynamic.class === 'bound');
    // Вкус режиссёра к источнику записи входит в вес множителем.
    const taste = (c: typeof guild) => r.fronts.director.sourceTaste[c!.dynamic.source] ?? 1;
    expect(candidateWeight(r, city, guild!, 10)).toBeCloseTo(9 * taste(guild));
    expect(candidateWeight(r, city, quarter!, 720)).toBeCloseTo(3 * taste(quarter));
    city.dynamicsUsed['key-refuse'] = 10;
    expect(candidateWeight(r, city, guild!, 10)).toBeCloseTo(3 * taste(guild));
  });

  test('порядок вопросов Примерщику — взвешенная перестановка, обрезанная пределом', () => {
    const order = weightedOrder(['a', 'b', 'c'], (x) => (x === 'b' ? 100 : 0.001), rng(3));
    expect(order[0]).toBe('b');
    expect([...order].sort()).toEqual(['a', 'b', 'c']);
    const { city, front } = town('risky');
    const many = [...candidates(r, city, front, { moment: 'milestone', kind: 'heavy' }), ...candidates(r, city, front, { moment: 'milestone', kind: 'light' })];
    expect(many.length).toBeGreaterThan(r.fronts.director.fitterCalls);
    expect(drawOrder(r, city, many, 0, rng(1))).toHaveLength(r.fronts.director.fitterCalls);
  });

  test('бросок риска: долю удобных случаев задаёт режиссёр', () => {
    expect(rollRisk({ chance: 0, heavyShare: 1, plusChance: 0 }, rng(1))).toBeNull();
    expect(rollRisk({ chance: 1, heavyShare: 1, plusChance: 0 }, rng(1))).toBe('heavy');
    expect(rollRisk({ chance: 1, heavyShare: 0, plusChance: 0 }, rng(1))).toBe('light');
    expect(rollRisk({ chance: 1, heavyShare: 1, plusChance: 1 }, rng(1))).toBe('plus');
  });
});

describe('сборка осложнений', () => {
  const args = { dress, key: null, dynamicId: 'key-refuse', roleId: 'guild', id: 'c', day: 10, rng: rng(5) };

  test('привязанное: чем грозит делу, зависит от ступени риска', () => {
    const normal = buildBound(r, town('normal').front, { ...args, shape: 'tension' });
    expect(normal).toMatchObject({ form: 'tension', bound: 'slow', parentId: 'p', atStake: 3.3, capacity: 1, refs: ['guild'] });
    expect(normal.failStake[0]).toMatchObject({ op: 'attach', frontId: 'p', rate: -2 });
    expect(normal.deadlineDay! - 10).toBeGreaterThanOrEqual(60);
    expect(normal.deadlineDay! - 10).toBeLessThanOrEqual(120);

    const hard = buildBound(r, town('hard').front, { ...args, shape: 'threat' });
    expect(hard).toMatchObject({ form: 'threat', bound: 'rollback', deadlineDay: 43, failStake: [{ op: 'rollback', frontId: 'p' }] });
    expect(hard.atStake).toBeCloseTo(22 / 3);
    expect(hard.capacity).toBeCloseTo(2.93);

    const risky = buildBound(r, town('risky').front, { ...args, shape: 'threat' });
    expect(risky).toMatchObject({ bound: 'cancel', atStake: 22, capacity: 8.8, failStake: [{ op: 'cancel', frontId: 'p' }] });
  });

  test('побочное: на кону разница вклада объекта', () => {
    const { city } = town();
    const guild = city.objects[0]!;
    const side = { origin: 'complication' as const, target: guild, newPoints: { prosperity: 0, security: 0, knowledge: 0, influence: 0 }, dress, key: null, dynamicId: null, id: 's', day: 10, rng: rng(5) };
    const threat = buildSide(r, city, { ...side, shape: 'threat' });
    expect(threat).toMatchObject({ form: 'threat', atStake: 5, capacity: 5, deadlineDay: 66, parentId: null, refs: ['guild'] });
    expect(threat.failStake).toEqual([{ op: 'revalue', target: 'guild', points: side.newPoints }]);
    expect(buildSide(r, city, { ...side, shape: 'threat', origin: 'echo' }).deadlineDay).toBe(130);
    const clock = buildSide(r, city, { ...side, shape: 'clock' });
    expect(clock).toMatchObject({ form: 'clock', capacity: 0, deadlineDay: 130 });
    expect(clock.stake).toHaveLength(1);
    expect(buildSide(r, city, { ...side, shape: 'tension' })).toMatchObject({ form: 'tension', capacity: 2.5 });
  });

  test('удобный случай: плюсовое дело со скидкой и сроком', () => {
    const chance = buildOpportunity(r, { origin: 'complication', stake: [], gain: 10, dress, key: null, dynamicId: 'find-at-works', refs: [], id: 'o', day: 10 });
    expect(chance).toMatchObject({ form: 'deed', plus: true, capacity: 5, deadlineDay: 130, atStake: 10 });
  });

  test('помеха — объект с отрицательной скоростью; новый участник от Костюмера становится ею', () => {
    const { front } = town();
    expect(hindranceOp(r, front, dress)).toMatchObject({ op: 'attach', rate: -2, object: { type: 'threat', name: 'Ропот гильдии' } });
    const named = hindranceOp(r, front, { ...dress, newObject: { type: 'community', name: 'Самовольные жильцы', description: 'Заняли леса' } });
    expect(named).toMatchObject({ object: { type: 'community', name: 'Самовольные жильцы' } });
  });

  test('напряжение прорывается в угрозу: доля сделанного сохраняется', () => {
    const { city } = town();
    const tension = buildSide(r, city, { shape: 'tension', origin: 'complication', target: city.objects[3]!, newPoints: { prosperity: 0, security: -5, knowledge: 0, influence: 0 }, dress, key: null, dynamicId: null, id: 't', day: 0, rng: rng(5) });
    expect(tension.capacity).toBe(5);
    tension.progress = 2.5;
    tensionToThreat(r, tension, 70);
    // Осталось 5 единиц работы: срок 5 / 4 × 1,5 месяца.
    expect(tension).toMatchObject({ form: 'threat', capacity: 10, progress: 5, deadlineDay: 126, milestones: 1 });
  });

  test('авария съедает четверть набранного', () => {
    const { front } = town();
    front.progress = 8;
    expect(accidentLoss(r, front, 0)).toBe(2);
    expect(front.progress).toBe(6);
  });
});

describe('обновление после перемен', () => {
  test('обновляются дела, которых касается перемена, кроме источника и часов', () => {
    const { city, front } = town();
    city.fronts.push(
      createFront({ id: 'other', form: 'find', origin: 'story', title: 'y', description: '', capacity: 3, refs: ['guild'], day: 0 }),
      createFront({ id: 'clock', form: 'clock', origin: 'complication', title: 'z', description: '', capacity: 0, deadlineDay: 50, refs: ['guild'], day: 0 }),
    );
    expect(refreshTargets(r, city, ['guild'], []).map((f) => f.id)).toEqual(['p', 'other']);
    expect(refreshTargets(r, city, ['guild'], [front.id]).map((f) => f.id)).toEqual(['other']);
    expect(refreshTargets(r, city, ['tower'], [])).toEqual([]);
  });

  test('темы города: самые весомые по вкладу объектов', () => {
    const { city } = town();
    city.objects[0]!.themes = ['камень'];
    city.objects[3]!.themes = ['камень', 'оборона'];
    city.objects[1]!.themes = ['соседи'];
    expect(themeNames(city).slice(0, 2)).toEqual(['камень', 'оборона']);
  });
});

describe('предел удара побочной беды', () => {
  test('беда отнимает вклад объекта и уводит его не глубже малого минуса', async () => {
    const { capSideHit } = await import('../../src/core/world/complications.js');
    const rr = rules();
    const small = rr.fronts.contribution.small;
    const before = { prosperity: 0, security: 5, knowledge: 2, influence: -4 };
    const hit = { prosperity: -5, security: -12, knowledge: 1, influence: -9 };
    expect(capSideHit(rr, before, hit)).toEqual({ prosperity: -small, security: -small, knowledge: 1, influence: -4 - small });
  });
});
