import { describe, expect, test } from 'vitest';
import { createAssignment } from '../../src/core/world/assignments.js';
import { createFront } from '../../src/core/world/fronts.js';
import { stewardPick, unattendedTroubles } from '../../src/core/world/steward.js';
import { blankCity, rules } from '../helpers/fixtures.js';

const r = rules();
const weeks = r.fronts.steward.waitDays.weeks;

function trouble(id: string, day: number, deadline: number | null, profile: 'security' | 'knowledge' | null = null) {
  const f = createFront({ id, form: 'threat', origin: 'complication', title: id, description: `Описание ${id}.`, capacity: 5, milestones: 1, risk: 'normal', footprint: [], day });
  f.deadlineDay = deadline;
  f.profile = profile;
  f.key = { moves: [`Способ против ${id}`, 'второй'], twist: null };
  return f;
}

describe('наказ жрецу', () => {
  test('по умолчанию жрец ждёт слова покровителя, потом ставит сам', () => {
    const city = blankCity();
    city.fronts.push(trouble('t', 0, 100));
    expect(stewardPick(r, city, weeks - 1)).toBeNull();
    const pick = stewardPick(r, city, weeks);
    expect(pick?.front.id).toBe('t');
    expect(pick?.move).toBe('Способ против t');
  });

  test('«ставь сразу» не ждёт, «только сообщай» никого не ставит', () => {
    const city = blankCity({ steward: { mode: 'act', wait: 'season', spare: [], text: '' } });
    city.fronts.push(trouble('t', 0, 100));
    expect(stewardPick(r, city, 0)?.front.id).toBe('t');
    city.steward = { mode: 'report', wait: 'days', spare: [], text: '' };
    expect(stewardPick(r, city, 500)).toBeNull();
  });

  test('самая срочная беда первой, сановник — по сфере беды', () => {
    const city = blankCity({ steward: { mode: 'act', wait: 'days', spare: [], text: '' } });
    city.fronts.push(trouble('late', 0, 200), trouble('soon', 5, 50, 'security'));
    const pick = stewardPick(r, city, 10)!;
    expect(pick.front.id).toBe('soon');
    expect(pick.officer.statId).toBe('security');
  });

  test('сбережённого сановника жрец не трогает; беда с ведущим не в списке', () => {
    const marshal = r.officers.find((o) => o.statId === 'security')!.office;
    const city = blankCity({ steward: { mode: 'act', wait: 'days', spare: [marshal], text: '' } });
    const soon = trouble('soon', 0, 50, 'security');
    city.fronts.push(soon);
    expect(stewardPick(r, city, 0)!.officer.office).not.toBe(marshal);
    createAssignment(city, { id: 'a', front: soon, officer: city.officers[0]!, day: 0 });
    expect(unattendedTroubles(city)).toHaveLength(0);
  });

  test('все свободные сбережены или заняты — жрец ждёт', () => {
    const city = blankCity({ steward: { mode: 'act', wait: 'days', spare: r.officers.map((o) => o.office), text: '' } });
    city.fronts.push(trouble('t', 0, 50));
    expect(stewardPick(r, city, 0)).toBeNull();
  });
});
