/**
 * Долгие последствия: осложнения по броску риска, эхо по связям объектов и обновление идущих дел.
 *
 * Везде один порядок: код находит, кого касается, агент решает смысл одним ярлыком или
 * коротким текстом, код считает ёмкость, срок и ставку.
 */

import type { City, Front, StakeOp, StoryTags, WorldObject } from '../core/city.js';
import type { Dynamic, Shape, StatMap } from '../core/rules.js';
import { DAYS_PER_MONTH } from '../core/time.js';
import { leadOf } from '../core/world/assignments.js';
import { changedObjectIds, type Change } from '../core/world/changes.js';
import { plainTitle } from '../core/text.js';
import { accidentLoss, buildBound, buildOpportunity, buildSide, capSideHit, hindranceOp, type EventDress } from '../core/world/complications.js';
import { dynamicTags, leanOf, markStory, plusChance, roomForTrouble } from '../core/world/director.js';
import { candidates, drawOrder, rollRisk, type Candidate, type Moment, type RollKind } from '../core/world/dynamics.js';
import { refreshTargets } from '../core/world/echo.js';
import { closeFront, shareDone, tempoSum } from '../core/world/fronts.js';
import { complicationChance, diffPoints, dominantStat, magnitude, newObjectCapacity, rawToPoints } from '../core/world/numbers.js';
import { findObject } from '../core/world/objects.js';
import { applyStake } from '../core/world/stake.js';
import { themeNames } from '../core/world/themes.js';
import { judgeAlignment } from '../agents/alignment-judge/run.js';
import { dressEvent } from '../agents/costumer/run.js';
import { rewriteDescription } from '../agents/description-rewriter/run.js';
import { composeDynamic } from '../agents/dynamics-composer/run.js';
import { appraiseRisk } from '../agents/risk-appraiser/run.js';
import { fitRole } from '../agents/role-fitter/run.js';
import { appraise, briefOf, seal, situationOf, touchesOf, workWords } from './briefs.js';
import { namesUsed, newId, returnNames, takeNames, tryAgent, type FlowDeps } from './context.js';
import { faithEvent, willWords } from './fronts.js';

export interface Complication {
  changes: Change[];
  /** Суть для хроники: слух, с которым беда пришла к жрецу, или сама авария. */
  gist: string;
}

/** Что собрать: запись словаря или свободная динамика в одном виде. */
interface Plan {
  dynamicId: string | null;
  class: Dynamic['class'];
  shape: Shape;
  hits: Dynamic['hits'];
  object: WorldObject | null;
  touch: string;
  skeleton: string;
  helps: string;
  needsNew: boolean;
  newHidden: boolean;
  /** Оси для журнала режиссёра. */
  tags: StoryTags;
}

function tempoWords(sum: number): string {
  return sum > 0 ? 'Работа идёт в спешке.' : sum < 0 ? 'Работа идёт без спешки.' : '';
}

/** Спросить Примерщика по порядку жребия и взять первую подошедшую пару. */
async function pick(deps: FlowDeps, city: City, parent: Front, order: Candidate[]): Promise<Candidate | null> {
  for (const c of order) {
    if (!c.dynamic.condition) return c;
    const fit = await tryAgent(
      deps,
      'role-fitter',
      () =>
        fitRole(deps.agents, {
          question: c.dynamic.condition,
          subject: c.object ? `${c.object.name}: ${c.object.description}` : `Место работ: ${parent.title}`,
          context: [`${parent.title}. ${parent.description}`, tempoWords(tempoSum(city, parent)), `Как дело касается предмета: ${c.touch}`].filter(Boolean).join(' '),
        }),
      { fits: false, reason: '' },
    );
    if (fit.fits) return c;
  }
  return null;
}

/** Что уже мешает работе: живые беды при ней и помехи на ней. */
function runningAround(city: City, parent: Front): string[] {
  const fronts = city.fronts.filter((f) => f.status === 'active' && f.parentId === parent.id && f.origin === 'complication').map((f) => f.title);
  const hindrances = city.objects.filter((o) => o.status === 'active' && o.attach?.frontId === parent.id && o.attach.rate < 0).map((o) => `помеха: ${o.name}`);
  return [...fronts, ...hindrances];
}

/** Словарь не подошёл: Сочинитель динамики пишет свободную. Случай идёт в лог как пробел словаря. */
async function freePlan(deps: FlowDeps, city: City, parent: Front, q: { moment: Moment; sideOnly?: boolean }, day: number): Promise<Plan | null> {
  deps.log?.warn('dictionary_gap', { cityId: city.id, frontId: parent.id, moment: q.moment });
  // Режиссёр заказывает то, чего давно не было; в журнал идёт заказ: Сочинитель ему следует, если он ложится на работу.
  const lean = leanOf(deps.rules, city, day, deps.random.rng);
  const d = deps.rules.fronts.director;
  const free = await tryAgent(
    deps,
    'dynamics-composer',
    () => composeDynamic(deps.agents, {
        work: `${parent.title}. ${parent.description}`,
        share: shareDone(parent, day),
        touches: touchesOf(city, parent),
        running: runningAround(city, parent),
        lean: [lean.engine ? d.engines[lean.engine] : null, lean.source ? `причина: ${d.sources[lean.source]}` : null].filter((x): x is string => Boolean(x)),
      }),
    null,
  );
  if (!free) return null;
  const object = free.objectId ? findObject(city, free.objectId) : null;
  // Привязанная беда возможна, только пока дело идёт и только если её не запретили.
  const boundAllowed = q.moment === 'milestone' && !q.sideOnly && parent.status === 'active';
  let cls: Plan['class'] = free.target === 'deed' ? 'bound' : 'side';
  if (cls === 'bound' && !boundAllowed) cls = 'side';
  if (cls === 'side' && (!object || free.shape === 'hindrance')) {
    if (!boundAllowed) return null;
    cls = 'bound';
  }
  return {
    dynamicId: null,
    class: cls,
    shape: free.shape,
    hits: cls === 'bound' ? 'parent' : 'role',
    object,
    touch: touchesOf(city, parent).find((t) => t.id === object?.id)?.reason ?? 'затронуто работой',
    skeleton: free.skeleton,
    helps: free.helps,
    needsNew: free.shape === 'hindrance',
    newHidden: false,
    tags: { engine: lean.engine, source: lean.source, sphere: null, mystery: false },
  };
}

/** Если Оценщик вклада не увидел разницы, беда всё равно что-то значит: малый урон главному стату. */
function fallbackHit(deps: FlowDeps, before: StatMap): StatMap {
  const stat = dominantStat(before) ?? 'prosperity';
  return { ...before, [stat]: before[stat] - deps.rules.fronts.contribution.small };
}

/**
 * Собрать осложнение из выпавшего броска. Возвращает перемены и суть для хроники
 * или null, если собрать не из чего.
 */
export async function complicate(
  deps: FlowDeps,
  city: City,
  parent: Front,
  q: { moment: Moment; kind: RollKind; resultId?: string | null; sideOnly?: boolean },
  day: number,
): Promise<Complication | null> {
  const order = drawOrder(deps.rules, city, candidates(deps.rules, city, parent, q), day, deps.random.rng);
  const chosen = await pick(deps, city, parent, order);
  let plan: Plan | null = chosen
    ? {
        dynamicId: chosen.dynamic.id,
        class: chosen.dynamic.class,
        shape: chosen.shape,
        hits: chosen.dynamic.hits,
        object: chosen.object,
        touch: chosen.touch,
        skeleton: chosen.dynamic.skeleton,
        helps: chosen.dynamic.helps,
        needsNew: chosen.dynamic.needsNew,
        newHidden: chosen.dynamic.newHidden,
        tags: dynamicTags(chosen.dynamic),
      }
    : null;
  if (!plan) {
    if (q.kind === 'plus') return null;
    plan = await freePlan(deps, city, parent, q, day);
    if (!plan) return null;
    // Свободная беда вокруг того, вокруг чего уже идёт живая беда, повторила бы её другими словами.
    const objectId = plan.object?.id;
    if (objectId && city.fronts.some((f) => f.status === 'active' && f.origin === 'complication' && f.refs.includes(objectId))) return null;
  }

  const names = plan.needsNew ? await takeNames(deps, deps.rules.seeding.namesPerCall) : [];
  const role = plan.object;
  const costume = await tryAgent(
    deps,
    'costumer',
    () =>
      dressEvent(deps.agents, {
        skeleton: plan.skeleton,
        shape: plan.shape,
        cause: `${parent.title}. ${workWords(parent)}`,
        actor: role ? { object: briefOf(role), touch: plan.touch } : null,
        themes: themeNames(city),
        names: names.map((n) => `${n.name} (${n.gender === 'female' ? 'ж' : 'м'})`),
        needsNew: plan.needsNew,
      }),
    null,
  );
  const used = costume ? namesUsed(names, JSON.stringify(costume)) : [];
  await returnNames(deps, names.filter((n) => !used.includes(n)));
  if (!costume) return null;
  if (plan.dynamicId) city.dynamicsUsed[plan.dynamicId] = day;
  const tags = plan.tags;
  // В журнал режиссёра идёт только то, что действительно родилось.
  const born = (made: Complication): Complication => {
    markStory(city, tags, day);
    return made;
  };

  const dress: EventDress = { title: plainTitle(costume.title), description: costume.description, outburst: costume.outburst, newObject: costume.newObject };
  const ctx = { day, newId: (p: string) => newId(deps, p), frontId: parent.id };
  const changes: Change[] = [];

  // Помеха: объект с отрицательной скоростью, фронта нет.
  if (plan.shape === 'hindrance') {
    changes.push(...applyStake(deps.rules, city, [hindranceOp(deps.rules, parent, dress)], ctx).changes);
    return born({ changes, gist: costume.rumor });
  }

  // Авария: мгновенный удар, после неё остаётся помеха.
  if (plan.shape === 'accident') {
    if (accidentLoss(deps.rules, parent, day) > 0) changes.push({ kind: 'front_moved', frontId: parent.id, title: parent.title, how: 'setback' });
    changes.push(...applyStake(deps.rules, city, [hindranceOp(deps.rules, parent, dress)], ctx).changes);
    await faithEvent(deps, city, { event: costume.description, will: willWords(city, parent), day });
    return born({ changes, gist: costume.description });
  }

  // Удобный случай: плюсовое дело со сроком.
  if (plan.shape === 'opportunity') {
    if (!costume.newObject) return null;
    const subject = costume.newObject;
    const { points } = await appraise(deps, city, subject);
    const stake: StakeOp[] = [{ op: 'create', object: { ...subject, points, refs: role ? [role.id] : [] }, result: true }];
    const front = buildOpportunity(deps.rules, {
      origin: 'complication',
      stake,
      gain: newObjectCapacity(deps.rules, subject.type, points),
      dress,
      key: null,
      dynamicId: plan.dynamicId,
      refs: role ? [role.id] : [],
      id: newId(deps, 'front'),
      day,
    });
    front.key = await seal(deps, city, front, { hint: plan.helps });
    city.fronts.push(front);
    changes.push({ kind: 'front_opened', frontId: front.id, title: front.title, form: front.form, plus: true });
    return born({ changes, gist: costume.rumor });
  }

  // Привязанное: бьёт по делу, которое его породило.
  if (plan.class === 'bound') {
    if (plan.shape !== 'tension' && plan.shape !== 'threat') return null;
    const front = buildBound(deps.rules, parent, {
      shape: plan.shape,
      dress,
      key: null,
      dynamicId: plan.dynamicId,
      roleId: role?.id ?? null,
      id: newId(deps, 'front'),
      day,
      rng: deps.random.rng,
    });
    front.key = await seal(deps, city, front, { hint: plan.helps });
    city.fronts.push(front);
    changes.push({ kind: 'front_opened', frontId: front.id, title: front.title, form: front.form, plus: false });
    if (front.form === 'threat') changes.push({ kind: 'front_moved', frontId: parent.id, title: parent.title, how: 'frozen' });
    return born({ changes, gist: costume.rumor });
  }

  // Побочное: бьёт по объекту. На кону разница его вклада.
  if (plan.shape !== 'tension' && plan.shape !== 'threat' && plan.shape !== 'clock') return null;
  const result = q.resultId ? findObject(city, q.resultId) : null;
  const hit = plan.hits === 'result' ? result : role;
  if (!hit || hit.status !== 'active') return null;
  const extraRefs: string[] = role && role.id !== hit.id ? [role.id] : [];
  if (plan.needsNew && costume.newObject) {
    const made = applyStake(
      deps.rules,
      city,
      [{ op: 'create', object: { ...costume.newObject, points: { prosperity: 0, security: 0, knowledge: 0, influence: 0 }, refs: [hit.id], hidden: plan.newHidden }, result: true }],
      ctx,
    );
    changes.push(...made.changes);
    if (made.resultId) extraRefs.push(made.resultId);
  }
  const before = rawToPoints(city, hit.statEffect);
  const appraised = await appraise(deps, city, briefOf(hit), { points: before, event: costume.outburst });
  const capped = capSideHit(deps.rules, before, appraised.points);
  const newPoints = magnitude(diffPoints(capped, before)) > 0 ? capped : fallbackHit(deps, before);
  const front = buildSide(deps.rules, city, {
    shape: plan.shape,
    origin: 'complication',
    target: hit,
    newPoints,
    dress,
    key: null,
    dynamicId: plan.dynamicId,
    extraRefs,
    id: newId(deps, 'front'),
    day,
    rng: deps.random.rng,
  });
  if (front.form !== 'clock') front.key = await seal(deps, city, front, { hint: plan.helps });
  city.fronts.push(front);
  changes.push({ kind: 'front_opened', frontId: front.id, title: front.title, form: front.form, plus: false });
  return born({ changes, gist: costume.rumor });
}

// ───────────────────────────── бросок риска ─────────────────────────────

/**
 * Что выпало делу в этот момент. Кубик бросается по ступени риска и сумме рычагов темпа;
 * недостижимое дело костей не бросает: беда приходит на каждом шаге, каждая N-я заменяется находкой.
 * Бросать надо, пока у дела ещё есть ведущий: его темп входит в шанс.
 */
export function rollFor(deps: FlowDeps, city: City, front: Front, counter: Front = front): RollKind | null {
  const risk = deps.rules.fronts.risk;
  if (front.unattainable) {
    counter.rollsFired += 1;
    return counter.rollsFired % risk.plusEvery === 0 ? 'plus' : 'heavy';
  }
  const kind = rollRisk(
    { chance: complicationChance(deps.rules, front.risk, tempoSum(city, front)), heavyShare: risk.heavyShare[front.risk], plusChance: plusChance(deps.rules, city) },
    deps.random.rng,
  );
  if (kind) counter.rollsFired += 1;
  return kind;
}

/**
 * Срыв: случится ли следом новая беда или удобный случай. Решает режиссёр: чем больше
 * бед висит без ответа, тем реже следом что-то родится и тем чаще это удобный случай.
 * Когда бед без ответа уже предел, беда не родится, удобный случай — может.
 */
export function rollForFailure(deps: FlowDeps, city: City): RollKind | null {
  const f = deps.rules.fronts.failure;
  const rng = deps.random.rng;
  const room = roomForTrouble(deps.rules, city);
  const plus = plusChance(deps.rules, city);
  if (rng() >= f.chance * Math.max(room, plus)) return null;
  if (room === 0 || rng() < plus) return 'plus';
  return rng() < f.heavyShare ? 'heavy' : 'light';
}

/** Собрать то, что выпало. Плюсовая запись, которой не нашлось роли, уступает место обычной беде. */
export async function complicateRolled(
  deps: FlowDeps,
  city: City,
  parent: Front,
  kind: RollKind | null,
  q: { moment: Moment; resultId?: string | null; sideOnly?: boolean },
  day: number,
): Promise<Complication | null> {
  if (!kind) return null;
  const sideOnly = q.sideOnly || Boolean(parent.unattainable) || q.moment !== 'milestone';
  const made = await complicate(deps, city, parent, { ...q, kind, sideOnly }, day);
  if (made || kind !== 'plus') return made;
  // Удобный случай вместо беды при срыве: если его не нашлось, а бед без ответа предел, ничего не родится.
  if (q.moment === 'failure' && roomForTrouble(deps.rules, city) === 0) return null;
  const heavy = parent.unattainable || deps.random.rng() < deps.rules.fronts.risk.heavyShare[parent.risk];
  return complicate(deps, city, parent, { ...q, kind: heavy ? 'heavy' : 'light', sideOnly }, day);
}

// ───────────────────────────── ставка с намерением ─────────────────────────────

/**
 * Развернуть операции `modify` (переписать и переоценить по намерению) в `revalue`:
 * Переписчик даёт новое описание, Оценщик вклада — новый вклад.
 */
export async function resolveModify(deps: FlowDeps, city: City, ops: readonly StakeOp[], context: string): Promise<StakeOp[]> {
  const out: StakeOp[] = [];
  for (const op of ops) {
    if (op.op !== 'modify') {
      out.push(op);
      continue;
    }
    const target = findObject(city, op.target);
    if (!target || target.status !== 'active') continue;
    const change = op.intent || context;
    const description = await tryAgent(
      deps,
      'description-rewriter',
      () => rewriteDescription(deps.agents, { name: target.name, description: target.description, change }),
      target.description,
    );
    const before = rawToPoints(city, target.statEffect);
    const { points } = await appraise(deps, city, { type: target.type, name: target.name, description }, { points: before, event: change });
    out.push({ op: 'revalue', target: target.id, points, description });
  }
  return out;
}

/** Сработавшая беда меняет объект: Переписчик вписывает случившееся в его описание. */
export async function describeHits(deps: FlowDeps, city: City, ops: readonly StakeOp[], event: string): Promise<StakeOp[]> {
  const out: StakeOp[] = [];
  for (const op of ops) {
    if (op.op !== 'revalue' || op.description) {
      out.push(op);
      continue;
    }
    const target = findObject(city, op.target);
    if (!target || target.status !== 'active') continue;
    const description = await tryAgent(
      deps,
      'description-rewriter',
      () => rewriteDescription(deps.agents, { name: target.name, description: target.description, change: event }),
      target.description,
    );
    out.push({ ...op, description });
  }
  return out;
}

// ───────────────────────────── обновление после перемен ─────────────────────────────

/**
 * Ключ, вердикт, ступень и описание устаревают, когда меняется мир вокруг дела. Код находит дела,
 * которых касается перемена; Примерщик отвечает, существенна ли она; дальше те же узкие агенты
 * переписывают каждый своё. Обновление не порождает новых обновлений.
 */
export async function refreshAfterChange(
  deps: FlowDeps,
  city: City,
  changes: readonly Change[],
  exceptFrontIds: readonly string[],
  event: string,
  day: number,
): Promise<Change[]> {
  const out: Change[] = [];
  for (const front of refreshTargets(deps.rules, city, changedObjectIds(changes), exceptFrontIds)) {
    if (front.status !== 'active') continue;
    const gate = await tryAgent(
      deps,
      'role-fitter',
      () => fitRole(deps.agents, { question: 'Эта перемена существенно меняет ход дела?', subject: situationOf(front), context: event }),
      { fits: false, reason: '' },
    );
    if (!gate.fits) continue;

    if (front.origin === 'deed') {
      const still = await tryAgent(
        deps,
        'role-fitter',
        () => fitRole(deps.agents, { question: 'Это задание всё ещё имеет смысл?', subject: situationOf(front), context: event }),
        { fits: true, reason: '' },
      );
      if (!still.fits) {
        out.push(...closeFront(deps.rules, city, front, 'cancelled', day));
        continue;
      }
    }

    front.description = await tryAgent(
      deps,
      'description-rewriter',
      () => rewriteDescription(deps.agents, { name: front.title, description: front.description, change: event }),
      front.description,
    );
    const key = await seal(deps, city, front);
    if (key) front.key = { moves: key.moves, twist: front.key?.twist ?? null };

    const lead = leadOf(city, front.id);
    if (lead?.text && front.key) {
      const moves = front.key.moves;
      lead.verdict = (
        await tryAgent(
          deps,
          'alignment-judge',
          () => judgeAlignment(deps.agents, { situation: situationOf(front), moves, proposal: lead.text }),
          { verdict: lead.verdict, matchedMove: null },
        )
      ).verdict;
    }
    if (front.origin === 'player' && !front.unattainable) {
      front.risk = (
        await tryAgent(
          deps,
          'risk-appraiser',
          () => appraiseRisk(deps.agents, { work: `${front.title}. ${front.description}`, touches: touchesOf(city, front) }),
          { step: front.risk, reason: '' },
        )
      ).step;
      // Месячный бросок есть только у ступени «невозможно».
      if (front.risk !== 'impossible') front.pulseDay = null;
      else front.pulseDay ??= day + DAYS_PER_MONTH;
      await revalueStake(deps, city, front, event, day);
    }
  }
  return out;
}

/** Переоценить будущий результат дела и пересчитать ёмкость, сохранив долю сделанного. */
async function revalueStake(deps: FlowDeps, city: City, front: Front, event: string, day: number): Promise<void> {
  const op = front.stake.find((o): o is Extract<StakeOp, { op: 'create' }> => o.op === 'create' && Boolean(o.result));
  if (!op) return;
  const { points, ok } = await appraise(deps, city, { type: op.object.type, name: op.object.name, description: op.object.description }, { points: op.object.points, event });
  if (!ok || magnitude(diffPoints(points, op.object.points)) === 0) return;
  const share = shareDone(front, day);
  op.object.points = points;
  front.capacity = newObjectCapacity(deps.rules, op.object.type, points);
  front.progress = share * front.capacity;
  front.progressDay = Math.max(front.progressDay, day);
  front.profile = dominantStat(points) ?? front.profile;
}
