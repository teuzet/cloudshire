/**
 * Снимки для кейсов «дерзких приказов» (bench/cases/will/dare-*.yaml): город собирается кодом,
 * без моделей, и пишется в bench/states/. Бесплатно.
 *
 *   npx tsx bench/make-states.ts
 *
 * dare-isle — к краю прибило островок с башней (заготовка lantern-isle), в башне засели
 * бунтовщики, рядом идут обычные беды города: уголь на исходе, пожар у библиотеки, туман у хуторов,
 * старатели на плато, стройка стены. dare-isle-chained — то же, но островок уже прикован цепями,
 * а бунтовщики грозят их сбить. Скрытый смотритель фонарей — участник набегов: его можно узнать.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ManualClock } from '../src/adapters/clock/manual.js';
import { seededRandom } from '../src/adapters/random/seeded.js';
import { MemoryStorage } from '../src/adapters/storage/memory.js';
import { OWNER, type Snapshot } from '../src/clients/bench/stages.js';
import { loadScenarios, readYaml } from '../src/clients/app.js';
import type { City, StakeOp, WorldObject } from '../src/core/city.js';
import { parseRules } from '../src/core/rules.js';
import { createAssignment } from '../src/core/world/assignments.js';
import { createFront } from '../src/core/world/fronts.js';
import { holdFront } from '../src/core/world/links.js';
import { createObject } from '../src/core/world/objects.js';
import { plantScenario } from '../src/core/world/scenario.js';
import { recomputeStats } from '../src/core/world/stats.js';
import { newId, type FlowDeps } from '../src/flows/context.js';
import { refreshAllFronts } from '../src/flows/fronts.js';
import { ensureWorld, type NamesFile } from '../src/flows/world.js';
import { blankCity } from '../tests/helpers/fixtures.js';

const NOW = Date.UTC(2026, 10, 1);
const ROOT = path.resolve(import.meta.dirname, '..');

async function build(chained: boolean): Promise<Snapshot> {
  const deps: FlowDeps = {
    rules: parseRules(readYaml('config/game.yaml')),
    agents: { llm: { complete: () => Promise.reject(new Error('снимок собирается без моделей')) }, settings: () => ({ model: 'fake:none', maxOutputTokens: 1, effort: 'none' }) },
    scenarios: [],
    storage: new MemoryStorage(),
    clock: new ManualClock(NOW),
    random: seededRandom(7),
    notifier: { async send() {} },
  };
  const world = await ensureWorld(deps, { names: readYaml('config/names.yaml') as NamesFile });
  const city: City = blankCity({
    id: 'city_dare',
    worldId: world.id,
    ownerId: OWNER,
    name: 'Туманск',
    brief: 'Туманск — летающий город рыбаков и кузнецов у кромки неба. Каменные причалы, кузни на угле, библиотека у храма, хутора за туманной падью, рудник и плато на севере.',
  });
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: 'Только сообщать и ждать моего слова.' };
  const id = (p: string) => newId(deps, p);
  const add = (type: WorldObject['type'], name: string, description: string, statEffect: Record<string, number> = {}, parentId: string | null = null, hidden = false) => {
    const obj = createObject(deps.rules, { id: id('obj'), type, name, description, statEffect, parentId, hidden, day: 0 });
    city.objects.push(obj);
    return obj;
  };

  const docks = add('structure', 'Причалы у кромки', 'Каменные причалы на краю острова: сюда пристают небесные лодки и прибивает то, что несёт ветер.', { prosperity: 5 });
  add('building', 'Храм покровителя', 'Белый храм на холме, где верховный жрец слушает волю покровителя.', { influence: 5 });
  add('organization', 'Городская стража', 'Две сотни стражников: караулы у ворот, обходы рынка.', { security: 12 });
  add('community', 'Рыбачья слобода', 'Семьи небесных рыбаков у кромки: сети, лодки, коптильни.', { prosperity: 5 });
  const forges = add('organization', 'Кузнечный ряд', 'Кузни и литейные мастерские на угле: куют цепи, якоря, инструмент.', { prosperity: 6, security: 2 });
  add('district', 'Торговый квартал', 'Лавки, склады и амбары у главной площади.', { prosperity: 12 });
  const library = add('building', 'Городская библиотека', 'Каменная библиотека у храма, на краю Нижнего квартала.', { knowledge: 5 });
  const books = add('resource', 'Книги библиотеки', 'Три тысячи томов: летописи города, травники, звёздные таблицы.', { knowledge: 6 }, library.id);
  add('building', 'Ратуша', 'Каменная ратуша на площади, с сухими подвалами.', { influence: 4 });
  const farms = add('settlement', 'Хутора за туманной падью', 'Два десятка хуторов на южном склоне: зерно, овцы, сыр.', { prosperity: 4 });
  const cliffs = add('site', 'Северные скалы', 'Голые скалы за рудником, куда люди ходят редко.');
  add('community', 'Исполины северных скал', 'Стадо каменных исполинов: огромные, медленные, пугливые травоядные.', {}, cliffs.id);
  const plateau = add('site', 'Рудное плато', 'Плоская вершина за рудником, где жилы выходят наружу.');
  const prospectors = add('community', 'Чужие старатели', 'Три десятка старателей с соседнего острова: ставят шатры и бьют шурфы на плато.', {}, plateau.id);
  const wall = add('site', 'Кладка стены у кромки', 'Начатая стена вдоль восточной кромки: пока по колено.');

  // Островок с башней: заготовка, как её сажает посев.
  const isle = loadScenarios().find((s) => s.id === 'lantern-isle')!;
  plantScenario(deps.rules, city, isle, { day: 0, newId: id });
  const tower = city.objects.find((o) => o.name === 'Башня на островке')!;
  const island = city.objects.find((o) => o.name === 'Островок с горящими фонарями')!;
  add('object', 'Ловушки башни', 'Самострелы и ямы у входа в башню: кто их ставил и как они устроены, никто в городе не знает.', {}, tower.id);
  const rebels = add('community', 'Бунтовщики в башне', 'Два десятка беглых кузнецов засели в башне, грабят причалы и зовут к себе бедноту.', {}, tower.id);
  const keeper = add('person', 'Старый смотритель фонарей', 'Старик, который когда-то зажигал фонари островка; это он подбивает беглых держаться башни.', {}, tower.id, true);

  const hit = (points: Record<string, number>): StakeOp[] => [{ op: 'stats', points: { prosperity: 0, security: 0, knowledge: 0, influence: 0, ...points } }];
  city.fronts.push(
    createFront({ id: id('front'), form: 'threat', origin: 'story', title: 'Набеги из башни', description: 'Бунтовщики из башни грабят причалы по ночам и скоро пойдут на склады города.', capacity: 6, deadlineDay: 75, refs: [rebels.id, docks.id, keeper.id], livesOn: rebels.id, failStake: hit({ prosperity: -4, security: -2 }), day: 0 }),
    createFront({ id: id('front'), form: 'threat', origin: 'story', title: 'Уголь на исходе', description: 'Угольные копи иссякают: к зиме кузням нечем будет топить.', capacity: 7, deadlineDay: 120, refs: [forges.id], failStake: [{ op: 'delete', target: forges.id }], day: 0 }),
    createFront({ id: id('front'), form: 'threat', origin: 'story', title: 'Пожар в Нижнем квартале', description: 'Пожар в Нижнем квартале никак не потушат, огонь идёт к библиотеке.', capacity: 5, deadlineDay: 40, refs: [library.id], failStake: [{ op: 'delete', target: library.id }], day: 0 }),
    createFront({ id: id('front'), form: 'threat', origin: 'story', title: 'Туман у хуторов', description: 'Густой туман лёг в падь и отрезал хутора от города: ни обозов, ни вестей.', capacity: 6, deadlineDay: 90, refs: [farms.id], failStake: hit({ prosperity: -4 }), day: 0 }),
    createFront({ id: id('front'), form: 'tension', origin: 'story', title: 'Старатели на плато', description: 'Чужие старатели бьют шурфы на рудном плато и не уходят: рудокопы города грозят прогнать их силой.', capacity: 4, deadlineDay: 80, refs: [prospectors.id, plateau.id], livesOn: prospectors.id, failStake: hit({ security: -3 }), day: 0 }),
  );
  const build = createFront({ id: id('front'), form: 'deed', origin: 'player', title: 'Стройка стены у кромки', description: 'Каменщики кладут стену вдоль восточной кромки: камень везут с северных скал.', capacity: 20, siteId: wall.id, stake: [{ op: 'create', object: { type: 'structure', name: 'Стена у кромки', description: 'Каменная стена вдоль восточной кромки.', points: { prosperity: 0, security: 6, knowledge: 0, influence: 0 } }, result: true }], day: 0 });
  city.fronts.push(build);
  createAssignment(city, { id: id('asg'), front: build, officer: city.officers.find((o) => o.office === 'treasurer')!, text: 'Класть стену из камня северных скал', day: 0 });

  if (chained) {
    const clock = city.fronts.find((f) => f.form === 'clock')!;
    const chains = add('object', 'Причальные цепи', 'Толстые цепи из Кузнечного ряда держат островок у причалов.', {}, null);
    holdFront(deps.rules, city, chains, { frontId: clock.id, effect: 'stop' }, 0);
    city.fronts.push(createFront({ id: id('front'), form: 'tension', origin: 'story', title: 'Бунтовщики хотят уйти', description: 'Бунтовщики в башне грозят ночью сбить цепи и уйти вместе с островком.', capacity: 4, deadlineDay: 60, refs: [rebels.id, chains.id], failStake: [{ op: 'delete', target: chains.id }], day: 0 }));
  }
  void island;
  void books;
  recomputeStats(city, deps.rules);
  refreshAllFronts(deps, city, 0);
  return { version: 1, now: NOW, world, cities: [city], drafts: [], origin: { run: null, stage: null, case: null, note: chained ? 'дерзкие приказы: островок прикован, бунтовщики грозят сбить цепи' : 'дерзкие приказы: островок у причалов, бунтовщики в башне, беды города' } };
}

async function main(): Promise<void> {
  for (const [name, chained] of [['dare-isle', false], ['dare-isle-chained', true]] as const) {
    const file = path.join(ROOT, 'bench/states', `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(await build(chained), null, 2)}\n`);
    console.log(`снимок: ${path.relative(ROOT, file)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
