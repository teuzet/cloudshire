/**
 * Общие шаги потоков над фронтами: пересчёт скорости с постановкой задания и вера.
 */

import type { City, Front } from '../core/city.js';
import { cancelJobs, scheduleFrontJob } from '../core/jobs.js';
import { faithImpulse } from '../core/world/faith.js';
import { activeFronts, recomputeRate, tempoSum } from '../core/world/fronts.js';
import { leadOf } from '../core/world/assignments.js';
import { appraiseFaith } from '../agents/faith-appraiser/run.js';
import { newId, tryAgent, type FlowDeps } from './context.js';

/** Пересчитать скорость фронта и поставить задание на его ближайшее событие. */
export function refreshFront(deps: FlowDeps, city: City, front: Front, day: number): void {
  recomputeRate(deps.rules, city, front, day);
  scheduleFrontJob(city, front, () => newId(deps, 'job'));
}

/** После любого события: скорости могли измениться у всех (заморозка, помощники, ведущие). */
export function refreshAllFronts(deps: FlowDeps, city: City, day: number): void {
  const alive = new Set(activeFronts(city).map((f) => f.id));
  cancelJobs(city, (job) => job.kind === 'front_event' && Boolean(job.payload.frontId) && !alive.has(job.payload.frontId as string));
  for (const front of activeFronts(city)) refreshFront(deps, city, front, day);
}

export function addFront(deps: FlowDeps, city: City, front: Front, day: number): Front {
  city.fronts.push(front);
  refreshFront(deps, city, front, day);
  return front;
}

/** По чьей воле шло дело: одной фразой для Оценщика веры. */
export function willWords(city: City, front: Front): string {
  if (front.origin === 'player' || front.origin === 'deed') {
    return tempoSum(city, front) > 0 ? 'Дело велел бог и торопил его.' : 'Дело велел бог.';
  }
  const source = front.origin === 'complication' ? 'Беда пришла от дела, которое велел бог.' : 'Беда пришла сама, бог её не насылал.';
  if (front.plus) return 'Случай выпал сам; воспользоваться им велел бог.';
  return `${source} ${leadOf(city, front.id) ? 'Отвести её велел бог.' : 'Унять её никто не взялся.'}`;
}

/** Оценщик веры выбирает случай и силу, число даёт таблица. Возвращает сдвиг веры. */
export async function faithEvent(deps: FlowDeps, city: City, args: { event: string; will: string; day: number }): Promise<number> {
  const ruling = await tryAgent(
    deps,
    'faith-appraiser',
    () => appraiseFaith(deps.agents, { event: args.event, will: args.will, recent: city.chronicle.slice(-4).map((e) => e.text.slice(0, 200)) }),
    null,
  );
  if (!ruling) return 0;
  return faithImpulse(deps.rules, city, ruling, args.day);
}
