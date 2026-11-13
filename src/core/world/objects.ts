/**
 * Объекты мира: устойчивые части города со своей историей версий.
 */

import { emptyStatMap, STAT_IDS, type ObjectType, type Rules, type Scale, type StatMap } from '../rules.js';
import type { City, Pull, WorldObject } from '../city.js';

function clip(text: string, max: number): string {
  return text.trim().slice(0, max);
}

export function normalizeStatEffect(raw: Partial<Record<string, unknown>> | null | undefined): StatMap {
  const out = emptyStatMap();
  if (!raw) return out;
  for (const id of STAT_IDS) {
    const n = Number(raw[id]);
    out[id] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

export function createObject(
  rules: Rules,
  args: {
    id: string;
    type: ObjectType;
    name: string;
    description: string;
    statEffect?: Partial<StatMap>;
    refs?: string[];
    day: number;
    protected?: boolean;
    parentId?: string | null;
    hidden?: boolean;
    temporary?: boolean;
    attach?: { frontId: string; rate: number } | null;
  },
): WorldObject {
  const limits = rules.fronts.objects;
  const name = clip(args.name, limits.nameMax);
  if (!name) throw new Error('у объекта нет имени');
  const description = clip(args.description, limits.descriptionMax);
  const effect = normalizeStatEffect(args.statEffect);
  const day = Math.max(0, Math.round(args.day));
  return {
    id: args.id,
    type: args.type,
    name,
    description,
    statEffect: effect,
    refs: [...new Set((args.refs ?? []).map((r) => r.trim()).filter(Boolean))],
    version: 1,
    versions: [{ version: 1, description, statEffect: { ...effect }, createdDay: day }],
    status: 'active',
    createdDay: day,
    deletedDay: null,
    protected: Boolean(args.protected),
    parentId: args.parentId ?? null,
    hidden: Boolean(args.hidden),
    occupiedBy: null,
    temporary: Boolean(args.temporary),
    attach: args.attach ?? null,
    themes: [],
    freshDay: day,
  };
}

/** Новая полная версия объекта. Прежние остаются в истории. */
export function addObjectVersion(
  rules: Rules,
  obj: WorldObject,
  args: { description: string; statEffect: Partial<StatMap>; day: number },
): WorldObject {
  const version = obj.version + 1;
  const description = clip(args.description, rules.fronts.objects.descriptionMax);
  const statEffect = normalizeStatEffect(args.statEffect);
  obj.versions.push({ version, description, statEffect: { ...statEffect }, createdDay: Math.round(args.day) });
  obj.version = version;
  obj.description = description;
  obj.statEffect = statEffect;
  obj.freshDay = Math.max(0, Math.round(args.day));
  return obj;
}

export function deleteObject(obj: WorldObject, day: number): WorldObject {
  obj.status = 'deleted';
  obj.deletedDay = Math.max(0, Math.round(day));
  return obj;
}

export function activeObjects(city: Pick<City, 'objects'>): WorldObject[] {
  return city.objects.filter((o) => o.status === 'active');
}

/** То, что видят жрец и игрок: активные и не скрытые. */
export function visibleObjects(city: Pick<City, 'objects'>): WorldObject[] {
  return city.objects.filter((o) => o.status === 'active' && !o.hidden);
}

/** Удалить объект вместе со всем, что в него вложено. Возвращает удалённые. */
export function deleteWithChildren(city: Pick<City, 'objects'>, obj: WorldObject, day: number): WorldObject[] {
  const removed: WorldObject[] = [];
  const walk = (o: WorldObject) => {
    if (o.status !== 'active') return;
    deleteObject(o, day);
    removed.push(o);
    for (const child of city.objects) if (child.parentId === o.id) walk(child);
  };
  walk(obj);
  return removed;
}

/** Помощники и помехи фронта. */
export function attachedTo(city: Pick<City, 'objects'>, frontId: string): WorldObject[] {
  return city.objects.filter((o) => o.status === 'active' && o.attach?.frontId === frontId);
}

/** Объекты, связанные с данным: в любую сторону. */
export function linkedObjects(city: Pick<City, 'objects'>, obj: WorldObject): WorldObject[] {
  return city.objects.filter((o) => o.status === 'active' && o.id !== obj.id && (o.refs.includes(obj.id) || obj.refs.includes(o.id)));
}

export function isFresh(obj: Pick<WorldObject, 'freshDay'>, day: number, freshDays: number): boolean {
  return day - obj.freshDay <= freshDays;
}

export function findObject(city: Pick<City, 'objects'>, id: string): WorldObject | null {
  return city.objects.find((o) => o.id === id) ?? null;
}

/** Тяга объекта на этот день: метка истории слабеет линейно до нуля за свой срок. */
export function pullOf(obj: Pick<WorldObject, 'pull'>, day: number): number {
  const p = obj.pull;
  if (!p) return 0;
  if (p.days == null) return p.level;
  return Math.max(0, p.level * (1 - Math.max(0, day - p.day) / p.days));
}

/** Тяга, которую история такого масштаба даёт своим объектам. */
export function scalePull(rules: Rules, scale: Scale | null | undefined, day: number): Pull | null {
  if (!scale) return null;
  const row = rules.seeding.scale[scale];
  return row.pull > 0 ? { level: row.pull, day, days: row.pullDays } : null;
}

/** Пометить объект тягой, если новая сильнее той, что на нём сейчас. */
export function tug(obj: WorldObject, pull: Pull | null | undefined): void {
  if (pull && pull.level >= pullOf(obj, pull.day)) obj.pull = { ...pull };
}
