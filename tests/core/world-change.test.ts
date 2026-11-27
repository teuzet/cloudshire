import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { changedObjectIds, describeChanges, isNotable, type Change } from '../../src/core/world/changes.js';
import { deadlineOf, nextEventDay } from '../../src/core/world/fronts.js';
import { parseScenario, plantScenario, storyKind } from '../../src/core/world/scenario.js';
import { magnitude } from '../../src/core/world/numbers.js';
import { pullOf } from '../../src/core/world/objects.js';
import { applyStake } from '../../src/core/world/stake.js';
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
      'Появилось: Баллиста (большое сооружение). В жизни города: заметно в лавках, мастерских и амбарах убавилось, резко на улицах и у стен стало спокойнее',
      'Изменилось: Гильдия. Теперь: Гильдия в обиде. В жизни города: заметно в лавках, мастерских и амбарах убавилось',
      'Исчезло: Стройка',
      'Началось: «Ропот квартала» — растёт недовольство',
      'Сделано: «Баллиста»',
      'Работа над «Баллиста» встала, пока опасность рядом',
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
    const { fronts, objects } = plantScenario(r, city, scenario, { day: 3, newId: ids(9) });
    // Срок истории — отдельный фронт-часы: он живёт на островке и унесёт его навсегда.
    const island = objects.find((o) => o.type === 'site')!;
    const clock = fronts.find((f) => f.form === 'clock')!;
    expect(clock).toMatchObject({ origin: 'story', plus: false, capacity: 0, deadlineDay: 3 + r.seeding.chanceMonths * 30, livesOn: island.id, stake: [{ op: 'retire', target: island.id, forever: true }] });
    for (const [i, front] of fronts.filter((f) => f.form !== 'clock').entries()) {
      const source = scenario.fronts[i]!;
      const drifting = source.drift !== 'NONE';
      expect(front).toMatchObject({ origin: 'story', form: drifting ? 'threat' : 'find', capacity: r.seeding.capacity[source.impact] });
      // История без беды — возможность: своего срока у её фронтов нет, он приходит от часов.
      const chance = scenario.fronts.every((f) => f.drift === 'NONE');
      expect(front.deadlineDay == null).toBe(!drifting);
      if (chance) {
        expect(front.livesOn).toBe(island.id);
        expect(deadlineOf(city, front)).toBe(clock.deadlineDay);
      }
      expect(front.plus).toBe(chance);
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
    // Объект истории приходит без вклада: ценность он получит ставкой.
    expect(objects[0]!.statEffect.influence).toBe(0);
    expect(objects[1]!.hidden).toBe(true);
    expect(fronts[0]).toMatchObject({ title: 'Толпа', form: 'tension' });
    expect(fronts[0]!.deadlineDay).not.toBeNull();
    expect(fronts[1]).toMatchObject({ form: 'deed', stake: [{ op: 'reveal', target: objects[1]!.id }] });
    expect(() => parseScenario({ id: 'x', title: 'x', fronts: [{ id: 'f', form: 'tension', description: 'd', impact: 'MINOR' }] })).toThrow(/fronts\.0\.form/);
  });

  test('язык правок в заготовке: вложенность, носитель, срок-часы и якорь у результата', () => {
    const scenario = parseScenario({
      id: 'x',
      title: 'x',
      objects: [
        { id: 'isle', type: 'site', name: 'Островок' },
        { id: 'hut', type: 'structure', name: 'Хижина', inside: 'isle' },
      ],
      window: { description: 'Островок унесёт ветром. Он едва держится у кромки.', livesOn: 'isle' },
      fronts: [
        { id: 'moor', form: 'deed', description: 'Привязать островок.', impact: 'MINOR', stake: { create: { type: 'structure', name: 'Причальные цепи', description: 'Цепи.', holds: [{ front: 'window', effect: 'stop' }] } } },
        { id: 'search', description: 'Обыскать хижину.', impact: 'MINOR', livesOn: 'hut' },
      ],
    });
    const city = blankCity();
    const newId = ids(9);
    const { objects, fronts } = plantScenario(r, city, scenario, { day: 0, newId });
    const [isle, hut] = objects as [(typeof objects)[number], (typeof objects)[number]];
    const [moor, search, clock] = fronts as [(typeof fronts)[number], (typeof fronts)[number], (typeof fronts)[number]];
    expect(hut.parentId).toBe(isle.id);
    // Название часов без своего title — первая фраза описания.
    expect(clock).toMatchObject({ form: 'clock', title: 'Островок унесёт ветром', livesOn: isle.id });
    expect(moor.livesOn).toBe(isle.id);
    expect(search.livesOn).toBe(hut.id);
    const end = clock.deadlineDay!;
    // Хижина стоит на островке: её поиск кончится вместе с ним.
    expect(deadlineOf(city, search)).toBe(end);

    // Цепи готовы: срок встал, пока они целы.
    const made = applyStake(r, city, moor.stake, { day: 30, newId });
    const chains = city.objects.find((o) => o.name === 'Причальные цепи')!;
    expect(describeChanges(r, made.changes)).toContain('Пока есть Причальные цепи, не случится: «Островок унесёт ветром»');
    expect(clock).toMatchObject({ deadlineDay: null, sleepLeft: end - 30 });
    expect(deadlineOf(city, search)).toBeNull();

    // Цепи сбили: срок пошёл с того места, где встал.
    const cut = applyStake(r, city, [{ op: 'delete', target: chains.id }], { day: 50, newId });
    expect(describeChanges(r, cut.changes)).toContain('Опоры больше нет: Причальные цепи. Снова надвигается: «Островок унесёт ветром»');
    expect(clock.deadlineDay).toBe(50 + end - 30);

    // Время вышло: островок уходит со всем, что на нём стояло и жило.
    const gone = applyStake(r, city, clock.stake, { day: clock.deadlineDay!, newId, trouble: clock.title });
    expect(isle.status).toBe('deleted');
    expect(hut.status).toBe('deleted');
    expect(isle.out).toMatchObject({ forever: true, cause: 'Островок унесёт ветром' });
    expect([moor.status, search.status]).toEqual(['cancelled', 'cancelled']);
    expect(describeChanges(r, gone.changes)).toContain('Упущено: «Обыскать хижину». Не стало того, на чём это держалось: Хижина');
  });

  test('объект истории держит её беду с порога; беда, что унесёт носитель, даёт срок делу на нём', () => {
    const story = (holds: unknown[]) =>
      parseScenario({
        id: 'y',
        title: 'y',
        objects: [{ id: 'dam', type: 'structure', name: 'Старая плотина', holds }],
        fronts: [{ id: 'flood', description: 'Вода поднимается.', impact: 'MINOR', drift: 'STEADY', stake: { stats: { prosperity: -2 } } }],
      });
    const free = plantScenario(r, blankCity(), story([]), { day: 0, newId: ids(4) }).fronts[0]!;
    const city = blankCity();
    const { fronts, objects } = plantScenario(r, city, story([{ front: 'flood', effect: 'slow' }]), { day: 0, newId: ids(4) });
    expect(objects[0]!.holds).toMatchObject([{ frontId: fronts[0]!.id, effect: 'slow' }]);
    expect(fronts[0]!.deadlineDay).toBe(Math.ceil(free.deadlineDay! / r.fronts.hold.slowFactor));

    const shard = parseScenario(yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, '../../scenarios/drift-shard.yaml'), 'utf8')));
    const town = blankCity();
    const planted = plantScenario(r, town, shard, { day: 0, newId: ids(5) });
    const [cedar, leaves] = planted.fronts as [(typeof fronts)[number], (typeof fronts)[number]];
    expect(cedar).toMatchObject({ form: 'deed', deadlineDay: null, livesOn: planted.objects[0]!.id });
    expect(deadlineOf(town, cedar)).toBe(leaves.deadlineDay);
    // Осколок оторвало: дело на нём оборвалось.
    const hit = applyStake(r, town, leaves.failStake, { day: leaves.deadlineDay!, newId: ids(6), trouble: leaves.title });
    expect(cedar.status).toBe('cancelled');
    expect(describeChanges(r, hit.changes)).toContain('Оборвалось: «Кедровый брус не гниёт и не боится жучка». Не стало того, на чём это держалось: Кедровый осколок');
  });

  test('заготовка с якорем на чужой фронт, занятым id окна или объектом внутри себя не проходит', () => {
    const base = { id: 'x', title: 'x', fronts: [{ id: 'f', description: 'd', impact: 'MINOR' }] };
    expect(() => parseScenario({ ...base, objects: [{ id: 'a', type: 'site', name: 'A', holds: [{ front: 'nope', effect: 'stop' }] }] })).toThrow(/objects\.0\.holds\.0\.front/);
    expect(() => parseScenario({ ...base, objects: [{ id: 'a', type: 'site', name: 'A', inside: 'a' }] })).toThrow(/objects\.0\.inside/);
    expect(() => parseScenario({ ...base, objects: [{ id: 'a', type: 'site', name: 'A' }], window: { id: 'f', description: 'd', livesOn: 'a' } })).toThrow(/window\.id/);
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
    // Беда стоит столько, сколько отнимет: пять пунктов достатка — пять единиц работы.
    expect(debt).toMatchObject({ capacity: 5, atStake: 5, deadlineDay: 3 + 240 });
    const push = 5 * 0.7;
    expect(check.stake).toContainEqual({ op: 'progress', frontId: debt.id, amount: Math.round(push * 100) / 100 });
    expect(check.capacity).toBeCloseTo(Math.max(r.seeding.capacity.MINOR, push));
    expect(() =>
      parseScenario({ id: 'y', title: 'y', fronts: [{ id: 'a', description: 'd', impact: 'MINOR', drift: 'SLOW', closes: [{ target: 'b', share: 1 }] }, { id: 'b', description: 'd', impact: 'MINOR' }] }),
    ).toThrow(/closes/);
  });

  test('масштаб истории: числа в файле — доли, удар бед и выигрыш тянутся к бюджету масштаба', () => {
    const story = (scale: string) =>
      parseScenario({
        id: scale,
        title: 'x',
        scale,
        objects: [{ id: 'mill', type: 'building', name: 'Мельница' }],
        fronts: [
          { id: 'a', description: 'Беда первая.', impact: 'MINOR', drift: 'STEADY', stake: { stats: { prosperity: -2 } } },
          { id: 'b', description: 'Беда вторая.', impact: 'MINOR', drift: 'STEADY', stake: { stats: { security: -1 } } },
          { id: 'c', description: 'Выигрыш.', impact: 'MINOR', stake: { stats: { knowledge: 5 } } },
        ],
      });
    for (const scale of ['situation', 'rupture'] as const) {
      const city = blankCity();
      const { fronts, objects } = plantScenario(r, city, story(scale), { day: 0, newId: ids(3) });
      const budget = r.seeding.scale[scale].budget;
      const [a, b, c] = fronts as [typeof fronts[number], typeof fronts[number], typeof fronts[number]];
      // Две беды делят бюджет как 2 к 1; ёмкость беды равна её удару, срок позволяет успеть.
      expect(a.failStake[0]).toMatchObject({ op: 'stats', points: { prosperity: (-budget * 2) / 3 } });
      expect(a.capacity + b.capacity).toBeCloseTo(Math.max(2, (budget * 2) / 3) + Math.max(2, budget / 3));
      expect(a.deadlineDay! / 30).toBeGreaterThanOrEqual((a.capacity / 4) * 1.5 - 0.05);
      // Выигрыш получает весь бюджет и стоит его долю.
      expect(c.stake[0]).toMatchObject({ op: 'stats', points: { knowledge: budget } });
      expect(c.capacity).toBeCloseTo(Math.max(2, budget * r.seeding.gainShare));
      expect(fronts.every((f) => f.scale === scale && !f.plus)).toBe(true);
      // Тяга: объекты перелома остаются узлом сюжета, объекты узкого случая — декорацией.
      expect(pullOf(objects[0]!, 5000)).toBe(r.seeding.scale[scale].pull);
    }
  });

  test('тяга ложится на то, что история породила, и слабеет со временем', () => {
    const city = blankCity();
    const pull = { level: 2, day: 100, days: 1000 };
    const { changes } = applyStake(r, city, [{ op: 'create', object: { type: 'building', name: 'Маяк', description: '', points: { prosperity: 0, security: 1, knowledge: 0, influence: 0 } } }], { day: 100, newId: ids(5), pull });
    const made = city.objects.find((o) => o.name === 'Маяк')!;
    expect(changes).toHaveLength(1);
    expect(pullOf(made, 100)).toBe(2);
    expect(pullOf(made, 600)).toBe(1);
    expect(pullOf(made, 2000)).toBe(0);
  });

  test('все заготовки сажаются: масштаб задан, возможность живёт окно, беда успевается', () => {
    const dir = path.resolve(import.meta.dirname, '../../scenarios');
    const kinds = { trouble: 0, chance: 0 };
    // Заготовки про сопряжение лежат отдельно и в одиночной игре не грузятся, но проверяются так же.
    const files = [
      ...fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')),
      ...fs.readdirSync(path.join(dir, 'conjunction')).filter((f) => f.endsWith('.yaml')).map((f) => `conjunction/${f}`),
    ];
    for (const file of files) {
      const scenario = parseScenario(yaml.load(fs.readFileSync(path.join(dir, file), 'utf8')));
      expect(scenario.scale, file).toBeDefined();
      const kind = storyKind(scenario);
      kinds[kind] += 1;
      const city = blankCity();
      const { fronts } = plantScenario(r, city, scenario, { day: 0, newId: ids(11) });
      const budget = r.seeding.scale[scenario.scale!].budget;
      let hit = 0;
      // У возможности с окном срок несут часы; они живут на объекте истории.
      const clock = fronts.find((f) => f.form === 'clock');
      expect(Boolean(clock), file).toBe(kind === 'chance' && Boolean(scenario.window));
      if (clock) {
        expect(clock.deadlineDay, file).toBeGreaterThanOrEqual(r.seeding.chanceMonths * 30);
        expect(city.objects.some((o) => o.id === clock.livesOn), file).toBe(true);
      }
      for (const [i, f] of fronts.filter((x) => x.form !== 'clock').entries()) {
        const drifting = scenario.fronts[i]!.drift !== 'NONE';
        expect(f.plus, file).toBe(kind === 'chance');
        if (kind === 'chance') expect(deadlineOf(city, f), file).toBe(clock?.deadlineDay ?? null);
        if (f.livesOn) expect(city.objects.some((o) => o.id === f.livesOn), file).toBe(true);
        if (!drifting) continue;
        expect(f.deadlineDay! / 30, file).toBeGreaterThanOrEqual((f.capacity / r.fronts.deadlines.unitsPerMonth) * r.fronts.deadlines.slack - 0.05);
        const op = f.failStake[0];
        if (op?.op === 'stats') hit += magnitude(op.points);
      }
      if (hit > 0) expect(hit, file).toBeCloseTo(budget, 0);
    }
    // Возможностей достаточно, чтобы режиссёр сажал их наравне с бедами.
    expect(kinds.chance).toBeGreaterThanOrEqual(40);
    expect(kinds.trouble).toBeGreaterThanOrEqual(90);
  });

  test('вклад с посадки есть только у того, что беда истории может отнять', () => {
    const scenario = parseScenario({
      id: 'y',
      title: 'y',
      objects: [
        { id: 'mill', type: 'building', name: 'Мельница', weight: 'MINOR', statProfile: { prosperity: 1 } },
        { id: 'well', type: 'landmark', name: 'Колодец', weight: 'MINOR', statProfile: { prosperity: 1 } },
      ],
      fronts: [{ id: 'f', description: 'Мельницу подмывает.', impact: 'MINOR', drift: 'SLOW', stake: { delete: { target: 'mill' } } }],
    });
    const { objects } = plantScenario(r, blankCity(), scenario, { day: 0, newId: ids(4) });
    expect(objects[0]!.statEffect.prosperity).toBeGreaterThan(0);
    expect(objects[1]!.statEffect.prosperity).toBe(0);
  });

  test('кривая заготовка падает с путём', () => {
    expect(() => parseScenario({ id: 'x', title: 'x', fronts: [{ id: 'f', description: 'd', impact: 'HUGE' }] })).toThrow(
      /fronts\.0\.impact/,
    );
  });
});
