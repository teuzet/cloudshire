/**
 * Срок фронта в общей очереди заданий мира.
 * Одно ожидающее задание на фронт: ближайший порог или ставка.
 */

import { cancelJobs, scheduleJob } from '../game/scheduler.js';
import { nextEventDay, nextEventKind, recomputeRate } from './front.js';

export function cancelFrontJobs(world, frontId) {
  const needle = String(frontId || '');
  return cancelJobs(world, (job) => job.payload?.frontId === needle);
}

export function scheduleFrontJob(world, domain, front) {
  if (!world || !front) return null;
  cancelFrontJobs(world, front.id);
  const dueDay = nextEventDay(front);
  const kind = nextEventKind(front);
  if (dueDay == null || !kind) return null;
  return scheduleJob(world, {
    domainId: domain?.id || null,
    kind,
    dueDay,
    payload: { frontId: front.id },
  });
}

/** Завести срок каждому живому фронту. Старые задания того же фронта снимаются. */
export function armFrontSchedule(config, domain, world, day) {
  for (const front of domain?.fronts || []) {
    if (!front || front.status !== 'active') continue;
    recomputeRate(config, front, domain, day);
    scheduleFrontJob(world, domain, front);
  }
}
