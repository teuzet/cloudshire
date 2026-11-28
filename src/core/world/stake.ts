/**
 * Ставка — закрытый список операций над городом. Исполняет только этот файл.
 * Вклады в операциях заданы в пунктах стата; в сырые единицы объектов их переводит core.
 */

import { STAT_IDS, type Rules, type StatMap } from '../rules.js';
import type { City, Pull, StakeOp, WorldObject } from '../city.js';
import { addFact } from '../lore.js';
import type { Change } from './changes.js';
import { closeFront, findFront, frontGist, rollbackMilestone, settleProgress, withOuter } from './fronts.js';
import { diffPoints, pointsToRaw, rawToPoints } from './numbers.js';
import { addObjectVersion, createObject, deleteWithChildren, findObject, isSide, tug } from './objects.js';
import { applyHindrance, feasibleEffect, liftHindrance } from './hindrance.js';
import { hiddenAbout } from './hidden.js';
import { holdFront, objectsGone, releaseFront } from './links.js';
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
  ctx: { day: number; newId: (prefix: string) => string; frontId?: string | null; /** Ставку исполняет случившаяся беда: её имя. Беда выводит объекты из строя, а не стирает. */ trouble?: string | null; /** Тяга истории: ложится на всё, что ставка породила или изменила. */ pull?: Pull | null },
): StakeResult {
  const changes: Change[] = [];
  let resultId: string | null = null;
  const day = Math.max(0, Math.round(ctx.day));

  const zero = (): StatMap => ({ prosperity: 0, security: 0, knowledge: 0, influence: 0 });
  const keeps = (obj: WorldObject) => rules.fronts.objects.keepLost.includes(obj.type) && !obj.temporary && !obj.hidden;
  /** Вывести объект из строя: вклад снят (минус остаётся минусом), прежний запомнен. */
  const retire = (obj: WorldObject, points: StatMap, description: string, cause: string) => {
    const before = rawToPoints(city, obj.statEffect);
    obj.out = { day, cause, was: obj.out?.was ?? { ...before } };
    addObjectVersion(rules, obj, { description, statEffect: pointsToRaw(city, points), day });
    changes.push({ kind: 'object_out', objectId: obj.id, name: obj.name, delta: diffPoints(points, before) });
    changes.push(...objectsGone(rules, city, [obj], day));
  };
  /** Отчего ушло: случившаяся беда или дело, которое это сделало. */
  const cause = (): string => {
    const front = ctx.frontId ? findFront(city, ctx.frontId) : null;
    return ctx.trouble ?? (front ? frontGist(front) : 'перемена в городе');
  };
  /**
   * Стереть объект со всем вложенным; что на них жило, кончилось, что они держали, идёт как прежде.
   * Стороны не стираются, а уходят из города: разбитые, изгнанные, улетевшие помнят, что с ними было.
   */
  const remove = (obj: WorldObject) => {
    if (obj.attach) liftHindrance(findFront(city, obj.attach.frontId), obj);
    const gone = deleteWithChildren(city, obj, day);
    for (const o of gone) if (isSide(o) && !o.out) o.out = { day, cause: cause(), was: { ...rawToPoints(city, o.statEffect) }, forever: true };
    for (const o of gone) changes.push({ kind: 'object_removed', objectId: o.id, name: o.name, points: rawToPoints(city, o.statEffect), hidden: o.hidden });
    changes.push(...objectsGone(rules, city, gone, day));
    return gone;
  };

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
        tug(obj, ctx.pull);
        city.objects.push(obj);
        if (op.result) resultId = obj.id;
        changes.push({ kind: 'object_created', objectId: obj.id, name: obj.name, type: obj.type, points: { ...op.object.points }, temporary: false, hidden: obj.hidden });
        for (const spec of op.object.holds ?? []) changes.push(...holdFront(rules, city, obj, spec, day));
        break;
      }
      case 'revalue': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active') break;
        const before = rawToPoints(city, obj.statEffect);
        const description = op.description?.trim() || obj.description;
        tug(obj, ctx.pull);
        // Беда, которая отняла у объекта всё, что он давал, выводит его из строя.
        const gave = STAT_IDS.some((id) => before[id] > 0);
        const gives = STAT_IDS.some((id) => op.points[id] > 0);
        if (ctx.trouble && gave && !gives && !obj.out && keeps(obj)) {
          retire(obj, op.points, description, ctx.trouble);
          break;
        }
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
        if (ctx.trouble && keeps(obj)) {
          tug(obj, ctx.pull);
          if (!obj.out) retire(obj, zero(), obj.description, ctx.trouble);
          break;
        }
        remove(obj);
        break;
      }
      case 'retire': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active' || obj.protected) break;
        if (op.forever) {
          // Ушло навсегда вместе со всем вложенным: в городе этого больше нет, остаётся только память.
          const cause = obj.out?.cause ?? ctx.trouble ?? 'беда';
          for (const gone of remove(obj)) {
            if (!keeps(gone) && !gone.out) continue;
            gone.out = { day: gone.out?.day ?? day, cause: gone.out?.cause ?? cause, was: gone.out?.was ?? { ...rawToPoints(city, gone.statEffect) }, forever: true };
          }
          break;
        }
        if (obj.out) break;
        if (keeps(obj)) retire(obj, zero(), obj.description, ctx.trouble ?? 'беда');
        else remove(obj);
        break;
      }
      case 'hold': {
        const obj = findObject(city, op.target);
        if (!obj) break;
        changes.push(...holdFront(rules, city, obj, op, day));
        break;
      }
      case 'release': {
        const obj = findObject(city, op.target);
        if (obj) changes.push(...releaseFront(rules, city, obj, op.frontId, op.effect, day));
        break;
      }
      case 'restore': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active' || !obj.out) break;
        const before = rawToPoints(city, obj.statEffect);
        const description = op.description?.trim() || obj.description;
        const rewritten = description !== obj.description;
        const points = obj.out.was;
        obj.out = null;
        tug(obj, ctx.pull);
        addObjectVersion(rules, obj, { description, statEffect: pointsToRaw(city, points), day });
        changes.push({ kind: 'object_back', objectId: obj.id, name: obj.name, delta: diffPoints(points, before), description: rewritten ? obj.description : null });
        break;
      }
      case 'move': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active' || obj.out) break;
        const to = op.parentId ? findObject(city, op.parentId) : null;
        // Место должно быть в городе и не лежать внутри самого объекта.
        if (op.parentId && (!to || to.status !== 'active' || withOuter(city, [to.id]).has(obj.id))) break;
        if ((obj.parentId ?? null) === (to?.id ?? null)) break;
        const from = obj.parentId ? findObject(city, obj.parentId) : null;
        obj.parentId = to?.id ?? null;
        tug(obj, ctx.pull);
        changes.push({ kind: 'object_moved', objectId: obj.id, name: obj.name, from: from?.name ?? null, to: to?.name ?? null });
        break;
      }
      case 'reveal': {
        const obj = findObject(city, op.target);
        if (!obj || obj.status !== 'active' || !obj.hidden) break;
        obj.hidden = false;
        obj.freshDay = day;
        tug(obj, ctx.pull);
        changes.push({ kind: 'object_revealed', objectId: obj.id, name: obj.name, description: obj.description });
        break;
      }
      case 'uncover': {
        // Что открыть, решает код в день готовности: за время работы скрытое могло открыться само.
        const next = hiddenAbout(city, { frontId: op.frontId, objectId: op.objectId })[0];
        if (!next) break;
        if (next.kind === 'object') {
          changes.push(...applyStake(rules, city, [{ op: 'reveal', target: next.objectId }], ctx).changes);
          break;
        }
        const clue = findFront(city, next.frontId)?.script?.clues.find((c) => c.id === next.clueId);
        if (clue) clue.revealed = true;
        const added = addFact(city, { id: ctx.newId('fact'), text: next.fact, day, frontId: next.frontId, author: 'event' });
        if (added.ok) changes.push({ kind: 'fact', text: added.fact.text });
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
        const trouble = front.form === 'threat' || front.form === 'tension';
        changes.push({ kind: 'front_moved', frontId: front.id, title: frontGist(front), how: trouble && front.progress < front.capacity ? 'eased' : 'pushed' });
        break;
      }
      case 'rollback': {
        const front = findFront(city, op.frontId);
        if (!front || front.status !== 'active') break;
        rollbackMilestone(front, day);
        changes.push({ kind: 'front_moved', frontId: front.id, title: frontGist(front), how: 'rollback' });
        break;
      }
      case 'cancel': {
        const front = findFront(city, op.frontId);
        if (!front || front.status !== 'active') break;
        changes.push(...closeFront(rules, city, front, 'cancelled', day));
        break;
      }
      case 'end': {
        const front = findFront(city, op.frontId);
        if (!front || front.status !== 'active') break;
        // Беда лишилась причины: это успех города. Случай и поиск просто пропадают.
        const trouble = !front.plus && (front.form === 'threat' || front.form === 'tension');
        changes.push(...closeFront(rules, city, front, trouble ? 'done' : 'cancelled', day, { outcome: trouble ? 'solved' : front.plus ? 'expired' : 'gone', cause: op.cause }));
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
          attach: op.rate < 0
            ? { frontId: front.id, rate: op.rate, effect: feasibleEffect(front, op.effect), counters: op.counters ?? [], answered: false }
            : { frontId: front.id, rate: op.rate },
          day,
        });
        city.objects.push(obj);
        applyHindrance(rules, front, obj, day);
        changes.push({ kind: 'object_created', objectId: obj.id, name: obj.name, type: obj.type, points: { ...op.object.points }, temporary: true, hidden: false });
        changes.push({ kind: 'front_moved', frontId: front.id, title: frontGist(front), how: op.rate < 0 ? 'slowed' : 'helped' });
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
