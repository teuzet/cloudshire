/**
 * Фронты: пять механических форм на одной шкале.
 *
 *   deed    — дело: двигают ведущий, помощники и атомарные дела; заполнено — ставка;
 *   tension — напряжение: гасится работой; срок вышел — прорывается;
 *   threat  — угроза: снимается работой до срока; не успели — ставка провала;
 *   clock   — часы: только срок, потом ставка;
 *   find    — поиск: работа доводит до раскрытия.
 *
 * Прогресс ленивый: хранится значение на день progressDay и скорость, остальное досчитывается.
 */

import { clipWords } from '../text.js';
import type { FrontForm, RiskStep, Rules, Scale, StatId, Tempo } from '../rules.js';
import type { City, FootprintEntry, Front, FrontKey, FrontOrigin, StakeOp } from '../city.js';
import { closeAssignment, leadOf, officerOf } from './assignments.js';
import type { Change } from './changes.js';
import { attachRatePerDay, leadRatePerDay, officerFit, rawToPoints, temperTempo } from './numbers.js';
import { attachedTo, deleteObject, findObject } from './objects.js';
import { recomputeStats } from './stats.js';

const EPS = 1e-9;

export function createFront(args: {
  id: string;
  form: FrontForm;
  origin: FrontOrigin;
  title: string;
  description: string;
  capacity: number;
  milestones?: number;
  deadlineDay?: number | null;
  pulseDay?: number | null;
  stake?: StakeOp[];
  failStake?: StakeOp[];
  risk?: RiskStep;
  tempo?: Tempo;
  key?: FrontKey | null;
  footprint?: FootprintEntry[];
  refs?: string[];
  parentId?: string | null;
  bound?: Front['bound'];
  atStake?: number;
  plus?: boolean;
  scale?: Scale | null;
  unattainable?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  profile?: StatId | null;
  deed?: Front['deed'];
  script?: Front['script'];
  outburst?: string | null;
  dynamicId?: string | null;
  day: number;
}): Front {
  const day = Math.max(0, Math.round(args.day));
  const capacity = args.form === 'clock' ? 0 : Math.max(0, args.capacity);
  if (args.form !== 'clock' && !(capacity > 0)) throw new Error(`у фронта ${args.id} нет ёмкости`);
  if (args.form === 'clock' && args.deadlineDay == null) throw new Error(`у часов ${args.id} нет срока`);
  return {
    id: args.id,
    form: args.form,
    origin: args.origin,
    title: clipWords(args.title, 120),
    description: args.description.trim().slice(0, 900),
    capacity,
    progress: 0,
    progressDay: day,
    ratePerDay: 0,
    milestones: Math.max(1, Math.round(args.milestones ?? 1)),
    milestonesFired: 0,
    deadlineDay: args.deadlineDay == null ? null : Math.max(day, Math.round(args.deadlineDay)),
    pulseDay: args.pulseDay == null ? null : Math.max(day, Math.round(args.pulseDay)),
    stake: args.stake ?? [],
    failStake: args.failStake ?? [],
    risk: args.risk ?? 'safe',
    tempo: args.tempo ?? 0,
    key: args.key ?? null,
    footprint: args.footprint ?? [],
    refs: [...new Set(args.refs ?? [])],
    parentId: args.parentId ?? null,
    bound: args.bound ?? null,
    atStake: Math.max(0, args.atStake ?? 0),
    plus: Boolean(args.plus),
    scale: args.scale ?? null,
    unattainable: args.unattainable ?? null,
    rollsFired: 0,
    projectId: args.projectId ?? null,
    siteId: args.siteId ?? null,
    profile: args.profile ?? null,
    deed: args.deed ?? null,
    script: args.script ?? null,
    outburst: args.outburst ?? null,
    dynamicId: args.dynamicId ?? null,
    status: 'active',
    createdDay: day,
    resolvedDay: null,
  };
}

export function activeFronts(city: Pick<City, 'fronts'>): Front[] {
  return city.fronts.filter((f) => f.status === 'active');
}

export function findFront(city: Pick<City, 'fronts'>, id: string): Front | null {
  return city.fronts.find((f) => f.id === id) ?? null;
}

/** Активные фронты, которые умрут вместе с этим: атомарные дела и привязанные осложнения. */
export function childFronts(city: Pick<City, 'fronts'>, frontId: string): Front[] {
  return city.fronts.filter((f) => f.status === 'active' && f.parentId === frontId);
}

// ───────────────────────────── прогресс ─────────────────────────────

export function progressAt(front: Front, day: number): number {
  if (front.status !== 'active') return front.progress;
  const elapsed = Math.max(0, day - front.progressDay);
  return Math.max(0, Math.min(front.capacity, front.progress + front.ratePerDay * elapsed));
}

/** Зафиксировать прогресс на день `day`. Зовётся перед любой сменой скорости. */
export function settleProgress(front: Front, day: number): number {
  const now = Math.max(front.progressDay, Math.round(day));
  front.progress = progressAt(front, now);
  front.progressDay = now;
  return front.progress;
}

/** Пройденная доля пути, 0..1. */
export function shareDone(front: Front, day: number): number {
  return front.capacity > 0 ? Math.min(1, progressAt(front, day) / front.capacity) : 0;
}

export function milestoneThreshold(front: Pick<Front, 'capacity' | 'milestones'>, index: number): number {
  return (front.capacity * Math.max(0, Math.min(front.milestones, index))) / front.milestones;
}

/** Пока жива привязанная угроза, родитель стоит. */
export function isFrozen(city: Pick<City, 'fronts'>, front: Pick<Front, 'id'>): boolean {
  return city.fronts.some(
    (f) => f.status === 'active' && f.parentId === front.id && f.form === 'threat' && (f.bound === 'rollback' || f.bound === 'cancel'),
  );
}

/** Сумма рычагов темпа: проект, поручение, характер ведущего. */
export function tempoSum(city: Pick<City, 'assignments' | 'officers'>, front: Pick<Front, 'id' | 'tempo'>): number {
  const lead = leadOf(city, front.id);
  if (!lead) return front.tempo;
  const officer = officerOf(city, lead);
  return front.tempo + lead.tempo + (officer ? temperTempo(officer.temper) : 0);
}

/** Пересчитать скорость фронта: работа ведущего плюс помощники минус помехи. */
export function recomputeRate(rules: Rules, city: City, front: Front, day: number): number {
  settleProgress(front, day);
  if (front.status !== 'active' || front.form === 'clock' || isFrozen(city, front)) {
    front.ratePerDay = 0;
    return 0;
  }
  let rate = 0;
  const lead = leadOf(city, front.id);
  const officer = lead ? officerOf(city, lead) : null;
  if (lead && officer) {
    rate += leadRatePerDay(rules, {
      verdict: lead.verdict,
      tempoSum: tempoSum(city, front),
      fit: officerFit(rules, city, officer, front.profile),
    });
  }
  for (const obj of attachedTo(city, front.id)) rate += attachRatePerDay(rules, obj.attach?.rate ?? 0, front.tempo);
  front.ratePerDay = Math.max(0, rate);
  return front.ratePerDay;
}

/** Откат на веху: прогресс возвращается к предыдущему порогу. */
export function rollbackMilestone(front: Front, day: number): void {
  settleProgress(front, day);
  const back = Math.max(0, front.milestonesFired - 1);
  front.progress = Math.min(front.progress, milestoneThreshold(front, back));
  front.milestonesFired = back;
}

// ───────────────────────────── события ─────────────────────────────

export type FrontDue = 'milestone' | 'completion' | 'deadline' | 'pulse';

/** Что у фронта наступило к дню `day`. Работа важнее срока: успел в последний день — успел. */
export function dueEvent(front: Front, day: number): FrontDue | null {
  if (front.status !== 'active') return null;
  if (front.capacity > 0 && front.milestonesFired < front.milestones) {
    const next = front.milestonesFired + 1;
    if (progressAt(front, day) + EPS >= milestoneThreshold(front, next)) return next >= front.milestones ? 'completion' : 'milestone';
  }
  if (front.deadlineDay != null && front.deadlineDay <= day) return 'deadline';
  if (front.pulseDay != null && front.pulseDay <= day) return 'pulse';
  return null;
}

/** День ближайшего события фронта при нынешней скорости. */
export function nextEventDay(front: Front): number | null {
  if (front.status !== 'active') return null;
  const days: number[] = [];
  if (front.capacity > 0 && front.milestonesFired < front.milestones) {
    const need = milestoneThreshold(front, front.milestonesFired + 1) - front.progress;
    if (need <= EPS) days.push(front.progressDay);
    else if (front.ratePerDay > 0) days.push(front.progressDay + Math.ceil(need / front.ratePerDay - EPS));
  }
  if (front.deadlineDay != null) days.push(front.deadlineDay);
  if (front.pulseDay != null) days.push(front.pulseDay);
  return days.length ? Math.min(...days) : null;
}

/** Сколько дней работы осталось при нынешней скорости. null — фронт стоит. */
export function daysLeft(front: Front, day: number): number | null {
  if (front.capacity <= 0) return front.deadlineDay == null ? null : Math.max(0, front.deadlineDay - day);
  if (!(front.ratePerDay > 0)) return null;
  return Math.max(0, Math.ceil((front.capacity - progressAt(front, day)) / front.ratePerDay - EPS));
}

// ───────────────────────────── соседство ─────────────────────────────

/** Все объекты, которых фронт касается: отпечаток, участники, цели ставок, место работ. */
export function frontObjectIds(front: Front): string[] {
  const ids = new Set<string>([...front.footprint.map((f) => f.objectId), ...front.refs]);
  if (front.siteId) ids.add(front.siteId);
  for (const op of [...front.stake, ...front.failStake]) {
    if ('target' in op) ids.add(op.target);
    if (op.op === 'link') {
      ids.add(op.a);
      ids.add(op.b);
    }
  }
  return [...ids];
}

/** Соседи: активные фронты с общим объектом. */
export function neighbors(city: Pick<City, 'fronts'>, front: Front): Front[] {
  const mine = new Set(frontObjectIds(front));
  return activeFronts(city).filter((f) => f.id !== front.id && frontObjectIds(f).some((id) => mine.has(id)));
}

// ───────────────────────────── занятость и конец ─────────────────────────────

/** Занять объекты отпечатка с отношением occupies. Уже занятый другим делом объект остаётся за ним. */
export function occupyFootprint(city: Pick<City, 'objects'>, front: Front): string[] {
  const taken: string[] = [];
  for (const entry of front.footprint) {
    if (entry.relation !== 'occupies') continue;
    const obj = findObject(city, entry.objectId);
    if (!obj || obj.status !== 'active' || obj.occupiedBy) continue;
    obj.occupiedBy = front.id;
    taken.push(obj.id);
  }
  return taken;
}

export function releaseOccupied(city: Pick<City, 'objects'>, frontId: string): void {
  for (const obj of city.objects) if (obj.occupiedBy === frontId) obj.occupiedBy = null;
}

const OUTCOME: Record<Exclude<Front['status'], 'active'>, 'done' | 'failed' | 'cancelled'> = { done: 'done', failed: 'failed', cancelled: 'cancelled' };

/**
 * Закрыть фронт: ведущий свободен, занятые объекты свободны, временные помощники и помехи исчезают,
 * дочерние фронты (атомарные дела, привязанные осложнения) умирают вместе с ним.
 * Место работ исчезает, если фронт завершён или провален; при отмене остаётся в городе без вклада.
 */
export function closeFront(
  rules: Rules,
  city: City,
  front: Front,
  status: Exclude<Front['status'], 'active'>,
  day: number,
  opts: { outcome?: Extract<Change, { kind: 'front_closed' }>['outcome'] } = {},
): Change[] {
  if (front.status !== 'active') return [];
  const changes: Change[] = [];
  settleProgress(front, day);
  front.status = status;
  front.resolvedDay = Math.max(0, Math.round(day));
  front.ratePerDay = 0;
  front.pulseDay = null;
  changes.push({ kind: 'front_closed', frontId: front.id, title: frontGist(front), outcome: opts.outcome ?? OUTCOME[status] });

  const lead = leadOf(city, front.id);
  if (lead) closeAssignment(city, lead, day);
  releaseOccupied(city, front.id);

  for (const obj of attachedTo(city, front.id)) {
    if (obj.temporary) {
      deleteObject(obj, day);
      changes.push({ kind: 'object_removed', objectId: obj.id, name: obj.name, points: rawToPoints(city, obj.statEffect), hidden: obj.hidden });
    } else {
      obj.attach = null;
    }
  }
  const site = front.siteId ? findObject(city, front.siteId) : null;
  if (site && site.status === 'active') {
    if (status === 'cancelled') {
      site.temporary = false;
    } else {
      deleteObject(site, day);
    }
  }
  for (const child of childFronts(city, front.id)) changes.push(...closeFront(rules, city, child, 'cancelled', day));
  recomputeStats(city, rules);
  return changes;
}

/**
 * Как о фронте говорят агенты: словами того, что происходит, без заголовка.
 * Заголовок фронта нужен только людям в отладке; агенты имеют дело с событиями.
 */
export function frontGist(front: Pick<Front, 'title' | 'description'>): string {
  const text = (front.description || front.title).trim();
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return clipWords(first, 140).replace(/[.!]+$/, '');
}
