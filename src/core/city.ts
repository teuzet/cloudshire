/**
 * Модель мира v2: мир (сезон) и города. Только типы и маленькие конструкторы.
 *
 * Каждый город хранит всё своё сам, включая очередь заданий: так два города
 * никогда не пишут в один документ, а писатель одного города — один.
 */

import type { ClockState } from './time.js';
import type { FrontForm, ObjectType, Office, Relation, RiskStep, StatId, StatMap, Temper, Tempo, Verdict } from './rules.js';

// ───────────────────────────── мир ─────────────────────────────

export interface Season {
  id: string;
  name: string;
  /** Общие правила сезона текстом. Механики у них пока нет. */
  rules: string[];
  startedDay: number;
}

/** Имя из пула мира. Пол задан пулом: агенты его не придумывают. */
export interface PoolName {
  name: string;
  gender: Gender;
}

export interface World {
  id: string;
  clock: ClockState;
  season: Season;
  /** Пул имён людей с полом; вынимается по одному, чтобы имена не повторялись. */
  namePool: PoolName[];
  revision: number;
}

// ───────────────────────────── объекты ─────────────────────────────

export interface ObjectVersion {
  version: number;
  description: string;
  statEffect: StatMap;
  createdDay: number;
}

export interface WorldObject {
  id: string;
  type: ObjectType;
  name: string;
  description: string;
  /** Вклад в статы в сырых единицах города: пункты стата = сырое × city.statScale. */
  statEffect: StatMap;
  /** Связи с другими объектами. По ним идёт эхо. */
  refs: string[];
  version: number;
  versions: ObjectVersion[];
  status: 'active' | 'deleted';
  createdDay: number;
  deletedDay: number | null;
  /** Нельзя удалить ставкой. */
  protected: boolean;
  /** Буквальная вложенность: удаление родителя уносит детей. */
  parentId: string | null;
  /** Скрытый объект: его видят агенты, но не жрец и не игрок. */
  hidden: boolean;
  /** Фронт, который занял объект. Занятый объект даёт только часть вклада. */
  occupiedBy: string | null;
  /** Временный объект: живёт, пока жив фронт, к которому привязан. */
  temporary: boolean;
  /** Помощник (rate > 0) или помеха (rate < 0) фронта: единиц работы в игровой месяц. */
  attach: { frontId: string; rate: number } | null;
  /** Одна или две темы города. */
  themes: string[];
  /** День создания или последней перемены: год после него объект «свежий» для подбора ролей. */
  freshDay: number;
}

// ───────────────────────────── фронты ─────────────────────────────

/** Операция ставки. Вклады здесь в пунктах стата, в сырые единицы их переводит core. */
export type StakeOp =
  | {
      op: 'create';
      object: {
        type: ObjectType;
        name: string;
        description: string;
        points: StatMap;
        parentId?: string | null;
        refs?: string[];
        hidden?: boolean;
      };
      /** Этот объект и есть результат этапа: к нему привяжутся связи отпечатка. */
      result?: boolean;
    }
  /** Переоценить вклад объекта: новые пункты целиком. */
  | { op: 'revalue'; target: string; points: StatMap; description?: string | null }
  /** Переписать и переоценить по намерению: поток заранее превращает её в revalue. */
  | { op: 'modify'; target: string; intent: string }
  | { op: 'delete'; target: string }
  | { op: 'reveal'; target: string }
  | { op: 'fact'; text: string }
  | { op: 'link'; a: string; b: string }
  | { op: 'progress'; frontId: string; amount: number }
  | { op: 'rollback'; frontId: string }
  | { op: 'cancel'; frontId: string }
  /** Помощник (rate > 0) или помеха (rate < 0) на фронте. */
  | { op: 'attach'; frontId: string; rate: number; object: { type: ObjectType; name: string; description: string; points: StatMap } }
  /** Изменение статов без носителя в мире. */
  | { op: 'stats'; points: Partial<StatMap> };

export interface FootprintEntry {
  objectId: string;
  relation: Relation;
  reason: string;
}

/** Запечатанное знание о фронте: игрок и жрец его не видят. */
export interface FrontKey {
  /** Ходы, которые двигают фронт в нужную сторону. */
  moves: string[];
  /** Подвох исхода, если исход этапа не известен заранее и жребий выпал «с подвохом». */
  twist: string | null;
}

/** Откуда фронт: проект игрока, атомарное дело, осложнение, эхо по связям, посаженная история. */
export type FrontOrigin = 'player' | 'deed' | 'complication' | 'echo' | 'story';

export type DeedKind = 'push' | 'helper' | 'clear';

export interface Front {
  id: string;
  form: FrontForm;
  origin: FrontOrigin;
  title: string;
  description: string;
  /** Единиц работы до конца. У часов ноль. */
  capacity: number;
  /** Прогресс на день progressDay; дальше растёт линейно со скоростью ratePerDay. */
  progress: number;
  progressDay: number;
  ratePerDay: number;
  /** Вехи делят шкалу поровну; последняя веха — завершение. */
  milestones: number;
  milestonesFired: number;
  /** Срок: у угроз, часов, возможностей; у напряжения это день прорыва. */
  deadlineDay: number | null;
  /** День следующего месячного броска: у дел «невозможно» и недостижимых. */
  pulseDay: number | null;
  /** Что случится, когда шкала заполнена (у часов — когда выйдет срок). */
  stake: StakeOp[];
  /** Что случится, если срок вышел раньше. */
  failStake: StakeOp[];
  risk: RiskStep;
  /** Темп проекта: один из трёх рычагов. */
  tempo: Tempo;
  key: FrontKey | null;
  footprint: FootprintEntry[];
  /** Объекты-участники: роль осложнения, цели ставки. */
  refs: string[];
  parentId: string | null;
  /** Чем привязанное осложнение грозит родителю. */
  bound: 'slow' | 'rollback' | 'cancel' | null;
  /** Сколько стоит на кону (в единицах работы): из этого считается ёмкость угрозы и напряжения. */
  atStake: number;
  /** Плюсовой фронт: срок истёк — просто исчез. */
  plus: boolean;
  /** Причина, по которой цель недостижима. Такое дело идёт до краха. */
  unattainable: string | null;
  /** Сколько бросков риска сработало: каждый N-й отдаётся плюсовой записи. */
  rollsFired: number;
  projectId: string | null;
  /** Промежуточный объект, пока идёт работа («Стройка башни»). */
  siteId: string | null;
  /** Стат, к которому дело относится сильнее всего: для поправки сановника. */
  profile: StatId | null;
  /** Атомарное дело: вид и вердикт Судьи на его формулировку. */
  deed: { kind: DeedKind; verdict: Verdict; targetId: string | null } | null;
  /** Материал посаженной истории. */
  script: {
    events: Array<{ id: string; description: string; fired: boolean }>;
    clues: Array<{ id: string; fact: string; revealed: boolean }>;
  } | null;
  /** Что случится, если не вмешаться: слова Костюмера. */
  outburst: string | null;
  /** Запись словаря динамик, из которой фронт собран. */
  dynamicId: string | null;
  status: 'active' | 'done' | 'failed' | 'cancelled';
  createdDay: number;
  resolvedDay: number | null;
}

// ───────────────────────────── поручения ─────────────────────────────

/** Сановник ведёт один фронт: стратегией или как исполнитель атомарного дела. */
export interface Assignment {
  id: string;
  frontId: string;
  office: Office;
  /** Стратегия словами игрока. Пусто — сановник работает без особого наказа. */
  text: string;
  /** Вердикт Судьи соответствия: хранится, чтобы одни слова всегда стоили одинаково. */
  verdict: Verdict;
  /** Темп поручения: второй рычаг. */
  tempo: Tempo;
  status: 'active' | 'ended';
  startDay: number;
  endDay: number | null;
}

// ───────────────────────────── проекты ─────────────────────────────

export interface ProjectStage {
  title: string;
  work: string;
  result: {
    kind: 'new_object' | 'change_object' | 'remove_object' | 'fact';
    objectId: string | null;
    type: ObjectType | null;
    name: string;
    description: string;
    parentId: string | null;
  };
  site: { name: string; description: string } | null;
  outcomeKnown: boolean;
}

/** Цепочка этапов. Идёт один этап за раз; следующий ждёт слова игрока. */
export interface Project {
  id: string;
  title: string;
  goal: string;
  stages: ProjectStage[];
  /** Этап, который идёт сейчас или ждёт запуска. */
  stageIndex: number;
  frontId: string | null;
  unattainable: string | null;
  status: 'running' | 'waiting' | 'done' | 'cancelled';
  createdDay: number;
}

// ───────────────────────────── люди и речь ─────────────────────────────

export interface Officer {
  office: Office;
  statId: StatId;
  title: string;
  name: string;
  gender: Gender;
  /** Характер человека: пара фраз для промптов. */
  nature: string;
  /** Собственный темп: третий рычаг. Бросается при рождении города, от должности не зависит. */
  temper: Temper;
  assignmentId: string | null;
}

export type Gender = 'female' | 'male';

/** «Рыба» города: что собрал онбординг и из чего генезис строит город. */
export interface CitySeed {
  cityName: string | null;
  patronName: string;
  patronGender: Gender;
  pitch: string;
}

export interface Priest {
  name: string;
  gender: Gender;
  nature: string;
}

export interface ChronicleEntry {
  id: string;
  day: number;
  text: string;
  /** Откуда запись: генезис, веха, завершение или срок фронта, осложнение, посадка истории, воля игрока. */
  source: 'genesis' | 'milestone' | 'completion' | 'deadline' | 'complication' | 'scenario' | 'will';
  frontId: string | null;
}

export interface DialogEntry {
  role: 'patron' | 'priest';
  text: string;
  day: number;
  /** news — весть, которую жрец написал сам; reply — ответ на реплику. */
  kind: 'reply' | 'news';
}

/**
 * Каноническая неизвестность: то, что в мире официально не установлено.
 * Позже такая тайна «выстрелит»; до тех пор её объекты закрыты для посадок историй.
 */
export interface CanonicalUnknown {
  text: string;
  /** Объекты острова, на которых держится тайна. */
  objectIds: string[];
}

/**
 * Факт мира: сухое утверждение о том, что есть. Пишут генезис и лормастер.
 * Снятый факт не удаляется: он помечен retired и в промпты больше не идёт.
 */
export interface LoreFact {
  id: string;
  text: string;
  day: number;
  /** Факт дописан по вопросу о конкретной истории. */
  frontId: string | null;
  /** event — факт, который закрепила ставка или развязка события. */
  author: 'genesis' | 'loremaster' | 'event';
  status: 'active' | 'retired';
  previousText: string | null;
  reason: string | null;
}

/** Заметка жреца: «называть только Алаэр», «не будить по мелочам». */
export interface PriestNote {
  id: string;
  text: string;
  day: number;
}

// ───────────────────────────── очередь ─────────────────────────────

/** front_event — ближайшее событие фронта: веха, срок или месячный бросок. */
export type JobKind = 'front_event' | 'seed';

export interface Job {
  id: string;
  kind: JobKind;
  dueDay: number;
  payload: { frontId?: string; scenarioId?: string };
  state: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
}

// ───────────────────────────── город ─────────────────────────────

export interface Mana {
  value: number;
  /** День последнего начисления. */
  day: number;
}

/** Вера: пятая ось города. Лениво тянется к среднему статов и получает импульсы от событий. */
export interface Faith {
  value: number;
  day: number;
}

export interface City {
  id: string;
  worldId: string;
  ownerId: string;
  name: string;
  patronName: string;
  /** Полное описание города из генезиса: аспекты подряд. */
  description: string;
  /** Компактный фактический бриф города для агентов. */
  brief: string;
  /** Канонические неизвестности: установленные пробелы мира. Их не раскрывает лормастер и не трогают посадки. */
  unknowns: CanonicalUnknown[];
  /** Факты мира: стартовые из генезиса и дописанные лормастером. */
  facts: LoreFact[];
  /** Названное покровителем, о чём неизвестно, есть ли оно: его можно только найти. */
  sought?: string[];
  priest: Priest;
  officers: Officer[];
  stats: StatMap;
  /** Курс обмена сырых вкладов объектов на очки статов. Фиксируется на генезисе. */
  statScale: number;
  /** Прямые изменения статов без носителя в мире. */
  statLedger: StatMap;
  mana: Mana;
  faith: Faith;
  objects: WorldObject[];
  fronts: Front[];
  assignments: Assignment[];
  projects: Project[];
  /** Когда каждая запись словаря динамик срабатывала в последний раз. */
  dynamicsUsed: Record<string, number>;
  /** Предупреждение о недостижимой цели: повторный приказ в срок запускает дело. */
  unattainableWarning: { goal: string; day: number } | null;
  chronicle: ChronicleEntry[];
  dialog: DialogEntry[];
  notes: PriestNote[];
  jobs: Job[];
  /** Сценарии, которые уже сыграли в этом городе. */
  scenariosUsed: string[];
  createdDay: number;
  revision: number;
}

// ───────────────────────────── конструктор ─────────────────────────────

/** Новый город из готовых частей генезиса. Статы уже собраны ядром (genesisStats). */
export function newCity(args: {
  id: string;
  worldId: string;
  ownerId: string;
  name: string;
  patronName: string;
  description: string;
  brief: string;
  unknowns: CanonicalUnknown[];
  facts: LoreFact[];
  priest: Priest;
  officers: Officer[];
  objects: WorldObject[];
  stats: StatMap;
  statScale: number;
  statLedger: StatMap;
  manaStart: number;
  day: number;
}): City {
  const day = Math.max(0, Math.round(args.day));
  return {
    id: args.id,
    worldId: args.worldId,
    ownerId: args.ownerId,
    name: args.name,
    patronName: args.patronName,
    description: args.description,
    brief: args.brief,
    unknowns: args.unknowns.map((u) => ({ text: u.text, objectIds: [...u.objectIds] })),
    facts: args.facts,
    priest: args.priest,
    officers: args.officers,
    stats: { ...args.stats },
    statScale: args.statScale,
    statLedger: { ...args.statLedger },
    mana: { value: args.manaStart, day },
    faith: { value: (args.stats.prosperity + args.stats.security + args.stats.knowledge + args.stats.influence) / 4, day },
    objects: args.objects,
    fronts: [],
    assignments: [],
    projects: [],
    dynamicsUsed: {},
    unattainableWarning: null,
    chronicle: [],
    dialog: [],
    notes: [],
    jobs: [],
    scenariosUsed: [],
    createdDay: day,
    revision: 0,
  };
}
