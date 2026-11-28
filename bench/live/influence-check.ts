/**
 * Живая сверка оценщиков на размеченных случаях: оценщик влияния, оценщик вклада (что посчитано
 * отдельно), толкователь воли и сверщик условия.
 * Ходит в настоящие модели: запускать только по просьбе Ника.
 *
 *   npx tsx bench/live/influence-check.ts [influence|crowd|contribution|will|condition] [--repeat N]
 *
 * Случаи намеренно не повторяют примеры из промптов: проверяется правило, а не память о примере.
 * В конце печатает расход по токенам и цену.
 */

import { parseAgentSettings } from '../../src/agents/_shared/settings.js';
import type { AgentDeps } from '../../src/agents/_shared/runtime.js';
import { judgeCondition, type ConditionInput } from '../../src/agents/condition-judge/run.js';
import { appraiseContribution, type ContributionInput } from '../../src/agents/contribution-appraiser/run.js';
import { appraiseInfluence, type InfluenceInput } from '../../src/agents/influence-appraiser/run.js';
import { interpretWill, type WillInput } from '../../src/agents/will-interpreter/run.js';
import { buildLlm, loadDotEnv, readYaml } from '../../src/clients/app.js';
import { parseRules, type ObjectType } from '../../src/core/rules.js';
import { gradePoints, magnitude } from '../../src/core/world/numbers.js';
import { qualitativeStats } from '../../src/core/world/stats.js';
import type { Llm, LlmUsage } from '../../src/ports/llm.js';

// Цена gpt-luna за миллион токенов: вход, кэш, выход; запись в кэш ×1,25.
const PRICE = { input: 0.2, cached: 0.02, output: 1.2, write: 0.25 };

const total: Required<LlmUsage> = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function metered(inner: Llm): Llm {
  return {
    async complete(request) {
      const response = await inner.complete(request);
      for (const k of Object.keys(total) as Array<keyof LlmUsage>) total[k] += response.usage[k] ?? 0;
      return response;
    },
  };
}

function cost(u: Required<LlmUsage>): number {
  const plain = Math.max(0, u.inputTokens - u.cachedInputTokens - u.cacheWriteTokens);
  return (plain * PRICE.input + u.cachedInputTokens * PRICE.cached + u.cacheWriteTokens * PRICE.write + u.outputTokens * PRICE.output) / 1e6;
}

interface InfluenceCase {
  name: string;
  input: InfluenceInput;
  /** Что считаем верным: для каждого id допустимые слова; '-' значит «не названо». */
  expect: Record<string, string[]>;
  basis?: Record<string, 'solid' | 'word'>;
  sides?: Record<string, 'harms' | 'helps'>;
}

// Что ведут люди: дела, поиски, случаи, которые берут работой. Остальное надвигается само.
const PEOPLE = ['дело', 'поиск', 'удобный случай'];
const near = (id: string, kind: string, description: string, opts: { carrier?: string; helps?: string[] } = {}) => ({ id, kind, people: PEOPLE.includes(kind), description, carrier: opts.carrier ?? null, helps: opts.helps ?? [] });
const side = (id: string, name: string, type: 'community' | 'organization' | 'person' | 'threat' = 'community', description = '') => ({ id, type, name, description });

const INFLUENCE: InfluenceCase[] = [
  {
    name: 'каменные быки под скалой',
    input: {
      work: 'Подпереть нависшую скалу каменными быками',
      result: 'Каменные быки под Сизой скалой (большое сооружение): шесть опор из тёсаного камня держат скалу над Гончарным кварталом.',
      nearby: [near('f1', 'отложенная перемена', 'Сизая скала сползает и скоро ляжет на дома Гончарного квартала.', { carrier: 'Сизая скала' }), near('f2', 'дело', 'Гончары строят новую печь на краю квартала.')],
      sides: [side('o1', 'Гончары')],
    },
    expect: { f1: ['stop'], f2: ['-', 'safer'] },
    basis: { f1: 'solid' },
  },
  {
    name: 'охрана обозов с рудой',
    input: {
      work: 'Нанять наёмников сопровождать обозы с рудой',
      result: 'Обозная охрана (учреждение): сорок наёмных копейщиков ходят с каждым обозом от рудника до города.',
      nearby: [
        near('f1', 'угроза со сроком', 'Шайка Косого перехватывает обозы с рудой, плавильни скоро встанут.', { carrier: 'Шайка Косого', helps: ['охранять обозы в пути', 'выследить и разбить шайку в логове'] }),
        near('f2', 'растущее напряжение', 'Рудокопы ропщут на малую плату и грозят бросить забои.'),
      ],
      sides: [side('o1', 'Шайка Косого'), side('o2', 'Рудокопы')],
    },
    expect: { f1: ['stop', 'slow'], f2: ['-'] },
    basis: { f1: 'solid' },
    sides: { o1: 'harms' },
  },
  {
    name: 'долги выкуплены и прощены',
    input: {
      work: 'Выкупить долги предместья у ростовщика и простить их',
      result: 'Долговые расписки предместья (ресурс или запас): расписки выкуплены казной и сожжены на площади, долгов за предместьем больше нет.',
      nearby: [near('f1', 'угроза со сроком', 'Ростовщик Гур отбирает дома должников в предместье, семьи остаются на улице.', { helps: ['погасить долги', 'запретить отбирать жильё за долг'] })],
      sides: [side('o1', 'Ростовщик Гур', 'person'), side('o2', 'Жители предместья')],
    },
    expect: { f1: ['removes'] },
    sides: { o2: 'helps' },
  },
  {
    name: 'клятва цехов о ценах',
    input: {
      work: 'Взять с хлебных цехов клятву не поднимать цены до жатвы',
      result: 'Клятва хлебных цехов (закон или указ): старшины цехов поклялись перед храмом держать цену хлеба до жатвы.',
      nearby: [near('f1', 'растущее напряжение', 'Хлеб дорожает каждую неделю, предместья ропщут и готовы громить лавки.')],
      sides: [side('o1', 'Хлебные цеха', 'organization'), side('o2', 'Жители предместий')],
    },
    expect: { f1: ['stop', 'slow'] },
    basis: { f1: 'word' },
  },
  {
    name: 'подъёмник у каменоломни',
    input: {
      work: 'Поставить подъёмник у каменоломни',
      result: 'Подъёмник каменоломни (большое сооружение): ворот с противовесом поднимает глыбы из карьера прямо на дорогу к городу.',
      nearby: [near('f1', 'дело', 'Собор на площади: каменщики тянут стены, камень из карьера носят на руках.'), near('f2', 'угроза со сроком', 'Саранча идёт на поля с южной кромки.')],
      sides: [side('o1', 'Артель каменщиков')],
    },
    expect: { f1: ['hurry'], f2: ['-'] },
  },
  {
    name: 'мостки в штольне',
    input: {
      work: 'Проложить в старой штольне мостки и подпорки',
      result: 'Мостки и крепи в старой штольне (вещь): дощатые мостки над провалами и свежие подпорки в осыпающихся ходах.',
      nearby: [near('f1', 'поиск', 'Рудокопы ищут в старой штольне потерянную жилу; ходы осыпаются, люди срываются в провалы.', { carrier: 'Старая штольня' })],
      sides: [side('o1', 'Рудокопы')],
    },
    expect: { f1: ['safer'] },
    sides: { o1: 'helps' },
  },
  {
    name: 'зверинец на крыше школы',
    input: {
      work: 'Устроить на крыше школы зверинец грозовых птиц',
      result: 'Зверинец грозовых птиц (здание): клетки с грозовыми птицами на крыше школы, птицы бьют искрами, когда их тревожат.',
      nearby: [near('f1', 'дело', 'Ученики школы строят на той же крыше обсерваторию и носят туда медные трубы.')],
      sides: [side('o1', 'Ученики школы')],
    },
    expect: { f1: ['riskier', 'slow'] },
  },
  {
    name: 'зерно унесено наверх',
    input: {
      work: 'Перенести зерно из нижних амбаров в верхние',
      result: 'Нижние амбары (здание): амбары стоят пустые, всё зерно поднято в верхний город.',
      nearby: [near('f1', 'угроза со сроком', 'Вода в канале поднимается и зальёт нижние амбары вместе с зерном.')],
      sides: [],
    },
    expect: { f1: ['outcome'] },
  },
  {
    name: 'статуя на площади',
    input: {
      work: 'Поставить на площади статую покровителя',
      result: 'Статуя покровителя (достопримечательность): бронзовая статуя в три роста на главной площади.',
      nearby: [near('f1', 'угроза со сроком', 'Крысы портят зерно в амбарах, к зиме хлеба не хватит.', { helps: ['вывести крыс', 'убрать зерно в каменные лари'] }), near('f2', 'дело', 'Казначей прокладывает водовод в верхний квартал.')],
      sides: [side('o1', 'Амбарные сторожа')],
    },
    expect: { f1: ['-'], f2: ['-'] },
  },
  {
    name: 'кошачий двор',
    input: {
      work: 'Завести при амбарах кошачий двор',
      result: 'Кошачий двор при амбарах (ресурс или запас): сотня кошек-крысоловов живёт при амбарах и кормится охотой.',
      nearby: [near('f1', 'угроза со сроком', 'Крысы портят зерно в амбарах, к зиме хлеба не хватит.', { helps: ['вывести крыс', 'убрать зерно в каменные лари'] })],
      sides: [],
    },
    expect: { f1: ['stop', 'slow', 'removes'] },
    basis: { f1: 'solid' },
  },
  {
    name: 'поджигатель назван',
    input: {
      work: 'Выяснить, кто поджигает склады',
      result: 'Имя поджигателя (тайна): склады поджигал подмастерье красильщика Тавр, это подтвердили двое свидетелей.',
      nearby: [near('f1', 'угроза со сроком', 'Кто-то поджигает склады у причалов, огонь подбирается к хлебным рядам.', { helps: ['найти и взять поджигателя', 'ночные обходы с баграми'] })],
      sides: [],
    },
    expect: { f1: ['-', 'slow', 'outcome'] },
  },
  {
    name: 'рынок на спорном лугу',
    input: {
      work: 'Открыть общий рынок на спорном лугу',
      result: 'Луговой рынок (место): на лугу между слободами стоят общие ряды, торгуют обе слободы, места делят жребием.',
      nearby: [near('f1', 'растущее напряжение', 'Верхняя и Нижняя слободы спорят за луг между ними, по ночам уже дерутся кольями.', { helps: ['дать обеим слободам долю в луге', 'развести их по разным выпасам'] }), near('f2', 'удобный случай', 'Странствующие ткачи ищут, где встать с товаром на сезон.')],
      sides: [side('o1', 'Верхняя слобода'), side('o2', 'Нижняя слобода'), side('o3', 'Странствующие ткачи')],
    },
    expect: { f1: ['stop', 'removes', 'slow'], f2: ['-', 'hurry', 'safer'] },
    basis: { f1: 'solid' },
  },
  {
    name: 'цепи выкованы, но не привязаны',
    input: {
      work: 'Выковать цепи и якоря для привязи островка',
      result: 'Цепи и якоря (вещь): у причалов лежит комплект тяжёлых цепей, якорей и скоб, пригодный для привязи островка.',
      nearby: [near('f1', 'отложенная перемена', 'Островок с фонарями отчалит и уйдёт вместе с башней.', { carrier: 'Островок с фонарями' })],
      sides: [],
      later: ['Приковать островок'],
    },
    expect: { f1: ['-'] },
  },
  {
    name: 'стена из двух очередей: первая уже закрывает пролом',
    input: {
      work: 'Заложить пролом в северной стене',
      result: 'Северная стена (большое сооружение): пролом заложен камнем в полный рост, стена снова сплошная; башни над ней ещё не достроены.',
      nearby: [near('f1', 'угроза со сроком', 'Через пролом в северной стене по ночам лезут грабители с пустошей.', { helps: ['закрыть пролом', 'поставить у пролома караул'] })],
      sides: [side('o1', 'Грабители с пустошей')],
      later: ['Достроить башни над стеной'],
    },
    expect: { f1: ['stop', 'removes'] },
    sides: { o1: 'harms' },
  },
  {
    name: 'пожарная стража и поиск поджигателя',
    input: {
      work: 'Учредить ночную пожарную стражу',
      result: 'Ночная пожарная стража (учреждение): ночные караулы следят за огнём и сразу собирают людей на тушение.',
      nearby: [
        near('f1', 'угроза со сроком', 'Пожары всё ближе к центру: следующий жгут ляжет под амбар или под храм.', { carrier: 'Ночные пожары', helps: ['ночные дозоры', 'бочки и багры в каждом квартале', 'охрана амбаров и складов'] }),
        near('f2', 'поиск', 'Найти того, кто стоит за пожарами.', { helps: ['осмотр пепелищ', 'ночные засады', 'расспросы тех, кто первым оказался у огня'] }),
      ],
      sides: [side('o1', 'Городская стража', 'organization')],
    },
    expect: { f1: ['slow', 'stop'], f2: ['-', 'hurry', 'safer'] },
    basis: { f1: 'solid' },
  },
];

interface WillCase {
  name: string;
  order: string;
  officer?: string;
  expect: { label: string[]; frontId?: Array<string | null>; report?: boolean };
}

// Весь город рядом: восемь записей, явно касается работа одной-двух. Ловит лишние связи.
const FIND_HELPS = ['действия, которые исследуют устройство башни, преодолевают её защиту и приближают людей к тайнику', 'расшифровка надписей, языков и символов'];
const TOWN = [
  near('t1', 'угроза со сроком', 'Густой туман лёг в падь и отрезал хутора от города: ни обозов, ни вестей.'),
  near('t2', 'угроза со сроком', 'Пожар в Нижнем квартале никак не потушат, огонь идёт к библиотеке.'),
  near('t3', 'угроза со сроком', 'Бунтовщики из башни грабят причалы по ночам и скоро пойдут на склады города.', { carrier: 'Бунтовщики в башне' }),
  near('t4', 'растущее напряжение', 'Чужие старатели бьют шурфы на рудном плато и не уходят: рудокопы города грозят прогнать их силой.', { carrier: 'Чужие старатели' }),
  near('t5', 'удобный случай', 'Добраться до рецепта, который спрятан в башне.', { carrier: 'Островок с горящими фонарями', helps: FIND_HELPS }),
  near('t6', 'отложенная перемена', 'Островок с фонарями отчалит и уйдёт вместе с башней.', { carrier: 'Островок с горящими фонарями' }),
  near('t7', 'угроза со сроком', 'Угольные копи иссякают: к зиме кузням нечем будет топить.'),
  near('t8', 'дело', 'Каменщики кладут стену вдоль восточной кромки: камень везут с северных скал.'),
];
const TOWN_SIDES = [side('s1', 'Бунтовщики в башне'), side('s2', 'Чужие старатели'), side('s3', 'Кузнечный ряд', 'organization')];
const quiet = (ids: string[]) => Object.fromEntries(TOWN.map((n) => n.id).filter((id) => !ids.includes(id)).map((id) => [id, ['-']]));

const CROWD: InfluenceCase[] = [
  {
    name: 'птичья почта с хуторами',
    input: { work: 'Завести почтовых птиц: найти птиц, поставить голубятню, выучить их летать между городом и хуторами', result: 'Птичья почта (умение или знание): в городе есть почтовые птицы и умение отправлять их на хутора за туманной падью.', nearby: TOWN, sides: TOWN_SIDES },
    expect: { ...quiet(['t1']), t1: ['slow', 'outcome', '-'] },
  },
  {
    name: 'упряжные исполины для стены',
    input: { work: 'Приручить исполинов северных скал и выучить их тянуть каменные волокуши', result: 'Возка исполинами (умение или знание): город умеет впрягать северных исполинов и возить на них камень.', nearby: TOWN, sides: TOWN_SIDES },
    expect: { ...quiet(['t8']), t8: ['hurry'] },
  },
  {
    name: 'знаток ловушек при отряде',
    input: { work: 'Найти в городе того, кто разбирается в ловушках вроде башенных', result: 'Старый оружейник Тит (человек): ставил самострелы и ямы на складах и знает, как их обезвредить.', nearby: TOWN, sides: TOWN_SIDES },
    expect: { ...quiet(['t5']), t5: ['safer', 'hurry'] },
  },
  {
    name: 'вышка над причалами',
    input: { work: 'Поставить над причалами сторожевую вышку с колоколом', result: 'Вышка над причалами (большое сооружение): дозорные с колоколом видят все причалы и мостки к островку.', nearby: TOWN, sides: TOWN_SIDES },
    expect: { ...quiet(['t3']), t3: ['slow', 'stop'] },
  },
];

const FRONTS: WillInput['fronts'] = [
  { id: 'f1', title: '', description: 'Купцы на рынке обвешивают, горожане ропщут и грозят разнести ряды.', kind: 'растущее напряжение', lead: null, hindrances: [] },
  { id: 'f2', title: '', description: 'Небесные китобои и рыбаки города спорят за воды у кромки, дело идёт к стычке.', kind: 'растущее напряжение', lead: null, hindrances: [] },
  { id: 'f3', title: '', description: 'Засуха: цистерны верхнего квартала пустеют, воды осталось на считаные недели.', kind: 'угроза со сроком', lead: null, hindrances: [] },
  { id: 'f4', title: '', description: 'Сизая скала сползает и скоро ляжет на дома Гончарного квартала.', kind: 'отложенная перемена', lead: null, hindrances: [] },
  { id: 'f5', title: '', description: 'Собор на площади: каменщики тянут стены.', kind: 'дело', lead: 'казначей Ада (женщина)', hindrances: [] },
  { id: 'f6', title: '', description: 'Бродячие торговцы стоят у причала и продают редкие семена горных трав; скоро уйдут.', kind: 'удобный случай со сроком', lead: null, hindrances: [] },
  { id: 'f7', title: '', description: 'Беглые каторжники засели в старой мельнице и грабят обозы на дороге к хуторам.', kind: 'угроза со сроком', lead: null, hindrances: [] },
];

const WILL: WillCase[] = [
  { name: 'весовая палата против обвеса', order: 'Поставь на рынке весовую палату, чтобы купцы перестали обвешивать.', expect: { label: ['project'], frontId: ['f1'] } },
  { name: 'проверка гирь', order: 'Разберись с обвесом: пройдись по рядам с проверкой гирь и накажи пойманных.', expect: { label: ['strategy'], frontId: ['f1'] } },
  { name: 'договор с китобоями', order: 'Заключи с китобоями договор: кому какие воды у кромки.', expect: { label: ['project'], frontId: ['f2'] } },
  { name: 'уговорить китобоев', order: 'Уйми спор с китобоями: поговори со старшинами обеих сторон и остуди горячих.', expect: { label: ['strategy'], frontId: ['f2'] } },
  { name: 'колодец в засуху', order: 'Вырой глубокий колодец в верхнем квартале, раз цистерны пустеют.', expect: { label: ['project'], frontId: ['f3'] } },
  { name: 'раздача воды', order: 'Раздавай воду из храмовых цистерн верхнему кварталу, пока засуха не кончится.', expect: { label: ['strategy'], frontId: ['f3'] } },
  { name: 'указ о воде', order: 'Издай указ: воду из цистерн отпускать только по мерке на двор.', expect: { label: ['project'], frontId: ['f3'] } },
  { name: 'слух о колодцах', order: 'Пусть в городе заговорят, что тратить воду попусту значит гневить небо.', expect: { label: ['project'], frontId: ['f3'] } },
  { name: 'обсерватория', order: 'Построй обсерваторию на храмовом холме.', expect: { label: ['project'], frontId: [null] } },
  { name: 'быки под скалой', order: 'Подопри Сизую скалу каменными быками.', expect: { label: ['project'], frontId: ['f4'] } },
  { name: 'увести людей из-под скалы', order: 'Выведи гончаров из домов под скалой, пока она не легла.', expect: { label: ['project', 'strategy'], frontId: ['f4'] } },
  { name: 'вторая артель на собор', order: 'Найми вторую артель на стройку собора.', officer: 'маршал Бран (мужчина)', expect: { label: ['deed'], frontId: ['f5'] } },
  { name: 'купить семена', order: 'Купи у бродячих торговцев семена, пока они не ушли.', expect: { label: ['strategy', 'deed'], frontId: ['f6'] } },
  { name: 'теплица для семян', order: 'Построй теплицу для горных трав, что продают бродячие торговцы.', expect: { label: ['project'], frontId: ['f6', null] } },
  { name: 'ополчение у кромки', order: 'Собери из рыбаков ополчение с гарпунами, пусть стережёт наши воды от китобоев.', expect: { label: ['project'], frontId: ['f2'] } },
  { name: 'собор не торопить', order: 'С собором не спешите, берегите людей.', expect: { label: ['tempo'], frontId: ['f5'] } },
  { name: 'кто за обвесом', order: 'Разузнай, кто из купцов подбивает остальных обвешивать.', expect: { label: ['project'], frontId: ['f1'] } },
  { name: 'что со скалой', order: 'Выясни, отчего сползает Сизая скала.', expect: { label: ['project'], frontId: ['f4'] } },
  { name: 'маяк с докладом', order: 'Поставь маяк на кромке, только докладывай мне после каждого шага.', expect: { label: ['project'], frontId: [null], report: true } },
  { name: 'слух, чтобы ушли сами', order: 'Пустить среди китобоев слух, что воды у кромки прокляты, чтобы они сами ушли; следить, чтобы слух дошёл до них.', expect: { label: ['project'], frontId: ['f2'] } },
  { name: 'беглых на службу', order: 'Окружить мельницу, предложить беглым сдаться и пойти на службу в городскую стражу; взять их под надзор.', officer: 'маршал Бран (мужчина)', expect: { label: ['project'], frontId: ['f7'] } },
  { name: 'выкурить беглых', order: 'Окружить мельницу и выкурить беглых дымом, а кто выйдет, тех в колодки.', officer: 'маршал Бран (мужчина)', expect: { label: ['strategy'], frontId: ['f7'] } },
  { name: 'маяк без доклада', order: 'Поставь маяк на кромке.', expect: { label: ['project'], frontId: [null], report: false } },
];

interface ConditionCase {
  name: string;
  input: ConditionInput;
  met: boolean;
}

const CONDITION: ConditionCase[] = [
  { name: 'китобои вошли в наши воды', input: { condition: 'если китобои зайдут в наши воды у кромки', events: ['Три китобойных баркаса встали на якорь у восточной кромки, где рыбачит слобода, и спустили гарпунные лодки.'] }, met: true },
  { name: 'китобои грозят на совете', input: { condition: 'если китобои зайдут в наши воды у кромки', events: ['Старшина китобоев на совете грозил, что весной его люди возьмут воды силой.'] }, met: false },
  { name: 'скала треснула над домами', input: { condition: 'когда скала начнёт падать', events: ['Ночью от Сизой скалы откололся пласт и раздавил два гончарных двора, люди бегут из квартала.'] }, met: true },
  { name: 'скала стоит, сыплется щебень', input: { condition: 'когда скала начнёт падать', events: ['С Сизой скалы сыплется мелкий щебень, гончары ворчат и метут дворы.'] }, met: false },
  { name: 'собор достроен', input: { condition: 'как только собор будет готов', events: ['Над собором подняли купол, в первый раз отслужили службу.'] }, met: true },
  { name: 'собор: стены подняты', input: { condition: 'как только собор будет готов', events: ['Каменщики свели стены собора под крышу, теперь берутся за купол.'] }, met: false },
  { name: 'торговцы собрались уходить', input: { condition: 'если бродячие торговцы соберутся уходить', events: ['Торговцы у причала сворачивают шатры и грузят тюки на свои лодки.'] }, met: true },
  { name: 'торговцы торгуются', input: { condition: 'если бродячие торговцы соберутся уходить', events: ['Торговцы подняли цену на семена вдвое: говорят, покупателей много.'] }, met: false },
  { name: 'рынок разнесли', input: { condition: 'если на рынке начнутся погромы', events: ['Толпа опрокинула ряды обвесчиков и подожгла две лавки, стража отступила к ратуше.'] }, met: true },
  { name: 'рынок: обвес разоблачили', input: { condition: 'если на рынке начнутся погромы', events: ['Весовая палата поймала трёх купцов на обвесе, их лавки закрыли, ропот стих.'] }, met: false },
  { name: 'вести из экспедиции: нашли', input: { condition: 'когда экспедиция найдёт рудную жилу', events: ['Гонец с северного склона: рудознатцы вскрыли богатую медную жилу под старым кедром.'] }, met: true },
  { name: 'вести из экспедиции: пусто', input: { condition: 'когда экспедиция найдёт рудную жилу', events: ['Рудознатцы прошли северный склон до ледника и вернулись с пустыми мешками.'] }, met: false },
  { name: 'новая беда: мор у пристани', input: { condition: 'если в город придёт мор', events: ['В портовой слободе слегли с горячкой два десятка грузчиков, лекари говорят о заразе с чужого корабля.'] }, met: true },
  { name: 'застава: северяне готовятся', input: { condition: 'когда горцы спустятся к заставе', events: ['Пастухи видели дымы горцев на верхних пастбищах: те собирают отары и людей.'] }, met: false },
  { name: 'застава: горцы пришли', input: { condition: 'когда горцы спустятся к заставе', events: ['Сотня горцев с топорами вышла из ущелья прямо к заставе и встала лагерем под стеной.'] }, met: true },
  { name: 'новая беда: пожар', input: { condition: 'если в город придёт мор', events: ['В кожевенном ряду сгорели три мастерских, огонь остановили у канала.'] }, met: false },
];

async function runCondition(deps: AgentDeps, repeat: number): Promise<number> {
  let bad = 0;
  for (const c of CONDITION) {
    for (let i = 0; i < repeat; i++) {
      const out = await judgeCondition(deps, c.input);
      const ok = out.met === c.met;
      if (!ok) bad++;
      console.log(`${ok ? '✓' : '✗'} ${c.name}: ${out.met} — ${out.reason}${ok ? '' : `\n    ждали ${c.met}`}`);
    }
  }
  return bad;
}

interface ContributionCase {
  name: string;
  subject: { type: ObjectType; name: string; description: string };
  apart: string[];
  /** Сколько пунктов вклада самое большее считаем верным: то, что вещь держит, посчитано отдельно. */
  atMost: number;
}

const CONTRIBUTION: ContributionCase[] = [
  { name: 'цепное крепление', subject: { type: 'structure', name: 'Цепное крепление', description: 'Тяжёлые цепи и якоря держат прибившийся островок у причалов.' }, apart: ['пока есть Цепное крепление, не случится: «Островок с фонарями отчалит и уйдёт вместе с башней»'], atMost: 0 },
  { name: 'клятва наследников', subject: { type: 'practice', name: 'Клятва мира', description: 'Старшая наследница и младший наследник публично клянутся не поднимать распрю до жатвы.' }, apart: ['пока есть Клятва мира, не случится: «Каждый наследник собирает своих людей» (держится на слове)'], atMost: 2 },
  { name: 'слух о море', subject: { type: 'practice', name: 'Слух о заразе в заброшенной мельнице', description: 'В слободах говорят, что на мельнице мрут от горячки.' }, apart: ['пока есть Слух о заразе в заброшенной мельнице, медленнее надвигается: «Беглые каторжники на мельнице набирают людей из слобод» (держится на слове)'], atMost: 2 },
  { name: 'каменные быки', subject: { type: 'structure', name: 'Каменные быки под Сизой скалой', description: 'Шесть опор из тёсаного камня держат скалу над Гончарным кварталом.' }, apart: ['пока есть Каменные быки под Сизой скалой, не случится: «Сизая скала ляжет на дома Гончарного квартала»'], atMost: 0 },
  { name: 'пожарная стража', subject: { type: 'organization', name: 'Ночная пожарная стража', description: 'Ночные караулы следят за огнём и сразу собирают людей на тушение.' }, apart: ['пока есть Ночная пожарная стража, медленнее надвигается: «Пожары всё ближе к центру»'], atMost: 4 },
  { name: 'обозная охрана', subject: { type: 'organization', name: 'Обозная охрана', description: 'Сорок наёмных копейщиков ходят с каждым обозом от рудника до города.' }, apart: ['пока есть Обозная охрана, не случится: «Шайка Косого перехватывает обозы с рудой»'], atMost: 4 },
  { name: 'маяк без беды рядом', subject: { type: 'structure', name: 'Маяк на краю острова', description: 'Высокий маяк с огнём, по которому рыбаки в тумане находят дорогу домой.' }, apart: [], atMost: 30 },
];

async function runContribution(deps: AgentDeps, repeat: number): Promise<number> {
  const rules = parseRules(readYaml('config/game.yaml'));
  const stats = { prosperity: 50, security: 50, knowledge: 50, influence: 50 };
  const keyObjects: ContributionInput['keyObjects'] = [
    { name: 'Городская стража', type: 'organization', effects: [{ stat: 'security', direction: 'up', size: 'large' }] },
    { name: 'Торговый квартал', type: 'district', effects: [{ stat: 'prosperity', direction: 'up', size: 'large' }] },
    { name: 'Храм покровителя', type: 'building', effects: [{ stat: 'influence', direction: 'up', size: 'medium' }] },
    { name: 'Рыбачья слобода', type: 'community', effects: [{ stat: 'prosperity', direction: 'up', size: 'medium' }] },
  ];
  let bad = 0;
  for (const c of CONTRIBUTION) {
    for (let i = 0; i < repeat; i++) {
      const out = await appraiseContribution(deps, { rules, subject: c.subject, cityStats: qualitativeStats(rules, stats), keyObjects, before: null, apart: c.apart });
      const sum = magnitude(gradePoints(rules, out.effects));
      const ok = sum <= c.atMost && (c.apart.length > 0 || sum > 0);
      if (!ok) bad++;
      console.log(`${ok ? '✓' : '✗'} ${c.name}: ${out.effects.map((e) => `${e.stat} ${e.direction} ${e.size}`).join(', ') || 'пусто'} (${sum}) — ${out.reason}${ok ? '' : `\n    ждали не больше ${c.atMost}`}`);
    }
  }
  return bad;
}

async function runInfluence(deps: AgentDeps, repeat: number, cases = INFLUENCE): Promise<number> {
  let bad = 0;
  for (const c of cases) {
    for (let i = 0; i < repeat; i++) {
      const out = await appraiseInfluence(deps, c.input);
      const got = new Map(out.links.map((l) => [l.frontId, l]));
      const notes: string[] = [];
      for (const [id, allowed] of Object.entries(c.expect)) {
        const effect = got.get(id)?.effect ?? '-';
        if (!allowed.includes(effect)) notes.push(`${id}: ${effect}, ждали ${allowed.join('|')}`);
        const basis = c.basis?.[id];
        if (basis && got.has(id) && (got.get(id)!.word ? 'word' : 'solid') !== basis) notes.push(`${id}: основа ${got.get(id)!.word ? 'word' : 'solid'}, ждали ${basis}`);
      }
      for (const [id, stance] of Object.entries(c.sides ?? {})) {
        const said = out.sides.find((s) => s.objectId === id)?.stance ?? '-';
        if (said !== stance) notes.push(`${id}: ${said}, ждали ${stance}`);
      }
      if (notes.length) bad++;
      const said = out.links.map((l) => `${l.frontId} ${l.effect}${l.word ? ' (word)' : ''}`).join(', ') || 'пусто';
      const who = out.sides.map((s) => `${s.objectId} ${s.stance}`).join(', ');
      console.log(`${notes.length ? '✗' : '✓'} ${c.name}: ${said}${who ? `; ${who}` : ''} — ${out.reason}${notes.length ? `\n    ${notes.join('; ')}` : ''}`);
    }
  }
  return bad;
}

async function runWill(deps: AgentDeps, repeat: number): Promise<number> {
  let bad = 0;
  for (const c of WILL) {
    for (let i = 0; i < repeat; i++) {
      const out = await interpretWill(deps, { order: c.order, officer: c.officer ?? 'хранитель Ивер (мужчина)', fronts: FRONTS, projects: [] });
      const ok = c.expect.label.includes(out.label) && (!c.expect.frontId || c.expect.frontId.includes(out.frontId)) && (c.expect.report == null || Boolean(out.report) === c.expect.report);
      if (!ok) bad++;
      console.log(`${ok ? '✓' : '✗'} ${c.name}: ${out.label} ${out.frontId ?? '—'} «${out.goal}»${out.manner ? ` [${out.manner}]` : ''}${ok ? '' : `\n    ждали ${c.expect.label.join('|')} ${c.expect.frontId?.map((f) => f ?? '—').join('|') ?? ''}`}`);
    }
  }
  return bad;
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const which = args.find((a) => !a.startsWith('--')) ?? 'all';
  const at = args.indexOf('--repeat');
  const repeat = at >= 0 ? Math.max(1, Number(args[at + 1]) || 1) : 1;
  const settings = parseAgentSettings(readYaml('config/agents.yaml'));
  const deps: AgentDeps = { llm: metered(buildLlm(process.env)), settings };
  let bad = 0;
  if (which === 'all' || which === 'influence') {
    console.log('— оценщик влияния —');
    bad += await runInfluence(deps, repeat);
  }
  if (which === 'all' || which === 'crowd') {
    console.log('— оценщик влияния: весь город рядом —');
    bad += await runInfluence(deps, repeat, CROWD);
  }
  if (which === 'all' || which === 'contribution') {
    console.log('— оценщик вклада: что посчитано отдельно —');
    bad += await runContribution(deps, repeat);
  }
  if (which === 'all' || which === 'will') {
    console.log('— толкователь воли —');
    bad += await runWill(deps, repeat);
  }
  if (which === 'all' || which === 'condition') {
    console.log('— сверщик условия —');
    bad += await runCondition(deps, repeat);
  }
  console.log(`\nмимо: ${bad}. Токены: вход ${total.inputTokens} (из кэша ${total.cachedInputTokens}, запись ${total.cacheWriteTokens}), выход ${total.outputTokens}. Цена: $${cost(total).toFixed(4)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
