/**
 * Приказ как правка: результат дела и то, как он повлияет на идущее рядом.
 *
 * Агент называет фронт и вид влияния одним словом из закрытого списка. Здесь код проверяет,
 * что такое влияние возможно, считает цену и дописывает ставку дела. Числа считает только код:
 * цена влияния — доля остатка шкалы фронта, за который взялись.
 */

import type { City, Front, FrontLink, HoldSpec, StakeOp } from '../city.js';
import type { LinkEffect, Rules } from '../rules.js';
import { activeFronts, deadlineOf, findFront, frontTouches, progressAt, withOuter } from './fronts.js';
import { feasibleHold, ownMotion } from './hold.js';
import { diffPoints, magnitude, rawToPoints } from './numbers.js';
import { findObject } from './objects.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Что агент сказал о влиянии результата на один фронт. */
export interface LinkSpec {
  frontId: string;
  effect: LinkEffect;
  /** Держится на слове: слух, обещание, перемирие. */
  word?: boolean;
}

/** Объекты и всё, что в них вложено. */
function withNested(city: Pick<City, 'objects'>, ids: readonly string[]): Set<string> {
  const out = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of city.objects) {
      if (o.status === 'active' && o.parentId && out.has(o.parentId) && !out.has(o.id)) {
        out.add(o.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Что часы унесут, в единицах работы: вклад объектов, которые исчезнут, плюс работа,
 * которая на них держалась. У часов шкалы нет, и это их «остаток».
 */
export function clockToll(rules: Rules, city: Pick<City, 'objects' | 'fronts' | 'statScale'>, clock: Front, day: number): number {
  let sum = 0;
  const targets: string[] = [];
  for (const op of clock.stake) {
    if (op.op === 'delete' || op.op === 'retire') targets.push(op.target);
    if (op.op === 'stats') sum += magnitude(op.points);
    if (op.op === 'revalue') {
      const obj = findObject(city, op.target);
      if (obj?.status === 'active') sum += magnitude(diffPoints(op.points, rawToPoints(city, obj.statEffect)));
    }
  }
  const gone = withNested(city, targets);
  for (const id of gone) {
    const obj = findObject(city, id);
    if (obj?.status === 'active') sum += magnitude(rawToPoints(city, obj.statEffect));
  }
  for (const front of activeFronts(city)) {
    if (front.id === clock.id || !front.livesOn || !gone.has(front.livesOn) || ownMotion(front) !== 'work') continue;
    sum += Math.max(0, front.capacity - progressAt(front, day));
  }
  return Math.max(rules.fronts.threat.capacityMin, round2(sum));
}

/** Остаток шкалы фронта: сколько работы ещё стоит то, что с ним происходит. */
export function frontRemainder(rules: Rules, city: Pick<City, 'objects' | 'fronts' | 'statScale'>, front: Front, day: number): number {
  if (front.capacity <= 0) return clockToll(rules, city, front, day);
  return round2(Math.max(0, front.capacity - progressAt(front, day)));
}

/**
 * На пользу ли городу такое влияние. Беду и часы выгодно остановить или замедлить, дело и поиск —
 * ускорить или обезопасить. За остальное город не платит: это последствия, а не покупка.
 */
function benefits(front: Front, effect: LinkEffect): boolean {
  if (effect === 'removes') return !front.plus && ownMotion(front) === 'clock';
  if (effect === 'outcome') return ownMotion(front) === 'clock';
  if (ownMotion(front) === 'clock') return effect === 'stop' || effect === 'slow';
  return effect === 'hurry' || effect === 'safer';
}

/** Сколько работы стоит такое влияние на фронт. Ноль — влияние не на пользу, оно бесплатно. */
export function linkPrice(rules: Rules, city: Pick<City, 'objects' | 'fronts' | 'statScale'>, front: Front, spec: Pick<LinkSpec, 'effect' | 'word'>, day: number): number {
  if (!benefits(front, spec.effect)) return 0;
  const rest = frontRemainder(rules, city, front, day);
  const p = rules.fronts.hold.price;
  // Устранить причину стоит весь остаток: фронт закрыт навсегда. Сдержать дешевле.
  const share = spec.effect === 'removes' ? 1 : spec.effect === 'riskier' ? 0 : p[spec.effect];
  const word = spec.word && spec.effect !== 'removes' ? rules.fronts.hold.wordShare : 1;
  return Math.max(rules.fronts.hold.priceMin, round2(rest * share * word));
}

/**
 * Что идёт в городе, если смотреть от правки: сначала фронт, на который приказ отвечает прямо (`named`),
 * потом те, что касаются её объектов или того, во что они вложены, потом остальные по близости срока.
 * Остальные нужны, чтобы связь нашлась и там, где её не подсказали ни приказ, ни объекты.
 */
export function nearFronts(city: Pick<City, 'fronts' | 'objects'>, objectIds: readonly string[], opts: { named?: string | null; except?: readonly string[]; limit?: number } = {}): Front[] {
  const mine = new Set(objectIds);
  const outer = withOuter(city, objectIds);
  const except = new Set(opts.except ?? []);
  const touches = (f: Front): boolean => {
    const theirs = frontTouches(city, f);
    if (theirs.some((id) => outer.has(id))) return true;
    for (const id of withOuter(city, theirs)) if (mine.has(id)) return true;
    return false;
  };
  const rank = (f: Front): number => (f.id === opts.named ? 0 : touches(f) ? 1 : 2);
  const soon = (f: Front): number => deadlineOf(city, f) ?? Number.POSITIVE_INFINITY;
  return activeFronts(city)
    .filter((f) => !except.has(f.id) && !(f.parentId && except.has(f.parentId)))
    .map((f) => ({ f, rank: rank(f), soon: soon(f) }))
    .sort((a, b) => a.rank - b.rank || a.soon - b.soon)
    .slice(0, opts.limit ?? 8)
    .map((x) => x.f);
}

export interface PatchLinks {
  /** Что записать в дело: принятые влияния с ценой. */
  links: FrontLink[];
  /** Якоря для объекта-результата. */
  holds: HoldSpec[];
  /** Операции, которые ставка дела исполнит после результата. */
  ops: StakeOp[];
  price: number;
  /**
   * Слова, которые код не исполнил, и почему: `unsupported` — такого словарь пока не умеет,
   * `no_anchor` — у результата нет вещи, которая держала бы, `no_effect` — фронту это ничего не меняет.
   */
  dropped: Array<LinkSpec & { why: 'unsupported' | 'no_anchor' | 'no_effect' }>;
}

/**
 * Принять слова оценщика влияния: отбросить невозможное, назначить цену, собрать якоря.
 * `anchor` — есть ли у результата вещь, которая может держать: без вещи якорю не на чем стоять.
 * `cause` — имя результата: им названа причина, когда фронт закрыт.
 */
export function planLinks(
  rules: Rules,
  city: Pick<City, 'objects' | 'fronts' | 'statScale'>,
  specs: readonly LinkSpec[],
  args: { anchor: boolean; cause: string; day: number },
): PatchLinks {
  const out: PatchLinks = { links: [], holds: [], ops: [], price: 0, dropped: [] };
  const seen = new Set<string>();
  for (const spec of specs) {
    const front = findFront(city, spec.frontId);
    if (!front || front.status !== 'active' || seen.has(front.id)) continue;
    const drop = (why: PatchLinks['dropped'][number]['why']) => out.dropped.push({ ...spec, why });
    if (spec.effect === 'removes') {
      // Своё дело город закрывает сам, словом покровителя, а не чужим результатом.
      if (front.origin === 'player' || front.origin === 'deed') {
        drop('unsupported');
        continue;
      }
      // Часы трудом не закрыть: их можно только удержать вещью или убрать то, на чём они живут.
      if (front.form === 'clock') {
        if (!args.anchor || !feasibleHold(city, front, { effect: 'stop' })) {
          drop(args.anchor ? 'no_effect' : 'no_anchor');
          continue;
        }
        seen.add(front.id);
        const price = linkPrice(rules, city, front, { effect: 'stop', word: spec.word }, args.day);
        out.links.push({ frontId: front.id, effect: 'stop', ...(spec.word ? { word: true } : {}), price });
        out.holds.push({ frontId: front.id, effect: 'stop', ...(spec.word ? { word: true } : {}) });
        out.price += price;
        continue;
      }
      seen.add(front.id);
      const price = linkPrice(rules, city, front, spec, args.day);
      out.links.push({ frontId: front.id, effect: 'removes', price });
      out.ops.push({ op: 'end', frontId: front.id, cause: args.cause });
      out.price += price;
      continue;
    }
    // Исход якорем меняют отдельной правкой со своими ставками: одного слова для этого мало.
    if (spec.effect === 'outcome' || !args.anchor || !feasibleHold(city, front, { effect: spec.effect })) {
      drop(spec.effect === 'outcome' ? 'unsupported' : args.anchor ? 'no_effect' : 'no_anchor');
      continue;
    }
    seen.add(front.id);
    const price = linkPrice(rules, city, front, spec, args.day);
    out.links.push({ frontId: front.id, effect: spec.effect, ...(spec.word ? { word: true } : {}), price });
    out.holds.push({ frontId: front.id, effect: spec.effect, ...(spec.word ? { word: true } : {}) });
    out.price += price;
  }
  out.price = round2(out.price);
  return out;
}
