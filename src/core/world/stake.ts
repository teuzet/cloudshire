/**
 * Ставка — закрытый список операций над городом. Исполняет только этот файл.
 * Вклады в операциях заданы в пунктах стата; в сырые единицы объектов их переводит core.
 */

import type { Rules } from '../rules.js';
import type { City, StakeOp } from '../city.js';
import { addFact } from '../lore.js';
import type { Change } from './changes.js';
import { closeFront, findFront, rollbackMilestone, settleProgress } from './fronts.js';
import { diffPoints, pointsToRaw, rawToPoints } from './numbers.js';
import { addObjectVersion, createObject, deleteWithChildren, findObject } from './objects.js';
import { addToLedger, recomputeStats } from './stats.js';

export interface StakeResult {
  changes: Change[];
  /** Объект, созданный операцией с пометкой result. */
  resultId: string | null;
}

/**
 * Применить операции ставки. Операция, цель которой исчезла, молча пропускается:
 * мир мог измениться, пока фронт шёл. `modify` сюда приходить не должна — поток
 * заранее превращает её в `revalue`.
 */
export function applyStake(
  rules: Rules,
  city: City,
  ops: readonly StakeOp[],
  ctx: { day: number; newId: (prefix: string) => string; frontId?: string | null },
): StakeResult {
  const changes: Change[] = [];
  let resultId: string | null = null;
  const day = Math.max(0, Math.round(ctx.day));

  for (const op of ops) {
    switch (op.op) {
      case 'create': {
        const refs = (op.object.refs ?? []).filter((id) => findObject(city, id)?.status === 'active');
        const parent = op.object.parentId ? findObject(city, op.object.parentId) : null;
        const obj = createObject(rules, {
          id: ctx.newId('obj'),
          type: op.object.type,
          name: op.object.name,
          description: op.object.description,
          statEffect: pointsToRaw(city, op.object.points),
          refs,
          parentId: parent?.status === 'active' ? parent.id : null,
          hidden: op.object.hidden,
          day,
        });
        city.objects.push(obj);
        if (op.result) resultId = obj.id;
        changes.push({ kind: 'object_created', objectId: obj.id, name: obj.name, type: obj.type, points: { ...op.object.points }, temporary: false, hidden: obj.hidden });
        break;
      }
      case 'revalue': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active') break;
        const before = rawToPoints(city, obj.statEffect);
        const description = op.description?.trim() || obj.description;
        const rewritten = description !== obj.description;
        addObjectVersion(rules, obj, { description, statEffect: pointsToRaw(city, op.points), day });
        changes.push({ kind: 'object_changed', objectId: obj.id, name: obj.name, delta: diffPoints(op.points, before), description: rewritten ? obj.description : null });
        break;
      }
      case 'modify':
        break;
      case 'delete': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active' || obj.protected) break;
        for (const gone of deleteWithChildren(city, obj, day)) {
          changes.push({ kind: 'object_removed', objectId: gone.id, name: gone.name, points: rawToPoints(city, gone.statEffect), hidden: gone.hidden });
        }
        break;
      }
      case 'reveal': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active' || !obj.hidden) break;
        obj.hidden = false;
        obj.freshDay = day;
        changes.push({ kind: 'object_revealed', objectId: obj.id, name: obj.name });
        break;
      }
      case 'fact': {
        const added = addFact(city, { id: ctx.newId('fact'), text: op.text, day, frontId: ctx.frontId ?? null, author: 'event' });
        if (added.ok) changes.push({ kind: 'fact', text: added.fact.text });
        break;
      }
      case 'link': {
        const a = findObject(city, op.a);
        const b = findObject(city, op.b);
        if (!a || !b || a.id === b.id || a.status !== 'active' || b.status !== 'active') break;
        if (!a.refs.includes(b.id)) a.refs.push(b.id);
        changes.push({ kind: 'linked', a: a.id, b: b.id, names: [a.name, b.name] });
        break;
      }
      case 'progress': {
        const front = findFront(city, op.frontId);
        if (!front || front.status !== 'active' || front.capacity <= 0) break;
        settleProgress(front, day);
        front.progress = Math.min(front.capacity, front.progress + Math.max(0, op.amount));
        changes.push({ kind: 'front_moved', frontId: front.id, title: front.title, how: 'pushed' });
        break;
      }
      case 'rollback': {
        const front = findFront(city, op.frontId);
        if (!front || front.status !== 'active') break;
        rollbackMilestone(front, day);
        changes.push({ kind: 'front_moved', frontId: front.id, title: front.title, how: 'rollback' });
        break;
      }
      case 'cancel': {
        const front = findFront(city, op.frontId);
        if (!front || front.status !== 'active') break;
        changes.push(...closeFront(rules, city, front, 'cancelled', day));
        break;
      }
      case 'attach': {
        const front = findFront(city, op.frontId);
        if (!front || front.status !== 'active') break;
        const obj = createObject(rules, {
          id: ctx.newId('obj'),
          type: op.object.type,
          name: op.object.name,
          description: op.object.description,
          statEffect: pointsToRaw(city, op.object.points),
          parentId: front.siteId,
          temporary: true,
          attach: { frontId: front.id, rate: op.rate },
          day,
        });
        city.objects.push(obj);
        changes.push({ kind: 'object_created', objectId: obj.id, name: obj.name, type: obj.type, points: { ...op.object.points }, temporary: true, hidden: false });
        changes.push({ kind: 'front_moved', frontId: front.id, title: front.title, how: op.rate < 0 ? 'slowed' : 'helped' });
        break;
      }
      case 'stats': {
        addToLedger(city, op.points, rules);
        changes.push({ kind: 'stats', points: { ...op.points } });
        break;
      }
    }
  }
  recomputeStats(city, rules);
  return { changes, resultId };
}

/** Есть ли в ставке операция, которую поток обязан сначала развернуть агентами. */
export function hasModify(ops: readonly StakeOp[]): boolean {
  return ops.some((op) => op.op === 'modify');
}
