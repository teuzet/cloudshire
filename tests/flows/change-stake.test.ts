/**
 * Сменить ставку беды: перенести вещь из-под удара, смягчить удар вещью-якорем,
 * изменить то, по чему бьют, так, что удар его не задевает. Цена — сколько это спасает.
 */

import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City, Front, StakeOp } from '../../src/core/city.js';
import { emptyStatMap } from '../../src/core/rules.js';
import { createFront, deadlineOf, frontGist, nextEventDay } from '../../src/core/world/fronts.js';
import { basePrice, changeCapacity, magnitude, patchCapacity, rawToPoints } from '../../src/core/world/numbers.js';
import { createObject } from '../../src/core/world/objects.js';
import { plantScenario } from '../../src/core/world/scenario.js';
import { moveSaving, softenStake, stakeToll } from '../../src/core/world/patch.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { newId, today } from '../../src/flows/context.js';
import { processDue } from '../../src/flows/day.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { lanternIsle, lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

type Stand = Awaited<ReturnType<typeof stand>> & { city: City };

async function town(build: (s: Awaited<ReturnType<typeof stand>>, city: City) => void): Promise<Stand> {
  const s = await stand();
  const city = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm, { 'Кузни на торфе': [{ stat: 'prosperity', direction: 'up', size: 'medium' }] });
  build(s, city);
  recomputeStats(city, s.r);
  refreshAllFronts(s.deps, city, 0);
  return { ...s, city };
}

async function at(s: Stand, day: number) {
  const world = (await s.deps.storage.getWorld())!;
  s.passDays(Math.max(0, day - today(s.deps, world)));
  return processDue(s.deps, world, s.city);
}

async function finish(s: Stand, front: Front) {
  for (let i = 0; i < 30 && front.status === 'active'; i++) await at(s, nextEventDay(front)!);
}

const stages = (result: Record<string, unknown>, title = 'Работа') =>
  toolReply('submit_stages', { stages: [{ title, work: `${title}: идёт работа.`, result, site: { name: `Работы: ${title}`, description: '' }, outcome_known: true }] });
const influence = (effects: Array<Record<string, unknown>>) => toolReply('submit_influence', { effects, sides: [], reason: 'По сценарию теста.' });
const threat = (id: string, description: string, failStake: StakeOp[], deadlineDay = 120) =>
  createFront({ id, form: 'threat', origin: 'story', title: description, description, capacity: 6, deadlineDay, failStake, day: 0 });

describe('перенести вещь из-под удара', () => {
  const build = (s: Awaited<ReturnType<typeof stand>>, city: City) => {
    city.objects.push(
      createObject(s.r, { id: 'library', type: 'building', name: 'Старая библиотека', description: 'Деревянная библиотека у рынка.', statEffect: { knowledge: 3 }, day: 0 }),
      createObject(s.r, { id: 'books', type: 'resource', name: 'Свитки основателей', description: 'Сотни свитков о первых годах города.', statEffect: { knowledge: 6 }, parentId: 'library', day: 0 }),
      createObject(s.r, { id: 'hall', type: 'building', name: 'Ратуша', description: 'Каменная ратуша на площади.', statEffect: { influence: 4 }, day: 0 }),
    );
    city.fronts.push(threat('fire', 'Пожар идёт от рынка и вот-вот перекинется на библиотеку.', [{ op: 'delete', target: 'library' }], 60));
  };

  test('книги из библиотеки в ратушу: цена — половина цены вида и спасённое; пожар забирает библиотеку без книг', async () => {
    const s = await town(build);
    const { city } = s;
    const books = city.objects.find((o) => o.id === 'books')!;
    const value = magnitude(rawToPoints(city, books.statEffect));
    expect(moveSaving(city, 'books', 'hall', 0)).toEqual({ saved: value, fronts: ['fire'] });
    // Перенос внутри того же удара ничего не спасает.
    expect(moveSaving(city, 'books', 'library', 0).saved).toBe(0);

    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: 'fire', goal: 'Вынести свитки в ратушу' }))
      .script('stage-planner', stages({ kind: 'move_object', object_id: 'books', name: 'Свитки основателей', description: 'Свитки лежат в подвале ратуши.', parent_id: 'hall' }, 'Вынести свитки'));
    const out = await playerWill(s.deps, city, 'keeper', 'Вынесите свитки из библиотеки в ратушу, пока не дошёл пожар', 0);
    expect(out.ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.stake).toEqual([{ op: 'move', target: 'books', parentId: 'hall' }]);
    expect(deed.capacity).toBeCloseTo(basePrice(s.r, 'resource') / 2 + value * s.r.fronts.hold.price.stop);
    // О пожаре оценщика влияния не спрашивают: что перенос уводит из-под удара, уже в цене.
    expect(s.llm.callsTo('influence-appraiser')).toHaveLength(0);

    await finish(s, deed);
    expect(books.parentId).toBe('hall');
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Перенесено: Свитки основателей. Больше не находится здесь: Старая библиотека. Теперь находится здесь: Ратуша');
    await at(s, 61);
    // Здание беда не стирает, а выводит из строя; свитков с ним больше нет, и они служат по-прежнему.
    expect(city.objects.find((o) => o.id === 'library')?.out).toBeTruthy();
    expect(books.status).toBe('active');
    expect(books.out ?? null).toBeNull();
  });

  test('нельзя перенести внутрь самого себя', async () => {
    const s = await town(build);
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Перенести библиотеку в свитки' }))
      .script('stage-planner', stages({ kind: 'move_object', object_id: 'library', name: 'Старая библиотека', description: 'Библиотека внутри свитков.', parent_id: 'books' }));
    const out = await playerWill(s.deps, s.city, 'keeper', 'Перенесите библиотеку в свитки', 0);
    expect(out).toMatchObject({ ok: false });
    expect(out.say).toContain('нельзя перенести внутрь самого себя');
  });
});

describe('смягчить удар', () => {
  test('песчаные валы у амбаров: вода придёт, но амбары уцелеют наполовину; цена — спасённое со скидкой', async () => {
    const s = await town((s, city) => {
      city.objects.push(createObject(s.r, { id: 'barns', type: 'building', name: 'Нижние амбары', description: 'Три амбара с зерном у канала.', statEffect: { prosperity: 6 }, day: 0 }));
      city.fronts.push(threat('flood', 'Вода в канале поднимается и зальёт нижние амбары.', [{ op: 'delete', target: 'barns' }], 60));
    });
    const { city } = s;
    const flood = city.fronts.find((f) => f.id === 'flood')!;
    const barns = city.objects.find((o) => o.id === 'barns')!;
    const value = magnitude(rawToPoints(city, barns.statEffect));
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: 'flood', goal: 'Обложить амбары мешками с песком' }))
      .script('stage-planner', stages({ kind: 'new_object', type: 'object', name: 'Песчаные валы', description: 'Валы из мешков с песком вокруг амбаров.' }, 'Песчаные валы'))
      .script('influence-appraiser', influence([{ id: 'flood', effect: 'changes_outcome' }]));
    const out = await playerWill(s.deps, city, 'marshal', 'Обложите амбары мешками с песком', 0);
    expect(out.ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    const softened = softenStake(s.r, city, flood.failStake, []);
    expect(softened).toEqual([{ op: 'revalue', target: 'barns', points: { ...emptyStatMap(), prosperity: value / 2 } }]);
    const saved = stakeToll(city, flood.failStake, 'flood', 0) - stakeToll(city, softened, 'flood', 0);
    expect(saved).toBeCloseTo(value / 2);
    const price = Math.max(s.r.fronts.hold.priceMin, Math.round(saved * s.r.fronts.hold.price.outcome * 100) / 100);
    expect(deed.links).toEqual([{ frontId: 'flood', effect: 'outcome', price }]);
    expect(deed.capacity).toBeCloseTo(patchCapacity(0, basePrice(s.r, 'object'), price));
    expect(out.say).toContain('Когда будет готово: пока есть Песчаные валы, слабее ударит: «Вода в канале поднимается и зальёт нижние амбары»');

    await finish(s, deed);
    expect(flood.failStake).toEqual(softened);
    expect(priestTurnBlock(s.r, city, 30)).toContain('пока есть Песчаные валы: ударит слабее');
    await at(s, 61);
    expect(barns.status).toBe('active');
    expect(magnitude(rawToPoints(city, barns.statEffect))).toBeCloseTo(value / 2, 0);
  });

  test('кузни на торфе: изменённое уходит из-под удара целиком, остальное бьёт вполовину', async () => {
    const s = await town((s, city) => {
      city.objects.push(createObject(s.r, { id: 'forges', type: 'organization', name: 'Кузни', description: 'Кузни на угле.', statEffect: { prosperity: 5 }, day: 0 }));
      city.fronts.push(threat('coal', 'Уголь на исходе: кузни встанут, зимой нечем топить.', [{ op: 'revalue', target: 'forges', points: emptyStatMap() }, { op: 'stats', points: { prosperity: -2 } }]));
    });
    const { city } = s;
    const coal = city.fronts.find((f) => f.id === 'coal')!;
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: 'coal', goal: 'Перевести кузни с угля на торф' }))
      .script('stage-planner', stages({ kind: 'change_object', object_id: 'forges', name: 'Кузни на торфе', description: 'Кузни топят торфом с болот.' }, 'Перевести кузни'))
      .script('influence-appraiser', influence([{ id: 'coal', effect: 'changes_outcome' }]));
    expect((await playerWill(s.deps, city, 'treasurer', 'Переведите кузни с угля на торф', 0)).ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    const softened = softenStake(s.r, city, coal.failStake, ['forges']);
    expect(softened).toEqual([{ op: 'stats', points: { ...emptyStatMap(), prosperity: -1 } }]);
    const saved = stakeToll(city, coal.failStake, 'coal', 0) - stakeToll(city, softened, 'coal', 0);
    const link = deed.links?.[0];
    expect(link).toMatchObject({ frontId: 'coal', effect: 'outcome' });
    expect(link?.price).toBeCloseTo(saved * s.r.fronts.hold.price.outcome);
    // Изменение кузен само стоит перемену и половину цены вида; за спасённое платит большее из двух.
    const own = deed.capacity - Math.max(basePrice(s.r, 'organization') / 2, link!.price);
    expect(own).toBeGreaterThan(0);
    expect(changeCapacity(s.r, 'organization', emptyStatMap())).toBe(basePrice(s.r, 'organization') / 2);
    // Якорь — сами кузни: ставка дела ставит им «держит» на беду.
    expect(deed.stake.at(-1)).toMatchObject({ op: 'hold', target: 'forges', frontId: 'coal', effect: 'outcome', failStake: softened });
  });
});

describe('изменённое отпускает то, что держало', () => {
  /** Островок с фонарями держат у причала цепи: пока они целы, островок не уйдёт. */
  async function chained() {
    const s = await stand();
    const city = blankCity();
    city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
    scriptFrontAgents(s.llm);
    const { fronts } = plantScenario(s.r, city, lanternIsle(), { day: 0, newId: (p) => newId(s.deps, p) });
    const drift = fronts.find((f) => f.form === 'clock')!;
    const isle = city.objects.find((o) => o.name === 'Островок с горящими фонарями')!;
    const chains = createObject(s.r, { id: 'chains', type: 'object', name: 'Причальные цепи', description: 'Цепи держат островок у причала.', parentId: isle.id, day: 0 });
    chains.holds = [{ frontId: drift.id, effect: 'stop', day: 0 }];
    city.objects.push(chains);
    recomputeStats(city, s.r);
    refreshAllFronts(s.deps, city, 0);
    return { ...s, city, drift, chains };
  }
  const change = (s: Awaited<ReturnType<typeof chained>>, description: string, effects: Array<Record<string, unknown>>) =>
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: null, goal: 'Переделать причальные цепи' }))
      .script('stage-planner', stages({ kind: 'change_object', object_id: 'chains', name: 'Причальные цепи', description }, 'Цепи'))
      .script('influence-appraiser', influence(effects));

  test('цепи перерублены: оценщик видит, что они держат сейчас, и не называет этого — цепи отпускают островок', async () => {
    const s = await chained();
    const { city, drift, chains } = s;
    expect(deadlineOf(city, drift)).toBeNull();
    change(s, 'Цепи перерублены и больше не держат островок.', []);
    const out = await playerWill(s.deps, city, 'marshal', 'Перерубите цепи островка', 0);
    expect(out.ok).toBe(true);
    const asked = lastUser(s.llm.callsTo('influence-appraiser').at(-1)!);
    expect(asked).toContain(`Сейчас так: Пока есть Причальные цепи, не случится: «${frontGist(drift)}»`);
    const deed = city.fronts.at(-1)!;
    expect(deed.stake).toContainEqual({ op: 'release', target: 'chains', frontId: drift.id, effect: 'stop' });
    expect(deed.links ?? []).toEqual([]);
    expect(out.say).toContain(`Когда будет готово, снова надвигается «${frontGist(drift)}»`);

    await finish(s, deed);
    expect(chains.status).toBe('active');
    expect(chains.holds ?? []).toEqual([]);
    expect(deadlineOf(city, drift)).not.toBeNull();
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Опоры больше нет: Причальные цепи. Снова надвигается');
  });

  test('цепи заменили на новые: держат то же — влияние ничего не стоит и якорь остаётся', async () => {
    const s = await chained();
    const { city, drift, chains } = s;
    change(s, 'Звенья цепей заменены новыми, кованными в городе.', [{ id: drift.id, effect: 'stops' }]);
    expect((await playerWill(s.deps, city, 'marshal', 'Замените звенья причальных цепей новыми', 0)).ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.links).toEqual([{ frontId: drift.id, effect: 'stop', price: 0 }]);
    expect(deed.stake.some((op) => op.op === 'release')).toBe(false);
    await finish(s, deed);
    expect(chains.holds).toMatchObject([{ frontId: drift.id, effect: 'stop' }]);
    expect(deadlineOf(city, drift)).toBeNull();
  });

  test('оценщик не ответил: изменённое держит то же, что держало', async () => {
    const s = await chained();
    const { city, drift } = s;
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: null, goal: 'Переделать причальные цепи' }))
      .script('stage-planner', stages({ kind: 'change_object', object_id: 'chains', name: 'Причальные цепи', description: 'Цепи смазаны.' }, 'Цепи'))
      .always('influence-appraiser', () => toolReply('submit_influence', { effects: [{ id: 'nope', effect: 'stops' }], sides: [], reason: '' }));
    expect((await playerWill(s.deps, city, 'marshal', 'Смажьте цепи', 0)).ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.stake.some((op) => op.op === 'release')).toBe(false);
    expect(deed.links).toEqual([{ frontId: drift.id, effect: 'stop', price: 0 }]);
  });
});
