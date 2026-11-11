import { describe, expect, test } from 'vitest';
import { createAssignment } from '../../src/core/world/assignments.js';
import { applyBeatPick, beginBeat, closeNextResultAssignments, defaultBeatPick } from '../../src/core/world/beats.js';
import { createFront, recomputeRate } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { applyStake, stakeNeedsVersion } from '../../src/core/world/stake.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';
import type { City, Front, Stake } from '../../src/core/city.js';

const r = rules();
const id = ids(3);

function flood(city: City): Front {
  const f = createFront(r, {
    id: id('front'),
    description: 'Подступающая вода ломает постройки.',
    stake: { stats: { prosperity: -6 } },
    effort: 6,
    driftBand: 'FAST',
    beatCount: 2,
    events: [
      { id: 'gates-lower', description: 'Вырвало шлюзы в нижнем квартале.' },
      { id: 'workshops', description: 'Затопило мастерские.' },
    ],
    day: 0,
  });
  city.fronts.push(f);
  return f;
}

function assign(city: City, front: Front, verdict: Partial<Parameters<typeof createAssignment>[0]['verdict']> = {}) {
  const a = createAssignment({
    id: id('asg'),
    frontId: front.id,
    office: 'treasurer',
    text: 'Укрепить шлюзы',
    verdict: { direction: 'forward', efficiency: 'normal', blocks: [], stopWhen: 'stake', ...verdict },
    day: 0,
  });
  city.assignments.push(a);
  const officer = city.officers.find((o) => o.office === 'treasurer');
  if (officer) officer.assignmentId = a.id;
  return a;
}

describe('порог', () => {
  test('порог срабатывает один раз', () => {
    const city = blankCity();
    const f = flood(city);
    recomputeRate(r, city, f, 0);
    const start = beginBeat(r, city, f, 30);
    expect(start?.index).toBe(0);
    expect(beginBeat(r, city, f, 30)).toBeNull();
  });

  test('рано — порога нет', () => {
    const city = blankCity();
    const f = flood(city);
    recomputeRate(r, city, f, 0);
    expect(beginBeat(r, city, f, 1)).toBeNull();
  });

  test('заблокированное событие выпадает, но ущерба нет', () => {
    const city = blankCity();
    const f = flood(city);
    assign(city, f, { direction: 'backward', blocks: ['gates-lower'] });
    // Сановник успел вложить хотя бы единицу effort.
    city.assignments[0]!.effortDone = 1;
    f.progress = 2.1;
    const start = beginBeat(r, city, f, 0);
    expect(start).not.toBeNull();
    const out = applyBeatPick(f, { eventId: 'gates-lower', clueId: null });
    expect(out.averted).toBe(true);
    expect(out.fact).toMatch(/Подготовка сдержала/);
  });

  test('блок не срабатывает, пока сановник не поработал', () => {
    const city = blankCity();
    const f = flood(city);
    assign(city, f, { direction: 'backward', blocks: ['gates-lower'] });
    f.progress = 2.1;
    beginBeat(r, city, f, 0);
    expect(f.events.find((e) => e.id === 'gates-lower')?.status).toBe('live');
  });

  test('без агента берётся первое событие, потом улика', () => {
    expect(defaultBeatPick({ events: [], clues: [{ id: 'c', fact: 'f', alignment: '', status: 'hidden' }] })).toEqual({
      eventId: null,
      clueId: 'c',
    });
  });

  test('поручение «до результата» закрывается после порога и освобождает сановника', () => {
    const city = blankCity();
    const f = flood(city);
    const a = assign(city, f, { stopWhen: 'next_result' });
    closeNextResultAssignments(city, f, 5);
    expect(a.status).toBe('done');
    expect(city.officers.find((o) => o.office === 'treasurer')?.assignmentId).toBeNull();
  });
});

describe('ставка', () => {
  function withStake(stake: Stake) {
    const city = blankCity();
    const f = createFront(r, { id: id('front'), description: 'Дело', stake, effort: 2, driftBand: 'NONE', beatCount: 0, day: 0 });
    city.fronts.push(f);
    return { city, f };
  }

  test('create добавляет объект и двигает статы', () => {
    const { city, f } = withStake({
      create: { type: 'structure', name: 'Великая баллиста', description: 'Огромная', statEffect: { prosperity: 0, security: 5, knowledge: 0, influence: 0 } },
    });
    const before = city.stats.security;
    const res = applyStake(r, city, f, { day: 10, newObjectId: () => 'obj_b' });
    expect(res.invalid).toBeNull();
    expect(city.objects.map((o) => o.name)).toContain('Великая баллиста');
    expect(city.stats.security).toBe(before + 5);
    expect(f.status).toBe('resolved');
  });

  test('stats пишет в ledger', () => {
    const { city, f } = withStake({ stats: { prosperity: -6 } });
    applyStake(r, city, f, { day: 1, newObjectId: () => 'x' });
    expect(city.stats.prosperity).toBe(44);
  });

  test('delete защищённого объекта делает фронт invalid', () => {
    const { city, f } = withStake({ delete: { target: 'core' } });
    city.objects.push(createObject(r, { id: 'core', type: 'settlement', name: 'Город', description: '', day: 0, protected: true }));
    const res = applyStake(r, city, f, { day: 1, newObjectId: () => 'x' });
    expect(res.invalid).toBe('protected');
    expect(f.status).toBe('invalid');
  });

  test('modify без готовой версии просит агента', () => {
    const { f } = withStake({ modify: { target: 'tower' } });
    expect(stakeNeedsVersion(f)).toEqual({ target: 'tower' });
  });

  test('modify с версией добавляет версию объекта', () => {
    const { city, f } = withStake({ modify: { target: 'tower' } });
    city.objects.push(createObject(r, { id: 'tower', type: 'structure', name: 'Башня', description: 'Закрыта', day: 0 }));
    applyStake(r, city, f, {
      day: 3,
      newObjectId: () => 'x',
      version: { description: 'Открыта', weight: 'MINOR', statProfile: { knowledge: 1 } },
    });
    const tower = city.objects[0]!;
    expect(tower.version).toBe(2);
    expect(tower.description).toBe('Открыта');
    expect(tower.versions[0]?.description).toBe('Закрыта');
  });

  test('ставка закрывает все поручения фронта', () => {
    const { city, f } = withStake({ reveal: { text: 'Тайна' } });
    const a = assign(city, f, { stopWhen: 'cancelled' });
    applyStake(r, city, f, { day: 1, newObjectId: () => 'x' });
    expect(a.status).toBe('done');
  });
});
