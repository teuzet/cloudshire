/**
 * Приказ как правка: результат дела и то, как он повлияет на идущее рядом.
 *
 * Агент называет фронт и вид влияния одним словом из закрытого списка. Здесь код проверяет,
 * что такое влияние возможно, считает цену и дописывает ставку дела. Числа считает только код:
 * цена влияния — доля остатка шкалы фронта, за который взялись.
 */

import type { City, Front, FrontLink, Hold, HoldSpec, StakeOp } from '../city.js';
import { emptyStatMap, type HoldEffect, type LinkEffect, type Rules, type StatMap } from '../rules.js';
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
export function withNested(city: Pick<City, 'objects'>, ids: readonly string[]): Set<string> {
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
 * Что унесёт ставка, в единицах работы: потери статов, вклад объектов, которые исчезнут (с вложенным),
 * и остаток работы, которая на них держалась. `selfId` — фронт самой ставки: его работа не в счёт.
 */
export function stakeToll(city: Pick<City, 'objects' | 'fronts' | 'statScale'>, stake: readonly StakeOp[], selfId: string, day: number): number {
  let sum = 0;
  const targets: string[] = [];
  for (const op of stake) {
    if (op.op === 'delete' || op.op === 'retire') targets.push(op.target);
    if (op.op === 'stats') sum += magnitude({ ...emptyStatMap(), ...op.points });
    if (op.op === 'revalue') {
      const obj = findObject(city, op.target);
      if (obj?.status === 'active') sum += magnitude(diffPoints(op.points, rawToPoints(city, obj.statEffect)));
    }
  }
  sum += subtreeValue(city, withNested(city, targets), selfId, day);
  return round2(sum);
}

/** Что часы унесут: у часов шкалы нет, и это их «остаток». */
export function clockToll(rules: Rules, city: Pick<City, 'objects' | 'fronts' | 'statScale'>, clock: Front, day: number): number {
  return Math.max(rules.fronts.threat.capacityMin, stakeToll(city, clock.stake, clock.id, day));
}

/** Удар фронта: у часов то, что случится в срок, у беды то, что случится, если её не снять. */
function hitOf(front: Front): 'stake' | 'failStake' {
  return front.form === 'clock' ? 'stake' : 'failStake';
}

/**
 * Смягчённый удар. То, что правка сама увела из-под удара (`shielded` и вложенное в него), не задето;
 * остальное бьёт на долю `fronts.hold.softenKeep`: потеря статов меньше, переоценка на полпути,
 * исчезновение становится порчей. Уход навсегда смягчить нельзя: он остаётся как был.
 */
export function softenStake(rules: Rules, city: Pick<City, 'objects' | 'statScale'>, stake: readonly StakeOp[], shielded: readonly string[]): StakeOp[] {
  const keep = rules.fronts.hold.softenKeep;
  const safe = withNested(city, shielded);
  const scale = (p: StatMap, k: number): StatMap => ({ prosperity: round2(p.prosperity * k), security: round2(p.security * k), knowledge: round2(p.knowledge * k), influence: round2(p.influence * k) });
  const out: StakeOp[] = [];
  for (const op of stake) {
    if ('target' in op && typeof op.target === 'string' && safe.has(op.target) && (op.op === 'delete' || op.op === 'retire' || op.op === 'revalue' || op.op === 'modify')) continue;
    if (op.op === 'stats') {
      out.push({ op: 'stats', points: scale({ ...emptyStatMap(), ...op.points }, keep) });
      continue;
    }
    const obj = 'target' in op && typeof op.target === 'string' ? findObject(city, op.target) : null;
    const now = obj?.status === 'active' ? rawToPoints(city, obj.statEffect) : null;
    if (op.op === 'revalue' && now) {
      const d = diffPoints(op.points, now);
      out.push({ ...op, points: { prosperity: round2(now.prosperity + d.prosperity * keep), security: round2(now.security + d.security * keep), knowledge: round2(now.knowledge + d.knowledge * keep), influence: round2(now.influence + d.influence * keep) } });
      continue;
    }
    if ((op.op === 'delete' || (op.op === 'retire' && !op.forever)) && now) {
      out.push({ op: 'revalue', target: op.target, points: scale(now, 1 - keep) });
      continue;
    }
    out.push(op);
  }
  return out;
}

/** Чего стоит вещь со всем вложенным: её вклад и работа, которая на ней держится. */
function subtreeValue(city: Pick<City, 'objects' | 'fronts' | 'statScale'>, ids: ReadonlySet<string>, except: string, day: number): number {
  let sum = 0;
  for (const id of ids) {
    const obj = findObject(city, id);
    if (obj?.status === 'active') sum += magnitude(rawToPoints(city, obj.statEffect));
  }
  for (const front of activeFronts(city)) {
    if (front.id === except || !front.livesOn || !ids.has(front.livesOn) || ownMotion(front) !== 'work') continue;
    sum += Math.max(0, front.capacity - progressAt(front, day));
  }
  return sum;
}

/**
 * Что спасает перенос: вещь со всем вложенным больше не уйдёт вместе со старым местом.
 * Для каждого идущего фронта, чья ставка унесла бы вещь через то, во что она вложена, а после переноса
 * уже не унесёт, спасены её вклад и работа, которая на ней держится. Берётся наибольшее: потерять вещь
 * можно только раз. `fronts` — от чего вещь уведена: об этих фронтах оценщика влияния уже не спрашивают.
 */
export function moveSaving(
  city: Pick<City, 'objects' | 'fronts' | 'statScale'>,
  objectId: string,
  to: string | null,
  day: number,
): { saved: number; fronts: string[] } {
  const obj = findObject(city, objectId);
  if (!obj || obj.status !== 'active') return { saved: 0, fronts: [] };
  const moved = { objects: city.objects.map((o) => (o.id === objectId ? { ...o, parentId: to } : o)) };
  const value = subtreeValue(city, withNested(city, [objectId]), '', day);
  let saved = 0;
  const fronts: string[] = [];
  for (const front of activeFronts(city)) {
    const targets = [...front.stake, ...front.failStake].flatMap((op) => (op.op === 'delete' || op.op === 'retire' ? [op.target] : []));
    if (!targets.length || targets.includes(objectId)) continue;
    if (!withNested(city, targets).has(objectId) || withNested(moved, targets).has(objectId)) continue;
    fronts.push(front.id);
    saved = Math.max(saved, value);
  }
  return { saved: round2(saved), fronts };
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
export function nearFronts(city: Pick<City, 'fronts' | 'objects'>, objectIds: readonly string[], opts: { named?: string | null; except?: readonly string[]; limit?: number; first?: readonly string[] } = {}): Front[] {
  const mine = new Set(objectIds);
  const outer = withOuter(city, objectIds);
  const except = new Set(opts.except ?? []);
  const touches = (f: Front): boolean => {
    const theirs = frontTouches(city, f);
    if (theirs.some((id) => outer.has(id))) return true;
    for (const id of withOuter(city, theirs)) if (mine.has(id)) return true;
    return false;
  };
  const first = new Set(opts.first ?? []);
  const rank = (f: Front): number => (first.has(f.id) ? -1 : f.id === opts.named ? 0 : touches(f) ? 1 : 2);
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
  /** Что изменённый объект держал и после правки держать перестанет. */
  released: string[];
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
 * `shielded` — что правка сама уводит из-под удара (изменённый объект): смягчённый удар его не задевает.
 */
export function planLinks(
  rules: Rules,
  city: Pick<City, 'objects' | 'fronts' | 'statScale'>,
  specs: readonly LinkSpec[],
  args: { anchor: boolean; cause: string; day: number; shielded?: readonly string[]; held?: { objectId: string; holds: readonly Hold[] } },
): PatchLinks {
  const out: PatchLinks = { links: [], holds: [], ops: [], price: 0, dropped: [], released: [] };
  const seen = new Set<string>();
  // Изменённый объект уже держит: то же влияние после правки ничего не меняет и ничего не стоит.
  const kept = (frontId: string, effect: HoldEffect, word: boolean | undefined): boolean =>
    Boolean(args.held?.holds.some((h) => h.frontId === frontId && h.effect === effect && Boolean(h.word) === Boolean(word)));
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
        const price = kept(front.id, 'stop', spec.word) ? 0 : linkPrice(rules, city, front, { effect: 'stop', word: spec.word }, args.day);
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
    // Смягчить удар: пока вещь цела, беда бьёт слабее. Цена — сколько это спасает, со скидкой сдерживания.
    if (spec.effect === 'outcome') {
      // Сменить, что даст дело людей, — другая правка: этого словарь пока не умеет.
      if (ownMotion(front) !== 'clock') {
        drop('unsupported');
        continue;
      }
      if (!args.anchor) {
        drop('no_anchor');
        continue;
      }
      const key = hitOf(front);
      const softened = softenStake(rules, city, front[key], args.shielded ?? []);
      const saved = round2(stakeToll(city, front[key], front.id, args.day) - stakeToll(city, softened, front.id, args.day));
      const hold: HoldSpec = { frontId: front.id, effect: 'outcome', ...(spec.word ? { word: true } : {}), [key]: softened };
      if (saved <= 0 || !feasibleHold(city, front, hold)) {
        drop('no_effect');
        continue;
      }
      seen.add(front.id);
      const p = rules.fronts.hold;
      const price = kept(front.id, 'outcome', spec.word) ? 0 : Math.max(p.priceMin, round2(saved * p.price.outcome * (spec.word ? p.wordShare : 1)));
      out.links.push({ frontId: front.id, effect: 'outcome', ...(spec.word ? { word: true } : {}), price });
      out.holds.push(hold);
      out.price += price;
      continue;
    }
    if (!args.anchor || !feasibleHold(city, front, { effect: spec.effect })) {
      drop(args.anchor ? 'no_effect' : 'no_anchor');
      continue;
    }
    seen.add(front.id);
    const price = kept(front.id, spec.effect, spec.word) ? 0 : linkPrice(rules, city, front, spec, args.day);
    out.links.push({ frontId: front.id, effect: spec.effect, ...(spec.word ? { word: true } : {}), price });
    out.holds.push({ frontId: front.id, effect: spec.effect, ...(spec.word ? { word: true } : {}) });
    out.price += price;
  }
  // Что изменённое держало, а оценщик для него больше не назвал, после правки идёт как прежде.
  // Названное иначе тоже отпускается: новый якорь встанет вместо старого.
  for (const hold of args.held?.holds ?? []) {
    const still = out.holds.some((h) => h.frontId === hold.frontId && h.effect === hold.effect && Boolean(h.word) === Boolean(hold.word));
    if (still) continue;
    out.ops.unshift({ op: 'release', target: args.held!.objectId, frontId: hold.frontId, effect: hold.effect });
    if (!seen.has(hold.frontId)) out.released.push(hold.frontId);
  }
  out.price = round2(out.price);
  return out;
}
