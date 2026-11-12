import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { changedObjectIds, describeChanges, isNotable, type Change } from '../../src/core/world/changes.js';
import { nextEventDay } from '../../src/core/world/fronts.js';
import { parseScenario, plantScenario } from '../../src/core/world/scenario.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';

const r = rules();
const zero = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };

describe('перемены события: «дифф» для летописца', () => {
  const changes: Change[] = [
    { kind: 'object_created', objectId: 'b', name: 'Баллиста', type: 'structure', points: { ...zero, security: 12, prosperity: -2 }, temporary: false, hidden: false },
    { kind: 'object_created', objectId: 'h', name: 'Тайный сговор', type: 'community', points: zero, temporary: false, hidden: true },
    { kind: 'object_changed', objectId: 'g', name: 'Гильдия', delta: { ...zero, prosperity: -3 }, description: 'Гильдия в обиде' },
    { kind: 'object_removed', objectId: 's', name: 'Стройка', points: zero, hidden: false },
    { kind: 'front_opened', frontId: 'f', title: 'Ропот квартала', form: 'tension', plus: false },
    { kind: 'front_closed', frontId: 'p', title: 'Баллиста', outcome: 'done' },
    { kind: 'front_moved', frontId: 'p', title: 'Баллиста', how: 'frozen' },
  ];

  test('словами и без чисел; скрытое в список не попадает', () => {
    const lines = describeChanges(r, changes);
    expect(lines).toEqual([
      'Появилось: Баллиста (большое сооружение). Для города: благосостояние заметно ниже, безопасность резко выше',
      'Изменилось: Гильдия. Теперь: Гильдия в обиде. Для города: благосостояние заметно ниже',
      'Исчезло: Стройка',
      'Началось: «Ропот квартала» (растущее напряжение)',
      'Завершено: «Баллиста»',
      'Дело «Баллиста» встало, пока не снята угроза',
    ]);
    expect(lines.join(' ')).not.toMatch(/\d/);
  });

  test('эхо и обновление идут от объектов, чьё существование или вклад изменились', () => {
    expect(changedObjectIds(changes)).toEqual(['b', 'h', 'g', 's']);
    expect(changedObjectIds([{ kind: 'object_created', objectId: 't', name: 'Леса', type: 'site', points: zero, temporary: true, hidden: false }])).toEqual([]);
  });

  test('запись хроники нужна, когда в переменах есть видимое', () => {
    expect(isNotable([])).toBe(false);
    expect(isNotable([changes[1]!])).toBe(false);
    expect(isNotable(changes)).toBe(true);
  });
});

describe('сценарий', () => {
  const raw = yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, '../../scenarios/lantern-isle.yaml'), 'utf8'));

  test('заготовка в репо проходит схему', () => {
    expect(() => parseScenario(raw)).not.toThrow();
  });

  test('локальные id получают глобальные, ссылки переписываются', () => {
    const scenario = parseScenario(raw);
    const city = blankCity();
    const { objects, fronts } = plantScenario(r, city, scenario, { day: 3, newId: ids(9) });
    const tower = objects.find((o) => o.name.includes('Башня'));
    const island = objects.find((o) => o.type === 'site');
    expect(tower?.id).not.toBe('tower');
    expect(tower?.refs).toEqual([island?.id]);
    expect(fronts[0]?.refs).toContain(tower?.id);
    expect(city.scenariosUsed).toEqual([scenario.id]);
  });

  test('история ложится на новую модель: поиск без срока или угроза со сроком, скрытая логика уходит в ключ', () => {
    const scenario = parseScenario(raw);
    const city = blankCity();
    const { fronts } = plantScenario(r, city, scenario, { day: 3, newId: ids(9) });
    for (const [i, front] of fronts.entries()) {
      const source = scenario.fronts[i]!;
      const drifting = source.drift !== 'NONE';
      expect(front).toMatchObject({ origin: 'story', form: drifting ? 'threat' : 'find', capacity: r.seeding.capacity[source.impact] });
      expect(front.deadlineDay == null).toBe(!drifting);
      expect(drifting ? front.failStake.length : front.stake.length).toBe(source.stake ? 1 : 0);
      expect(front.script?.clues.map((c) => c.fact)).toEqual(source.clues.map((c) => c.fact));
      if (source.alignment) expect(front.key?.moves.length).toBeGreaterThan(0);
      if (drifting && source.events.length) expect(nextEventDay(front)).toBe(front.pulseDay);
    }
  });

  test('заготовка задаёт заголовок, род фронта, вклад и скрытость объектов', () => {
    const scenario = parseScenario({
      id: 'x',
      title: 'x',
      objects: [
        { id: 'a', type: 'community', name: 'Слушатели', weight: 'MINOR', statProfile: { influence: 1 } },
        { id: 'b', type: 'object', name: 'Груз', hidden: true },
      ],
      fronts: [
        { id: 'f', title: 'Толпа', form: 'tension', drift: 'FAST', description: 'Толпа растёт. Скоро выйдет на улицы.', impact: 'MINOR', stake: { stats: { security: -2 } } },
        { id: 'g', form: 'deed', description: 'Вскрыть груз.', impact: 'MINOR', stake: { uncover: { target: 'b' } } },
      ],
    });
    const city = blankCity();
    const { objects, fronts } = plantScenario(r, city, scenario, { day: 3, newId: ids(9) });
    expect(objects[0]!.statEffect.influence).toBeGreaterThan(0);
    expect(objects[1]!.hidden).toBe(true);
    expect(fronts[0]).toMatchObject({ title: 'Толпа', form: 'tension' });
    expect(fronts[0]!.deadlineDay).not.toBeNull();
    expect(fronts[1]).toMatchObject({ form: 'deed', stake: [{ op: 'reveal', target: objects[1]!.id }] });
    expect(() => parseScenario({ id: 'x', title: 'x', fronts: [{ id: 'f', form: 'tension', description: 'd', impact: 'MINOR' }] })).toThrow(/fronts\.0\.form/);
  });

  test('фронт истории толкает другой фронт и платит за это ёмкостью', () => {
    const scenario = parseScenario({
      id: 'x',
      title: 'x',
      fronts: [
        { id: 'debt', description: 'Соседи требуют долг.', impact: 'SIGNIFICANT', drift: 'SLOW', stake: { stats: { prosperity: -5 } } },
        { id: 'check', description: 'Проверить грамоту.', impact: 'MINOR', stake: { reveal: { text: 'Долг погашен.' } }, closes: [{ target: 'debt', share: 0.7 }] },
      ],
    });
    const city = blankCity();
    const { fronts } = plantScenario(r, city, scenario, { day: 3, newId: ids(9) });
    const debt = fronts[0]!;
    const check = fronts[1]!;
    const push = r.seeding.capacity.SIGNIFICANT * 0.7;
    expect(check.stake).toContainEqual({ op: 'progress', frontId: debt.id, amount: Math.round(push * 100) / 100 });
    expect(check.capacity).toBeCloseTo(Math.max(r.seeding.capacity.MINOR, push));
    expect(() =>
      parseScenario({ id: 'y', title: 'y', fronts: [{ id: 'a', description: 'd', impact: 'MINOR', drift: 'SLOW', closes: [{ target: 'b', share: 1 }] }, { id: 'b', description: 'd', impact: 'MINOR' }] }),
    ).toThrow(/closes/);
  });

  test('кривая заготовка падает с путём', () => {
    expect(() => parseScenario({ id: 'x', title: 'x', fronts: [{ id: 'f', description: 'd', impact: 'HUGE' }] })).toThrow(
      /fronts\.0\.impact/,
    );
  });
});
