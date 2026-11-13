import { describe, expect, test } from 'vitest';
import type { City } from '../../src/core/city.js';
import { createFront } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { applyStake, hasModify } from '../../src/core/world/stake.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();

function ctx(day = 10) {
  return { day, newId: ids(3), frontId: 'p' };
}

function town(over: Partial<City> = {}) {
  const city = blankCity(over);
  city.objects.push(
    createObject(r, { id: 'wall', type: 'structure', name: 'Стена', description: 'Старая стена', statEffect: { security: 5 }, day: 0 }),
    createObject(r, { id: 'gate', type: 'structure', name: 'Ворота', description: 'Ворота в стене', parentId: 'wall', day: 0 }),
    createObject(r, { id: 'heart', type: 'landmark', name: 'Сердце острова', description: '', protected: true, day: 0 }),
    createObject(r, { id: 'cache', type: 'resource', name: 'Тайник', description: '', hidden: true, day: 0 }),
  );
  city.fronts.push(createFront({ id: 'p', form: 'deed', origin: 'player', title: 'Баллиста', description: '', capacity: 12, milestones: 3, day: 0 }));
  recomputeStats(city, r);
  return city;
}

describe('ставка: закрытый список операций', () => {
  test('create: вклад в пунктах переводится по курсу города, результат отмечается, мёртвые связи отбрасываются', () => {
    const city = town({ statScale: 2 });
    recomputeStats(city, r);
    const out = applyStake(r, city, [{ op: 'create', object: { type: 'structure', name: 'Баллиста', description: 'Большая баллиста', points: { prosperity: -2, security: 12, knowledge: 0, influence: 0 }, refs: ['wall', 'nowhere'] }, result: true }], ctx());
    const made = city.objects.find((o) => o.id === out.resultId)!;
    expect(made.statEffect.security).toBe(6);
    expect(made.refs).toEqual(['wall']);
    expect(city.stats.security).toBe(50 + 10 + 12);
    expect(out.changes[0]).toMatchObject({ kind: 'object_created', name: 'Баллиста', temporary: false });
  });

  test('revalue: новая версия объекта и разница вклада в переменах', () => {
    const city = town();
    const out = applyStake(r, city, [{ op: 'revalue', target: 'wall', points: { prosperity: 0, security: 2, knowledge: 0, influence: 0 }, description: 'Стена в трещинах' }], ctx());
    const wall = city.objects.find((o) => o.id === 'wall')!;
    expect(wall).toMatchObject({ version: 2, description: 'Стена в трещинах', freshDay: 10 });
    expect(city.stats.security).toBe(52);
    expect(out.changes[0]).toMatchObject({ kind: 'object_changed', delta: { security: -3 }, description: 'Стена в трещинах' });
  });

  test('modify ядро не исполняет: её заранее разворачивает поток', () => {
    const city = town();
    const ops = [{ op: 'modify', target: 'wall', intent: 'укрепить' }] as const;
    expect(hasModify(ops)).toBe(true);
    expect(applyStake(r, city, ops, ctx()).changes).toEqual([]);
  });

  test('delete: вложенное уходит вместе с родителем, защищённое остаётся', () => {
    const city = town();
    const out = applyStake(r, city, [{ op: 'delete', target: 'wall' }, { op: 'delete', target: 'heart' }], ctx());
    expect(out.changes.map((c) => (c.kind === 'object_removed' ? c.name : c.kind))).toEqual(['Стена', 'Ворота']);
    expect(city.objects.find((o) => o.id === 'heart')?.status).toBe('active');
    expect(city.stats.security).toBe(50);
  });

  test('reveal, fact и link', () => {
    const city = town();
    const out = applyStake(
      r,
      city,
      [
        { op: 'reveal', target: 'cache' },
        { op: 'fact', text: 'Под стеной нашли старый ход.' },
        { op: 'fact', text: 'Кто вырыл ход, неизвестно.' },
        { op: 'link', a: 'wall', b: 'cache' },
      ],
      ctx(),
    );
    expect(city.objects.find((o) => o.id === 'cache')?.hidden).toBe(false);
    expect(city.facts).toHaveLength(1);
    expect(city.facts[0]).toMatchObject({ author: 'event', frontId: 'p' });
    expect(city.objects.find((o) => o.id === 'wall')?.refs).toContain('cache');
    expect(out.changes.map((c) => c.kind)).toEqual(['object_revealed', 'fact', 'linked']);
  });

  test('progress, rollback и cancel двигают чужой фронт', () => {
    const city = town();
    const parent = city.fronts[0]!;
    applyStake(r, city, [{ op: 'progress', frontId: 'p', amount: 5 }], ctx());
    expect(parent.progress).toBe(5);
    applyStake(r, city, [{ op: 'progress', frontId: 'p', amount: 50 }], ctx());
    expect(parent.progress).toBe(12);
    parent.progress = 9;
    parent.milestonesFired = 2;
    expect(applyStake(r, city, [{ op: 'rollback', frontId: 'p' }], ctx()).changes[0]).toMatchObject({ kind: 'front_moved', how: 'rollback' });
    expect(parent.progress).toBe(4);
    expect(applyStake(r, city, [{ op: 'cancel', frontId: 'p' }], ctx()).changes[0]).toMatchObject({ kind: 'front_closed', outcome: 'cancelled' });
    expect(parent.status).toBe('cancelled');
  });

  test('attach: помощник или помеха появляются временным объектом на фронте', () => {
    const city = town();
    const zero = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };
    const out = applyStake(
      r,
      city,
      [
        { op: 'attach', frontId: 'p', rate: -2, object: { type: 'threat', name: 'Завал', description: 'Обвал на подвозе', points: zero } },
        { op: 'attach', frontId: 'p', rate: 2, object: { type: 'community', name: 'Артель', description: 'Нанятые каменщики', points: zero } },
      ],
      ctx(),
    );
    const attached = city.objects.filter((o) => o.attach?.frontId === 'p');
    expect(attached.map((o) => [o.name, o.temporary, o.attach?.rate])).toEqual([
      ['Завал', true, -2],
      ['Артель', true, 2],
    ]);
    expect(out.changes.filter((c) => c.kind === 'front_moved').map((c) => (c.kind === 'front_moved' ? c.how : ''))).toEqual(['slowed', 'helped']);
  });

  test('stats: перемена без носителя в мире идёт в ledger', () => {
    const city = town();
    applyStake(r, city, [{ op: 'stats', points: { prosperity: -3 } }], ctx());
    expect(city.stats.prosperity).toBe(47);
  });

  test('операция, цель которой исчезла, молча пропускается', () => {
    const city = town();
    const out = applyStake(
      r,
      city,
      [
        { op: 'revalue', target: 'gone', points: { prosperity: 1, security: 0, knowledge: 0, influence: 0 } },
        { op: 'delete', target: 'gone' },
        { op: 'progress', frontId: 'gone', amount: 3 },
        { op: 'link', a: 'wall', b: 'gone' },
      ],
      ctx(),
    );
    expect(out).toEqual({ changes: [], resultId: null });
  });
});

describe('выбывшие объекты', () => {
  const trouble = () => ({ ...ctx(20), trouble: 'Стена осыпается' });

  test('беда выводит объект из строя: он остаётся в городе без вклада и помнит прежний', () => {
    const city = town();
    const out = applyStake(r, city, [{ op: 'delete', target: 'wall' }], trouble());
    const wall = city.objects.find((o) => o.id === 'wall')!;
    expect(wall.status).toBe('active');
    expect(wall.out).toMatchObject({ day: 20, cause: 'Стена осыпается', was: { security: 5 } });
    expect(city.stats.security).toBe(50);
    expect(out.changes[0]).toMatchObject({ kind: 'object_out', name: 'Стена', delta: { security: -5 } });
    // Вложенное остаётся на месте: ворота никуда не делись.
    expect(city.objects.find((o) => o.id === 'gate')?.status).toBe('active');
  });

  test('беда, отнявшая весь вклад переоценкой, тоже выводит из строя; частичный урон — обычная перемена', () => {
    const city = town();
    applyStake(r, city, [{ op: 'revalue', target: 'wall', points: { prosperity: 0, security: 2, knowledge: 0, influence: 0 } }], trouble());
    expect(city.objects.find((o) => o.id === 'wall')?.out ?? null).toBeNull();
    const out = applyStake(r, city, [{ op: 'revalue', target: 'wall', points: { prosperity: 0, security: -2, knowledge: 0, influence: 0 } }], trouble());
    expect(out.changes[0]).toMatchObject({ kind: 'object_out' });
    expect(city.objects.find((o) => o.id === 'wall')?.out?.was.security).toBe(2);
    expect(city.stats.security).toBe(48);
  });

  test('restore возвращает прежний вклад и снимает пометку; дело игрока удаляет по-настоящему', () => {
    const city = town();
    applyStake(r, city, [{ op: 'delete', target: 'wall' }], trouble());
    const out = applyStake(r, city, [{ op: 'restore', target: 'wall', description: 'Стена отстроена заново' }], ctx(40));
    const wall = city.objects.find((o) => o.id === 'wall')!;
    expect(wall.out).toBeNull();
    expect(wall.description).toBe('Стена отстроена заново');
    expect(city.stats.security).toBe(55);
    expect(out.changes[0]).toMatchObject({ kind: 'object_back', delta: { security: 5 } });
    applyStake(r, city, [{ op: 'delete', target: 'wall' }], ctx(50));
    expect(wall.status).toBe('deleted');
  });

  test('скрытое и то, чей вид не хранится, беда стирает как раньше', () => {
    const city = town();
    city.objects.push(createObject(r, { id: 'rot', type: 'threat', name: 'Гниль', description: '', day: 0 }));
    applyStake(r, city, [{ op: 'delete', target: 'cache' }, { op: 'delete', target: 'rot' }], trouble());
    expect(city.objects.find((o) => o.id === 'cache')?.status).toBe('deleted');
    expect(city.objects.find((o) => o.id === 'rot')?.status).toBe('deleted');
  });
});
