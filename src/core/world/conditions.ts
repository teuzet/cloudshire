/**
 * Условный приказ: поручение в очереди ждёт, пока в городе случится то, о чём сказал покровитель.
 * Код решает, когда спросить (с тем, за чем следят, что-то случилось), узкий агент решает, сбылось ли.
 * Условие гаснет, когда кончилось всё, за чем следили.
 */

import type { ChronicleEntry, City, Front, QueuedOrder } from '../city.js';
import type { Change } from './changes.js';
import { findFront, frontTouches } from './fronts.js';

/** Сколько последних событий ждёт сверки у одного условия: старшие уже не важны. */
const HEARD_MAX = 4;

export type Conditional = QueuedOrder & { condition: NonNullable<QueuedOrder['condition']> };

export function conditionalOrders(city: Pick<City, 'queue'>): Conditional[] {
  return (city.queue ?? []).filter((q): q is Conditional => Boolean(q.condition));
}

/** Отслеживаемые дела, которые ещё есть в городе. */
function watchedFronts(city: Pick<City, 'fronts'>, order: Conditional): Front[] {
  return order.condition.watch.map((id) => findFront(city, id)).filter((f): f is Front => Boolean(f));
}

/** Части города, за которыми условие следит: участники и носители отслеживаемых дел. */
export function watchedObjects(city: Pick<City, 'fronts' | 'objects'>, order: Conditional): Set<string> {
  const out = new Set<string>();
  for (const f of watchedFronts(city, order)) {
    for (const id of frontTouches(city, f)) out.add(id);
    if (f.livesOn) out.add(f.livesOn);
  }
  return out;
}

/**
 * Касается ли событие условия: веха или конец отслеживаемого дела, перемена его участника,
 * новая беда рядом. У условия без отслеживаемого слушаются только новые беды города.
 */
export function touchesCondition(city: Pick<City, 'fronts' | 'objects'>, order: Conditional, entry: Pick<ChronicleEntry, 'frontId' | 'day'>, changes: readonly Change[]): boolean {
  const watch = new Set(order.condition.watch);
  const fronts = [entry.frontId, ...changes.map((c) => ('frontId' in c ? c.frontId : null))].filter((id): id is string => Boolean(id));
  if (fronts.some((id) => watch.has(id))) return true;
  const objects = watchedObjects(city, order);
  if (changes.some((c) => 'objectId' in c && objects.has(c.objectId))) return true;
  // Новое дело: открылось в день события. Свои дела покровителя бедами не считаются.
  const fresh = [...new Set(fronts)]
    .map((id) => findFront(city, id))
    .filter((f): f is Front => Boolean(f && f.status === 'active' && f.createdDay === entry.day && f.origin !== 'deed' && f.origin !== 'player'));
  if (!watch.size) return fresh.length > 0;
  return fresh.some((f) => frontTouches(city, f).some((id) => objects.has(id)) || (f.livesOn ? objects.has(f.livesOn) : false));
}

/** Запомнить событие у тех условий, которых оно касается: сверка пройдёт на ближайшем проходе жреца. */
export function hearEvent(city: City, entry: ChronicleEntry, changes: readonly Change[]): void {
  for (const order of conditionalOrders(city)) {
    if (!touchesCondition(city, order, entry, changes)) continue;
    order.condition.heard = [...order.condition.heard, entry.text].slice(-HEARD_MAX);
  }
}

/** Всё, за чем следило условие, кончилось: ждать больше нечего. У условия без отслеживаемого так не бывает. */
export function conditionGone(city: Pick<City, 'fronts'>, order: Conditional): boolean {
  if (!order.condition.watch.length) return false;
  return watchedFronts(city, order).every((f) => f.status !== 'active');
}
