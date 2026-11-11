/**
 * Каскад по refs. Связь «X ссылается на Y» значит: если Y заметно изменился,
 * X стоит перепроверить. Один агент видит одно изменение и одну сущность,
 * а весь граф города никто не получает.
 *
 * Здесь только чистые шаги; сам проход с агентом живёт во flow.
 */

import type { City, Front, WorldObject } from '../city.js';
import { deleteObject, findObject } from './objects.js';
import { findFront } from './fronts.js';

export type CascadeVerdict =
  | { verdict: 'unchanged' }
  | { verdict: 'updated'; text: string }
  | { verdict: 'invalid' }
  | { verdict: 'resolved' };

export type CascadeEntity = { kind: 'object'; entity: WorldObject } | { kind: 'front'; entity: Front };

export interface CascadeChange {
  id: string;
  kind: 'created' | 'modified' | 'deleted' | 'invalid' | 'resolved';
}

/** Кто ссылается на сущность `id`: только живые объекты и фронты. */
export function subscribersOf(city: Pick<City, 'objects' | 'fronts'>, id: string): CascadeEntity[] {
  const out: CascadeEntity[] = [];
  for (const obj of city.objects) {
    if (obj.status === 'active' && obj.refs.includes(id)) out.push({ kind: 'object', entity: obj });
  }
  for (const front of city.fronts) {
    if (front.status === 'active' && front.refs.includes(id)) out.push({ kind: 'front', entity: front });
  }
  return out;
}

export function entityById(city: Pick<City, 'objects' | 'fronts'>, id: string): CascadeEntity | null {
  const obj = findObject(city, id);
  if (obj) return { kind: 'object', entity: obj };
  const front = findFront(city, id);
  return front ? { kind: 'front', entity: front } : null;
}

/** Применить вердикт к одной сущности. Возвращает новые изменения для следующего шага. */
export function applyCascadeVerdict(target: CascadeEntity, verdict: CascadeVerdict, day: number): CascadeChange[] {
  if (verdict.verdict === 'unchanged') return [];
  if (verdict.verdict === 'updated') {
    if (verdict.text.trim()) target.entity.description = verdict.text.trim();
    return [];
  }
  if (target.kind === 'object') {
    if (target.entity.status !== 'deleted') deleteObject(target.entity, day);
    return [{ id: target.entity.id, kind: 'deleted' }];
  }
  target.entity.status = verdict.verdict;
  target.entity.resolvedDay = Math.max(0, Math.round(day));
  return [{ id: target.entity.id, kind: verdict.verdict }];
}

/**
 * Обход в ширину с потолком шагов. `judge` — агент или подставка в тесте.
 */
export async function runCascade(
  city: City,
  start: CascadeChange[],
  args: {
    day: number;
    maxSteps: number;
    judge: (change: CascadeChange, target: CascadeEntity) => Promise<CascadeVerdict>;
  },
): Promise<Array<{ id: string; verdict: CascadeVerdict['verdict'] }>> {
  const queue = [...start];
  const seen = new Set<string>();
  const applied: Array<{ id: string; verdict: CascadeVerdict['verdict'] }> = [];
  let steps = 0;
  while (queue.length && steps < args.maxSteps) {
    const change = queue.shift();
    if (!change) break;
    for (const target of subscribersOf(city, change.id)) {
      if (steps >= args.maxSteps) break;
      const key = `${target.kind}:${target.entity.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      steps += 1;
      const verdict = await args.judge(change, target);
      applied.push({ id: target.entity.id, verdict: verdict.verdict });
      queue.push(...applyCascadeVerdict(target, verdict, args.day));
    }
  }
  return applied;
}
