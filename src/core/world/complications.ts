/**
 * Сборка осложнений, эха и удобных случаев из готовых частей.
 * Смысл (кто, что, почему) приходит от агентов; ёмкость, срок и ставку считает этот файл.
 */

import { STAT_IDS, type ObjectType, type Rules, type StatMap } from '../rules.js';
import type { City, Front, FrontKey, StakeOp, WorldObject } from '../city.js';
import type { Rng } from '../random.js';
import { createFront, settleProgress } from './fronts.js';
import {
  boundThreat,
  diffPoints,
  hindranceRemovalCapacity,
  magnitude,
  monthsToDays,
  opportunityCapacity,
  boundCapacity,
  quenchCapacity,
  sideQuenchCapacity,
  troubleDays,
  rawToPoints,
  threatCapacity,
} from './numbers.js';

/** Слова события от Костюмера в том виде, в каком их знает ядро. */
export interface EventDress {
  title: string;
  description: string;
  outburst: string;
  newObject: { type: ObjectType; name: string; description: string } | null;
}

const ZERO: StatMap = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };

function burstDay(rules: Rules, day: number, rng: Rng): number {
  const t = rules.fronts.tension;
  const months = t.burstMonthsMin + Math.floor(rng() * (t.burstMonthsMax - t.burstMonthsMin + 1));
  return day + monthsToDays(months);
}

/** Помеха на фронте: объект с отрицательной скоростью. Не путать с осложнением — это его итог. */
export function hindranceOp(rules: Rules, parent: Pick<Front, 'id'>, dress: EventDress): StakeOp {
  const object = dress.newObject ?? { type: 'threat' as const, name: dress.title, description: dress.outburst };
  return { op: 'attach', frontId: parent.id, rate: rules.fronts.hindrance.unitsPerMonth, object: { ...object, points: { ...ZERO } } };
}

/**
 * Привязанное осложнение: бьёт по делу, которое его породило, и умирает вместе с ним.
 * На кону прогресс родителя: замедление («обычно»), одна веха («сложно») или всё дело (выше).
 */
export function buildBound(
  rules: Rules,
  parent: Front,
  args: { shape: 'tension' | 'threat'; dress: EventDress; key: FrontKey | null; dynamicId: string | null; roleId: string | null; id: string; day: number; rng: Rng },
): Front {
  const bound = boundThreat(parent.risk);
  const atStake =
    bound === 'slow' ? hindranceRemovalCapacity(rules, parent.capacity) : bound === 'rollback' ? parent.capacity / parent.milestones : parent.capacity;
  const failStake: StakeOp[] =
    bound === 'slow' ? [hindranceOp(rules, parent, args.dress)] : bound === 'rollback' ? [{ op: 'rollback', frontId: parent.id }] : [{ op: 'cancel', frontId: parent.id }];
  const tension = args.shape === 'tension';
  return createFront({
    id: args.id,
    form: args.shape,
    origin: 'complication',
    title: args.dress.title,
    description: args.dress.description,
    capacity: tension ? quenchCapacity(rules, atStake) : boundCapacity(rules, atStake),
    deadlineDay: tension ? burstDay(rules, args.day, args.rng) : args.day + troubleDays(rules, boundCapacity(rules, atStake), rules.fronts.deadlines.ownRiskMonths),
    failStake,
    key: args.key,
    refs: args.roleId ? [args.roleId] : [],
    parentId: parent.id,
    bound,
    atStake,
    outburst: args.dress.outburst,
    dynamicId: args.dynamicId,
    day: args.day,
  });
}

/**
 * Предел удара побочной беды по объекту: беда может отнять то, что объект даёт городу,
 * и увести его в малый минус, но одна беда не превращает опору города в его главную рану.
 */
export function capSideHit(rules: Rules, before: StatMap, hit: StatMap): StatMap {
  const out = { ...hit };
  for (const id of STAT_IDS) out[id] = Math.max(hit[id], Math.min(before[id], 0) - rules.fronts.contribution.small);
  return out;
}

/**
 * Побочное осложнение или шаг эха: бьёт по объекту. На кону разница его вклада —
 * каким он станет, если беда случится.
 */
export function buildSide(
  rules: Rules,
  city: Pick<City, 'statScale'>,
  args: {
    shape: 'tension' | 'threat' | 'clock';
    origin: 'complication' | 'echo';
    target: WorldObject;
    newPoints: StatMap;
    dress: EventDress;
    key: FrontKey | null;
    dynamicId: string | null;
    extraRefs?: string[];
    id: string;
    day: number;
    rng: Rng;
  },
): Front {
  const delta = diffPoints(args.newPoints, rawToPoints(city, args.target.statEffect));
  const atStake = magnitude(delta);
  const hit: StakeOp[] = [{ op: 'revalue', target: args.target.id, points: { ...args.newPoints } }];
  const months = args.origin === 'echo' ? rules.fronts.deadlines.worldMonths : rules.fronts.deadlines.ownRiskMonths;
  const base = {
    id: args.id,
    origin: args.origin,
    title: args.dress.title,
    description: args.dress.description,
    key: args.key,
    refs: [args.target.id, ...(args.extraRefs ?? [])],
    atStake,
    outburst: args.dress.outburst,
    dynamicId: args.dynamicId,
    day: args.day,
  };
  if (args.shape === 'clock') {
    return createFront({ ...base, form: 'clock', capacity: 0, deadlineDay: args.day + monthsToDays(rules.fronts.deadlines.worldMonths), stake: hit });
  }
  if (args.shape === 'tension') {
    return createFront({ ...base, form: 'tension', capacity: sideQuenchCapacity(rules, atStake), deadlineDay: burstDay(rules, args.day, args.rng), failStake: hit });
  }
  const capacity = threatCapacity(rules, atStake);
  return createFront({ ...base, form: 'threat', capacity, deadlineDay: args.day + troubleDays(rules, capacity, months), failStake: hit });
}

/** Удобный случай: плюсовое дело со сроком и скидкой. Срок вышел — просто исчез. */
export function buildOpportunity(
  rules: Rules,
  args: { origin: 'complication' | 'echo'; stake: StakeOp[]; gain: number; dress: EventDress; key: FrontKey | null; dynamicId: string | null; refs: string[]; id: string; day: number },
): Front {
  return createFront({
    id: args.id,
    form: 'deed',
    origin: args.origin,
    title: args.dress.title,
    description: args.dress.description,
    capacity: opportunityCapacity(rules, args.gain),
    deadlineDay: args.day + monthsToDays(rules.fronts.deadlines.worldMonths),
    stake: args.stake,
    key: args.key,
    refs: args.refs,
    plus: true,
    atStake: args.gain,
    outburst: args.dress.outburst,
    dynamicId: args.dynamicId,
    day: args.day,
  });
}

/**
 * Напряжение прорвалось в угрозу: тот же фронт, новая форма. Доля сделанного сохраняется,
 * ёмкость пересчитывается от того же, что на кону, срок короткий.
 */
export function tensionToThreat(rules: Rules, front: Front, day: number): void {
  settleProgress(front, day);
  const share = front.capacity > 0 ? front.progress / front.capacity : 0;
  front.form = 'threat';
  front.capacity = front.parentId ? boundCapacity(rules, front.atStake) : threatCapacity(rules, front.atStake);
  front.progress = share * front.capacity;
  front.progressDay = Math.max(front.progressDay, Math.round(day));
  front.milestones = 1;
  front.milestonesFired = 0;
  const months = front.origin === 'echo' ? rules.fronts.deadlines.worldMonths : rules.fronts.deadlines.ownRiskMonths;
  front.deadlineDay = Math.round(day) + troubleDays(rules, front.capacity - front.progress, months);
}

/** Авария: мгновенный удар. Часть набранного прогресса теряется. Возвращает потерю. */
export function accidentLoss(rules: Rules, parent: Front, day: number): number {
  settleProgress(parent, day);
  const loss = parent.progress * rules.fronts.risk.accidentLoss;
  parent.progress = Math.max(0, parent.progress - loss);
  return loss;
}
