/**
 * Модель мира v2: мир (сезон) и города. Только типы и маленькие конструкторы.
 *
 * Каждый город хранит всё своё сам, включая очередь заданий: так два города
 * никогда не пишут в один документ, а писатель одного города — один.
 */

import type { ClockState } from './time.js';
import type {
  DriftBand,
  Efficiency,
  Impact,
  ObjectType,
  Office,
  Risk,
  StatId,
  StatMap,
} from './rules.js';

// ───────────────────────────── мир ─────────────────────────────

export interface Season {
  id: string;
  name: string;
  /** Общие правила сезона текстом. Механики у них пока нет. */
  rules: string[];
  startedDay: number;
}

export interface World {
  id: string;
  clock: ClockState;
  season: Season;
  /** Пул имён людей; вынимается по одному, чтобы имена не повторялись. */
  namePool: string[];
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
  statEffect: StatMap;
  refs: string[];
  version: number;
  versions: ObjectVersion[];
  status: 'active' | 'deleted';
  createdDay: number;
  deletedDay: number | null;
  /** Нельзя удалить ставкой. */
  protected: boolean;
}

// ───────────────────────────── фронты ─────────────────────────────

export interface FrontEvent {
  id: string;
  description: string;
  status: 'live' | 'blocked' | 'fired';
}

export interface Clue {
  id: string;
  fact: string;
  alignment: string;
  status: 'hidden' | 'revealed';
}

export interface CreateStake {
  create: {
    type: ObjectType;
    name: string;
    description: string;
    /** Готовый вклад в сырых единицах. Если нет — считается из weight и statProfile. */
    statEffect?: StatMap;
    weight?: Impact;
    statProfile?: Partial<StatMap>;
    refs?: string[];
  };
}
export interface ModifyStake {
  modify: {
    target: string;
    /** Если версия задана заранее, писатель версий не нужен. */
    proposed?: { description: string; statEffect?: StatMap; weight?: Impact; statProfile?: Partial<StatMap> };
    intent?: string;
  };
}
export interface DeleteStake {
  delete: { target: string };
}
export interface StatsStake {
  stats: Partial<StatMap>;
}
export interface RevealStake {
  reveal: { text: string };
}
export type Stake = CreateStake | ModifyStake | DeleteStake | StatsStake | RevealStake;

/** Побочный фронт, который откроется на очередном пороге родителя. */
export interface ConsequenceDraft {
  description: string;
  impact: Impact;
  drift: DriftBand;
  stake: Stake | null;
}

/** Откуда фронт: посаженная история, воля игрока или её последствие. */
export type FrontOrigin = 'story' | 'mutation' | 'consequence';

export interface Front {
  id: string;
  origin: FrontOrigin;
  description: string;
  stake: Stake | null;
  /** Цена полного прохождения. */
  effort: number;
  /** Прогресс на день progressDay; дальше растёт линейно со скоростью ratePerDay. */
  progress: number;
  progressDay: number;
  driftBand: DriftBand;
  ratePerDay: number;
  beatCount: number;
  /** Индексы уже сработавших порогов. Порог одноразовый. */
  beatsFired: number[];
  events: FrontEvent[];
  clues: Clue[];
  /** Скрытое описание того, какие действия двигают фронт. */
  alignment: string;
  refs: string[];
  pendingConsequences: ConsequenceDraft[];
  status: 'active' | 'resolved' | 'invalid';
  createdDay: number;
  resolvedDay: number | null;
}

// ───────────────────────────── поручения ─────────────────────────────

export type Direction = 'forward' | 'backward' | 'none';
export type StopWhen = 'next_result' | 'stake' | 'cancelled';

export interface Assignment {
  id: string;
  frontId: string | null;
  office: Office;
  text: string;
  direction: Direction;
  efficiency: Efficiency;
  blocks: string[];
  stopWhen: StopWhen;
  risk: Risk | null;
  status: 'active' | 'done' | 'cancelled';
  startDay: number;
  endDay: number | null;
  /** Сколько effort сановник уже вложил (по модулю), на день effortDay. */
  effortDone: number;
  effortDay: number;
  riskCheckedAtEffort: number;
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
  /** Откуда запись: порог фронта, ставка, генезис, сценарий. */
  source: 'genesis' | 'beat' | 'stake' | 'scenario' | 'mutation';
  frontId: string | null;
}

export interface DialogEntry {
  role: 'patron' | 'priest';
  text: string;
  day: number;
  /** news — весть, которую жрец написал сам; reply — ответ на реплику. */
  kind: 'reply' | 'news';
}

/** Заметка жреца: «называть только Алаэр», «не будить по мелочам». */
export interface PriestNote {
  id: string;
  text: string;
  day: number;
}

// ───────────────────────────── очередь ─────────────────────────────

export type JobKind = 'front_beat' | 'front_stake' | 'seed';

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

export interface City {
  id: string;
  worldId: string;
  ownerId: string;
  name: string;
  patronName: string;
  /** Литературное описание города для агентов. */
  brief: string;
  priest: Priest;
  officers: Officer[];
  stats: StatMap;
  /** Курс обмена сырых вкладов объектов на очки статов. Фиксируется на генезисе. */
  statScale: number;
  /** Прямые изменения статов без носителя в мире. */
  statLedger: StatMap;
  mana: Mana;
  objects: WorldObject[];
  fronts: Front[];
  assignments: Assignment[];
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
  brief: string;
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
    brief: args.brief,
    priest: args.priest,
    officers: args.officers,
    stats: { ...args.stats },
    statScale: args.statScale,
    statLedger: { ...args.statLedger },
    mana: { value: args.manaStart, day },
    objects: args.objects,
    fronts: [],
    assignments: [],
    chronicle: [],
    dialog: [],
    notes: [],
    jobs: [],
    scenariosUsed: [],
    createdDay: day,
    revision: 0,
  };
}
