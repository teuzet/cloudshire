/**
 * Словарь динамик и режиссёрский жребий. Моделей здесь нет.
 *
 * Запись словаря — скелет осложнения без конкретики города. Код отбирает записи по моменту,
 * тяжести и отпечатку дела, раскладывает их на пары «запись и объект» и перемешивает с весами.
 * Поток спрашивает Примерщика по порядку и берёт первую подошедшую пару: это тот же взвешенный
 * жребий среди подошедших, только без лишних вопросов.
 */

import type { Dynamic, Rules, Shape } from '../rules.js';
import type { City, Front, WorldObject } from '../city.js';
import type { Rng } from '../random.js';
import { leadOf } from './assignments.js';
import { riskRank } from './numbers.js';
import { dynamicTags, varietyWeight } from './director.js';
import { attachedTo, findObject, isFresh, linkedObjects, visibleObjects } from './objects.js';

export type Moment = 'milestone' | 'completion' | 'failure';
export type RollKind = 'light' | 'heavy' | 'plus';

export interface Candidate {
  dynamic: Dynamic;
  /** Объект в роли. null — роль играет само место работ. */
  object: WorldObject | null;
  /** Как дело касается объекта: причина из отпечатка или слова кода. */
  touch: string;
  shape: Shape;
}

/** Во что запись выливается при такой тяжести. null — запись такой тяжести не умеет. */
export function shapeFor(dynamic: Dynamic, kind: RollKind): Shape | null {
  if (kind === 'plus') return dynamic.class === 'plus' ? (dynamic.light ?? dynamic.heavy) : null;
  if (dynamic.class === 'plus') return null;
  return kind === 'light' ? dynamic.light : dynamic.heavy;
}

/** Что задела беда: её участники и цели её ставок. */
function struckIds(front: Front): string[] {
  const ids = new Set(front.refs);
  for (const op of [...front.failStake, ...front.stake]) if ('target' in op && typeof op.target === 'string') ids.add(op.target);
  return [...ids];
}

function roleObjects(city: City, front: Front, dynamic: Dynamic, resultId: string | null): Array<{ object: WorldObject | null; touch: string }> {
  const out: Array<{ object: WorldObject | null; touch: string }> = [];
  const seen = new Set<string>();
  const push = (object: WorldObject | null, touch: string) => {
    if (object) {
      if (object.status !== 'active' || seen.has(object.id)) return;
      if (dynamic.types.length && !dynamic.types.includes(object.type)) return;
      seen.add(object.id);
    }
    out.push({ object, touch });
  };
  for (const source of dynamic.from) {
    switch (source) {
      case 'occupies':
      case 'linked':
      case 'pressures':
      case 'benefits':
        for (const entry of front.footprint) {
          if (entry.relation !== source) continue;
          const obj = findObject(city, entry.objectId);
          if (obj && !obj.hidden) push(obj, entry.reason || source);
        }
        break;
      case 'helper':
        for (const obj of attachedTo(city, front.id)) if ((obj.attach?.rate ?? 0) > 0) push(obj, 'помогает работе и занят на ней');
        break;
      case 'site':
        push(null, 'само место работ');
        break;
      case 'result': {
        const obj = resultId ? findObject(city, resultId) : null;
        if (obj) push(obj, 'это и есть готовый результат');
        break;
      }
      case 'struck':
        for (const id of struckIds(front)) {
          const obj = findObject(city, id);
          if (obj && !obj.hidden) push(obj, 'по этому ударила беда');
        }
        break;
      case 'nearby': {
        const inFootprint = new Set([...front.footprint.map((f) => f.objectId), ...struckIds(front)]);
        for (const id of inFootprint) {
          const base = findObject(city, id);
          if (!base || base.status !== 'active') continue;
          for (const near of linkedObjects(city, base)) {
            if (inFootprint.has(near.id) || near.hidden || near.temporary || near.id === resultId) continue;
            push(near, `рядом с тем, что затронуто работой: ${base.name}`);
          }
        }
        break;
      }
      case 'same-type': {
        const result = resultId ? findObject(city, resultId) : null;
        if (!result) break;
        for (const obj of visibleObjects(city)) {
          if (obj.id !== result.id && obj.type === result.type && !obj.temporary) push(obj, `служит тому же, что и новое: ${result.name}`);
        }
        break;
      }
    }
  }
  return out;
}

/** Та же беда с тем же участником не открывается второй раз, пока первая жива. */
function alreadyRunning(city: City, front: Front, dynamic: Dynamic, object: WorldObject | null): boolean {
  return city.fronts.some(
    (f) => f.status === 'active' && f.dynamicId === dynamic.id && (object ? f.refs.includes(object.id) : f.parentId === front.id),
  );
}

/** Пары «запись и объект», которые подходят технически: момент, тяжесть, ступень, отпечаток. */
export function candidates(
  rules: Rules,
  city: City,
  front: Front,
  q: { moment: Moment; kind: RollKind; sideOnly?: boolean; resultId?: string | null },
): Candidate[] {
  const out: Candidate[] = [];
  const hasLead = Boolean(leadOf(city, front.id));
  for (const dynamic of rules.fronts.dynamics) {
    if (!dynamic.enabled || !dynamic.when.includes(q.moment)) continue;
    const shape = shapeFor(dynamic, q.kind);
    if (!shape) continue;
    if (q.sideOnly && dynamic.class === 'bound') continue;
    if (dynamic.requires === 'noLead' && hasLead) continue;
    if (dynamic.hits === 'result' && !q.resultId) continue;
    if (q.kind !== 'plus' && riskRank(front.risk) < riskRank(dynamic.minStep)) continue;
    for (const role of roleObjects(city, front, dynamic, q.resultId ?? null)) {
      if (!alreadyRunning(city, front, dynamic, role.object)) out.push({ dynamic, shape, ...role });
    }
  }
  return out;
}

type DrawCity = Pick<City, 'dynamicsUsed' | 'storyLog' | 'fronts' | 'assignments'>;

/**
 * Вес пары: свежий объект получает больше внимания, давно не игравшая запись — тоже;
 * режиссёр делит вес за повтор осей и занятого сановника.
 */
export function candidateWeight(rules: Rules, city: DrawCity, c: Candidate, day: number): number {
  const d = rules.fronts.director;
  const fresh = c.object && isFresh(c.object, day, d.freshDays) ? d.freshWeight : 1;
  const last = city.dynamicsUsed[c.dynamic.id];
  const idle = last == null ? d.freshDays : Math.max(0, day - last);
  const recency = 1 + Math.min(2, (2 * idle) / d.freshDays);
  return fresh * recency * varietyWeight(rules, city, dynamicTags(c.dynamic), day);
}

/** Взвешенная перестановка: первый элемент — взвешенный жребий, второй — жребий среди оставшихся и так далее. */
export function weightedOrder<T>(items: readonly T[], weight: (item: T) => number, rng: Rng): T[] {
  const pool = items.map((item) => ({ item, w: Math.max(0, weight(item)) }));
  const out: T[] = [];
  while (pool.length) {
    const total = pool.reduce((acc, p) => acc + p.w, 0);
    let pick = 0;
    if (total > 0) {
      let roll = rng() * total;
      for (let i = 0; i < pool.length; i += 1) {
        roll -= pool[i]?.w ?? 0;
        if (roll < 0) {
          pick = i;
          break;
        }
        pick = i;
      }
    }
    const [taken] = pool.splice(pick, 1);
    if (taken) out.push(taken.item);
  }
  return out;
}

/** Порядок, в котором поток спрашивает Примерщика. Обрезан пределом вопросов. */
export function drawOrder(rules: Rules, city: DrawCity, list: readonly Candidate[], day: number, rng: Rng): Candidate[] {
  return weightedOrder(list, (c) => candidateWeight(rules, city, c, day), rng).slice(0, rules.fronts.director.fitterCalls);
}

/**
 * Что выпало на вехе. Кубик бросается по ступени риска и сумме рычагов темпа;
 * долю удобных случаев среди сработавших задаёт режиссёр.
 */
export function rollRisk(args: { chance: number; heavyShare: number; plusChance: number }, rng: Rng): RollKind | null {
  if (!(rng() < args.chance)) return null;
  if (rng() < args.plusChance) return 'plus';
  return rng() < args.heavyShare ? 'heavy' : 'light';
}
