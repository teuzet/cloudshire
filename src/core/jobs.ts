/**
 * Очередь заданий города по игровым дням.
 * Задание переживает падение процесса: claim отделён от complete, и после
 * трёх неудачных попыток оно гаснет, а не крутится вечно.
 */

import type { City, Front, Job, JobKind } from './city.js';
import { nextEventDay } from './world/fronts.js';

export const MAX_JOB_ATTEMPTS = 3;
const KEEP_SETTLED = 100;

export function scheduleJob(
  city: Pick<City, 'jobs'>,
  args: { id: string; kind: JobKind; dueDay: number; payload?: Job['payload'] },
): Job {
  const job: Job = {
    id: args.id,
    kind: args.kind,
    dueDay: Math.max(0, Math.round(args.dueDay)),
    payload: args.payload ?? {},
    state: 'pending',
    attempts: 0,
    lastError: null,
  };
  city.jobs.push(job);
  return job;
}

/** Снять ожидающие задания под условие. */
export function cancelJobs(city: Pick<City, 'jobs'>, predicate: (job: Job) => boolean): Job[] {
  const removed: Job[] = [];
  for (const job of city.jobs) {
    if (job.state !== 'pending' || !predicate(job)) continue;
    job.state = 'failed';
    job.lastError = 'cancelled';
    removed.push(job);
  }
  return removed;
}

/** Просроченные задания в порядке наступления; при равном дне — в порядке постановки. */
export function dueJobs(city: Pick<City, 'jobs'>, day: number): Job[] {
  return city.jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => job.state === 'pending' && job.dueDay <= day)
    .sort((a, b) => a.job.dueDay - b.job.dueDay || a.index - b.index)
    .map(({ job }) => job);
}

export function nextJobDay(city: Pick<City, 'jobs'>): number | null {
  let best: number | null = null;
  for (const job of city.jobs) {
    if (job.state !== 'pending') continue;
    if (best == null || job.dueDay < best) best = job.dueDay;
  }
  return best;
}

export function claimJob(job: Job): boolean {
  if (job.state !== 'pending') return false;
  job.state = 'running';
  job.attempts += 1;
  return true;
}

export function completeJob(job: Job): void {
  job.state = 'done';
}

export function failJob(job: Job, error: string): void {
  job.state = job.attempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending';
  job.lastError = error.slice(0, 300);
}

/** Задание, упавшее посреди работы вместе с процессом, снова ждёт своей очереди. */
export function recoverRunningJobs(city: Pick<City, 'jobs'>): number {
  let n = 0;
  for (const job of city.jobs) {
    if (job.state === 'running') {
      failJob(job, 'interrupted');
      n += 1;
    }
  }
  return n;
}

/** Выкинуть отработанное, чтобы очередь не росла вечно. */
export function pruneJobs(city: Pick<City, 'jobs'>): void {
  const settled = city.jobs.filter((j) => j.state === 'done' || j.state === 'failed');
  if (settled.length <= KEEP_SETTLED) return;
  const drop = new Set(settled.slice(0, settled.length - KEEP_SETTLED));
  city.jobs = city.jobs.filter((j) => !drop.has(j));
}

/** Одно ожидающее задание на фронт: ближайшая веха, срок или месячный бросок. */
export function scheduleFrontJob(city: Pick<City, 'jobs'>, front: Front, newId: () => string): Job | null {
  cancelJobs(city, (job) => job.payload.frontId === front.id);
  const day = nextEventDay(front);
  if (day == null) return null;
  return scheduleJob(city, { id: newId(), kind: 'front_event', dueDay: day, payload: { frontId: front.id } });
}
