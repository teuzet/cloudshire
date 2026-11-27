import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { frontLine } from '../../src/agents/_shared/format.js';
import type { City, Front } from '../../src/core/city.js';
import { leadOf } from '../../src/core/world/assignments.js';
import { deadlineOf, nextEventDay, progressAt } from '../../src/core/world/fronts.js';
import { changeCapacity } from '../../src/core/world/numbers.js';
import { createObject } from '../../src/core/world/objects.js';
import { parseScenario, plantScenario, type Scenario } from '../../src/core/world/scenario.js';
import { applyStake } from '../../src/core/world/stake.js';
import { newId, today } from '../../src/flows/context.js';
import { processDue } from '../../src/flows/day.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { fadeDormant } from '../../src/flows/seeding.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { lanternIsle, lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

const zero = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };

function template(name: string): Scenario {
  return parseScenario(yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, `../../scenarios/${name}.yaml`), 'utf8')));
}

type Stand = Awaited<ReturnType<typeof stand>> & { city: City; fronts: Front[] };

/** Город, в котором посажена одна история; жрец сам никого никуда не ставит. */
async function planted(scenario: Scenario): Promise<Stand> {
  const s = await stand();
  const city = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm);
  const { fronts } = plantScenario(s.r, city, scenario, { day: 0, newId: (p) => newId(s.deps, p) });
  refreshAllFronts(s.deps, city, 0);
  return { ...s, city, fronts };
}

async function now(s: Stand): Promise<number> {
  return today(s.deps, (await s.deps.storage.getWorld())!);
}

/** Дожить до дня `day` и разобрать всё, что наступило. */
async function at(s: Stand, day: number) {
  const world = (await s.deps.storage.getWorld())!;
  s.passDays(Math.max(0, day - today(s.deps, world)));
  return processDue(s.deps, world, s.city);
}

function named(city: City, name: string) {
  return city.objects.find((o) => o.name === name)!;
}

/** Хранитель берётся за поиск истории. */
async function study(s: Stand, front: Front) {
  s.llm.script('will-interpreter', toolReply('submit_will', { label: 'strategy', front_id: front.id, goal: 'Разобрать надписи на башне', manner: 'Расшифровать надписи на башне' }));
  const out = await playerWill(s.deps, s.city, 'keeper', 'Разобрать надписи на башне', await now(s));
  expect(out.ok).toBe(true);
}

describe('срок истории — отдельные часы', () => {
  test('время вышло: островок уходит со всем, что на нём стояло, поиск упущен, сановник свободен', async () => {
    const s = await planted(lanternIsle());
    const { city } = s;
    const find = s.fronts.find((f) => f.form === 'find')!;
    const clock = s.fronts.find((f) => f.form === 'clock')!;
    const end = clock.deadlineDay!;
    expect(deadlineOf(city, find)).toBe(end);

    // Хранитель берётся за башню в последние дни и не успевает.
    await at(s, end - 5);
    await study(s, find);
    expect(leadOf(city, find.id)).toBeTruthy();

    const news = await at(s, end);
    expect(clock.status).toBe('done');
    expect(find.status).toBe('cancelled');
    expect(named(city, 'Островок с горящими фонарями').status).toBe('deleted');
    expect(named(city, 'Башня на островке').status).toBe('deleted');
    expect(city.officers.find((o) => o.office === 'keeper')!.assignmentId).toBeNull();
    // Развязку пишет тот же агент, что у любой беды: ему сказано, что ушло насовсем.
    expect(lastUser(s.llm.callsTo('resolver').at(-1)!)).toContain('ушло из города насовсем: Островок с горящими фонарями');
    expect(news).toHaveLength(1);
    expect(city.chronicle.at(-1)).toMatchObject({ source: 'deadline', frontId: clock.id });
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Упущено: «Добраться до рецепта, который спрятан в башне». Не стало того, на чём это держалось: Островок с горящими фонарями');
    expect(city.fronts.filter((f) => f.status === 'active')).toHaveLength(0);
  });

  test('якорь держит срок: гонки больше нет; якорь сбили — срок идёт с того места, где встал', async () => {
    const s = await planted(lanternIsle());
    const { city } = s;
    const find = s.fronts.find((f) => f.form === 'find')!;
    const clock = s.fronts.find((f) => f.form === 'clock')!;
    const end = clock.deadlineDay!;
    const isle = named(city, 'Островок с горящими фонарями');

    // На сороковой день островок приковали цепями.
    await at(s, 40);
    const made = applyStake(
      s.r,
      city,
      [{ op: 'create', object: { type: 'object', name: 'Причальные цепи', description: 'Цепи держат островок у кромки.', points: zero, refs: [isle.id], holds: [{ frontId: clock.id, effect: 'stop' }] }, result: true }],
      { day: 40, newId: (p) => newId(s.deps, p) },
    );
    refreshAllFronts(s.deps, city, 40);
    expect(nextEventDay(clock)).toBeNull();
    expect(deadlineOf(city, find)).toBeNull();
    // Жрец видит и срок, и то, что его держит.
    expect(frontLine(city, clock, 40, s.r)).toContain('пока есть Причальные цепи: срок не идёт');
    expect(frontLine(city, find, 40, s.r)).toContain('держится на: Островок с горящими фонарями');

    // Прежний срок прошёл давно, а островок на месте, и поиск ждёт.
    expect(await at(s, end + 200)).toHaveLength(0);
    expect(isle.status).toBe('active');
    expect(find.status).toBe('active');
    // Пока срок удержан, нетронутый поиск ждёт как обычная история, а не как случай на время.
    fadeDormant(s.deps, city, end);
    expect(find.status).toBe('active');

    // Цепи сбили: островок уйдёт через столько, сколько оставалось.
    applyStake(s.r, city, [{ op: 'delete', target: made.resultId! }], { day: end + 200, newId: (p) => newId(s.deps, p) });
    refreshAllFronts(s.deps, city, end + 200);
    expect(clock.deadlineDay).toBe(end + 200 + (end - 40));
    expect(deadlineOf(city, find)).toBe(clock.deadlineDay);
    await at(s, clock.deadlineDay!);
    expect(isle.status).toBe('deleted');
    expect(find.status).toBe('cancelled');
  });

  test('взятый случай закрепляет сам себя: готовое держит срок, и земля остаётся', async () => {
    const s = await planted(template('joined-shard'));
    const { city } = s;
    const deed = s.fronts.find((f) => f.form === 'deed')!;
    const clock = s.fronts.find((f) => f.form === 'clock')!;
    const end = clock.deadlineDay!;
    s.llm.script('will-interpreter', toolReply('submit_will', { label: 'strategy', front_id: deed.id, goal: 'Связать осколок с островом', manner: 'Каменные замки и засыпка щели' }));
    expect((await playerWill(s.deps, city, 'marshal', 'Связать осколок с островом', 0)).ok).toBe(true);
    for (let i = 0; i < 20 && deed.status === 'active'; i++) await at(s, nextEventDay(deed)!);
    expect(deed.status).toBe('done');
    expect(await now(s)).toBeLessThan(end);

    const land = named(city, 'Новая земля');
    expect(land.holds).toMatchObject([{ frontId: clock.id, effect: 'stop' }]);
    expect(clock).toMatchObject({ status: 'active', deadlineDay: null });
    await at(s, end + 100);
    expect(named(city, 'Большой осколок у кромки').status).toBe('active');
    expect(land.status).toBe('active');
    // Землю держит то, что построено: не станет его, и осколок снова начнёт отходить.
    applyStake(s.r, city, [{ op: 'delete', target: land.id }], { day: end + 100, newId: (p) => newId(s.deps, p) });
    expect(clock.deadlineDay).not.toBeNull();
  });

  test('случай без срока ждёт, пока о нём помнят: нетронутый тихо уходит из дел, вещь остаётся', async () => {
    const s = await planted(template('clear-spring'));
    const { city } = s;
    expect(s.fronts.some((f) => f.form === 'clock')).toBe(false);
    const front = s.fronts[0]!;
    expect(front).toMatchObject({ plus: true, deadlineDay: null });
    expect(deadlineOf(city, front)).toBeNull();
    const wait = s.r.seeding.chanceMonths * 30;
    fadeDormant(s.deps, city, wait - 1);
    expect(front.status).toBe('active');
    fadeDormant(s.deps, city, wait);
    expect(front.status).toBe('cancelled');
    expect(city.objects.every((o) => o.status === 'active')).toBe(true);

    // Пока срок идёт, случай с окном из дел не уходит: решают часы.
    const isle = await planted(lanternIsle());
    fadeDormant(isle.deps, isle.city, wait);
    expect(isle.fronts.find((f) => f.form === 'find')!.status).toBe('active');
  });
});

describe('убрать причину беды', () => {
  test('стоит столько же, сколько снять саму беду: остаток её шкалы', async () => {
    const s = await planted(template('arsonist'));
    const { city } = s;
    const fire = s.fronts.find((f) => f.form === 'threat')!;
    const fires = named(city, 'Ночные пожары');
    expect(fire.livesOn).toBe(fires.id);
    city.objects.push(createObject(s.r, { id: 'shed', type: 'structure', name: 'Пустой сарай', description: 'Сарай у стены.', day: 0 }));

    const remove = (id: string, name: string) =>
      toolReply('submit_stages', { stages: [{ title: `Убрать: ${name}`, work: 'Идёт работа.', result: { kind: 'remove_object', object_id: id, name, description: 'Этого в городе больше нет.' }, site: null, outcome_known: true }] });
    s.llm.script('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Снести пустой сарай' })).script('stage-planner', remove('shed', 'Пустой сарай'));
    expect((await playerWill(s.deps, city, 'treasurer', 'Снести пустой сарай', 0)).ok).toBe(true);
    const plain = city.fronts.at(-1)!;
    expect(plain.capacity).toBe(changeCapacity(s.r, 'structure', zero));

    s.llm.script('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Покончить с ночными пожарами' })).script('stage-planner', remove(fires.id, 'Ночные пожары'));
    expect((await playerWill(s.deps, city, 'marshal', 'Покончить с ночными пожарами', 0)).ok).toBe(true);
    const cure = city.fronts.at(-1)!;
    expect(cure.stake).toEqual([{ op: 'delete', target: fires.id }]);
    expect(cure.capacity).toBeCloseTo(changeCapacity(s.r, 'threat', zero) + fire.capacity - progressAt(fire, 0));

    // Дело доведено: пожаров нет, и беда, которая на них жила, отпала сама.
    for (let i = 0; i < 20 && cure.status === 'active'; i++) await at(s, nextEventDay(cure)!);
    expect(cure.status).toBe('done');
    expect(fires.status).toBe('deleted');
    expect(fire).toMatchObject({ status: 'cancelled' });
    // Летописец получает это одной переменой развязки, словами мира.
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Отпало само: «Пожары всё ближе к центру». Не стало того, на чём это держалось: Ночные пожары');
    expect(city.chronicle.some((e) => e.source === 'deadline' && e.frontId === fire.id)).toBe(false);
  });
});
