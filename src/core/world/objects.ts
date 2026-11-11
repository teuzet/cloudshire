/**
 * Объекты мира: устойчивые части города со своей историей версий.
 */

import { emptyStatMap, STAT_IDS, type ObjectType, type Rules, type StatMap } from '../rules.js';
import type { City, WorldObject } from '../city.js';

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

export function findObject(city: Pick<City, 'objects'>, id: string): WorldObject | null {
  return city.objects.find((o) => o.id === id) ?? null;
}
