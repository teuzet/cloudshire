import { describe, expect, test } from 'vitest';
import type { StoryTags } from '../../src/core/city.js';
import { createAssignment } from '../../src/core/world/assignments.js';
import { leanOf, markStory, mysteryShare, plusChance, roomForTrouble, troublePressure, unansweredTroubles, varietyWeight, wantsChance, wantsTrouble } from '../../src/core/world/director.js';
import { createFront } from '../../src/core/world/fronts.js';
import { parseScenario, scenarioTags } from '../../src/core/world/scenario.js';
import { blankCity, rng, rules } from '../helpers/fixtures.js';

const r = rules();
const crisis: StoryTags = { engine: 'crisis', source: 'matter', sphere: 'prosperity', mystery: false };
const feud: StoryTags = { engine: 'feud', source: 'matter', sphere: 'influence', mystery: false };

function trouble(id: string) {
  return createFront({ id, form: 'threat', origin: 'complication', title: id, description: id, capacity: 5, milestones: 1, risk: 'normal', footprint: [], day: 0 });
}

describe('режиссёр', () => {
  test('повтор мягкой оси делит вес: давно не бывшее желаннее', () => {
    const city = blankCity();
    markStory(city, crisis, 10);
    markStory(city, crisis, 20);
    expect(varietyWeight(r, city, feud, 30)).toBeGreaterThan(varietyWeight(r, city, crisis, 30));
  });

  test('журнал забывает старое за окном', () => {
    const city = blankCity();
    markStory(city, crisis, 0);
    expect(varietyWeight(r, city, crisis, r.fronts.director.windowDays + 1)).toBe(varietyWeight(r, city, feud, r.fronts.director.windowDays + 1));
  });

  test('вкус к источнику: странное желаннее людских дел', () => {
    const city = blankCity();
    expect(varietyWeight(r, city, { ...crisis, source: 'sky' }, 0)).toBeGreaterThan(varietyWeight(r, city, { ...crisis, source: 'people' }, 0));
  });

  test('тайна тянется к желаемой доле', () => {
    const city = blankCity();
    const mystery = { ...crisis, mystery: true };
    expect(mysteryShare(r, city, 0)).toBe(0);
    expect(varietyWeight(r, city, mystery, 0)).toBeGreaterThan(varietyWeight(r, city, crisis, 0));
    for (let i = 0; i < 5; i++) markStory(city, { ...feud, mystery: true }, i);
    expect(varietyWeight(r, city, mystery, 5)).toBeLessThan(varietyWeight(r, city, crisis, 5));
  });

  test('занятый сановник сферы делит вес', () => {
    const city = blankCity();
    const busy = createFront({ id: 'b', form: 'deed', origin: 'player', title: 'b', description: 'b', capacity: 5, milestones: 1, risk: 'normal', footprint: [], day: 0 });
    city.fronts.push(busy);
    const office = r.officers.find((o) => o.statId === 'prosperity')!.office;
    const officer = city.officers.find((o) => o.office === office)!;
    createAssignment(city, { id: 'a', front: busy, officer, day: 0 });
    const free = r.officers.find((o) => o.statId === 'knowledge')!.statId;
    expect(varietyWeight(r, city, { ...crisis, sphere: free }, 0)).toBeGreaterThan(varietyWeight(r, city, crisis, 0));
  });

  test('беды без ответа: места для новой беды меньше, удобных случаев больше', () => {
    const city = blankCity();
    expect(roomForTrouble(r, city)).toBe(1);
    expect(plusChance(r, city)).toBeCloseTo(r.fronts.director.plusBase);
    for (let i = 0; i < r.fronts.director.calmTroubles; i++) city.fronts.push(trouble(`t${i}`));
    expect(unansweredTroubles(city)).toBe(r.fronts.director.calmTroubles);
    expect(roomForTrouble(r, city)).toBe(0);
    expect(plusChance(r, city)).toBeCloseTo(r.fronts.director.plusMax);
  });

  test('заказ свободным генераторам: то, чего давно не было', () => {
    const city = blankCity();
    for (let i = 0; i < 4; i++) markStory(city, crisis, i);
    const lean = leanOf(r, city, 5, rng(3));
    expect(lean.engine).not.toBe('crisis');
    expect(lean.source).not.toBe('matter');
    expect(lean.mystery).toBe(true);
  });

  test('оси заготовки: тайна выводится из скрытого', () => {
    const base = { id: 's', title: 'S', axes: { engine: 'discovery', source: 'sky', sphere: 'knowledge' }, fronts: [{ id: 'f', description: 'Поиск', impact: 'MINOR' }] };
    expect(scenarioTags(parseScenario(base))).toEqual({ engine: 'discovery', source: 'sky', sphere: 'knowledge', mystery: false });
    const hidden = { ...base, objects: [{ id: 'o', type: 'object', name: 'Ключ', hidden: true }] };
    expect(scenarioTags(parseScenario(hidden)).mystery).toBe(true);
  });

  test('поток бед: режиссёр ждёт новую историю, пока беды дают меньше работы, чем три сановника на 70%', () => {
    const city = blankCity();
    expect(troublePressure(r, city, 100)).toBe(0);
    expect(wantsTrouble(r, city, 100)).toBe(true);
    // Пять бед по 5 единиц за три месяца — 8,3 в месяц при цели 8,4; шестая закрывает норму.
    for (let i = 0; i < 5; i++) city.fronts.push({ ...trouble(`t${i}`), createdDay: 40 + i });
    expect(troublePressure(r, city, 100)).toBeCloseTo(25 / 3);
    expect(wantsTrouble(r, city, 100)).toBe(true);
    // Случившаяся беда тоже в счёте: это нагрузка, которую город уже получил.
    city.fronts.push({ ...trouble('t5'), createdDay: 60, status: 'failed' });
    expect(wantsTrouble(r, city, 100)).toBe(false);
    // За окном беды забываются.
    expect(wantsTrouble(r, city, 100 + 90)).toBe(true);
  });

  test('возможности приходят так же часто, как беды: режиссёр ждёт возможность, пока их посажено меньше', () => {
    const city = blankCity();
    expect(wantsChance(r, city, 10)).toBe(false);
    markStory(city, crisis, 10, { kind: 'trouble', scale: 'episode' });
    // Осложнение от дела игрока знака не имеет и в счёт историй не идёт.
    markStory(city, feud, 12);
    expect(wantsChance(r, city, 20)).toBe(true);
    markStory(city, feud, 20, { kind: 'chance', scale: 'situation' });
    expect(wantsChance(r, city, 30)).toBe(false);
  });
});
