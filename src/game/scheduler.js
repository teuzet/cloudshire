/**
 * Планировщик: очередь заданий на игровой день вместо мирового тика.
 *
 * Задания персистентны — падение посреди вызова модели не должно ни потерять
 * событие, ни выдать его дважды. Поэтому `claim` отделён от `complete`.
 */

import { currentDay, realTimeOfDay } from './gameClock.js';

export const JOB_KINDS = [
  'threat_fire',
  'process_finish',
  'seed_attempt',
  'seed_appear',
  'priest_report',
  'conflux_beat',
];

export const JOB_STATES = ['pending', 'running', 'done', 'failed'];

/** Ход правителя не может держать время домена дольше этого. */
export const RULER_TURN_FAILSAFE_MS = 180_000;

let jobCounter = 0;

function nextJobId(kind) {
  jobCounter += 1;
  return `job_${kind}_${Date.now().toString(36)}_${jobCounter}`;
}

export function jobList(world) {
  if (!Array.isArray(world?.jobs)) {
    if (world && typeof world === 'object') world.jobs = [];
    else return [];
  }
  return world.jobs;
}

export function scheduleJob(world, { domainId, kind, dueDay, payload = {}, id = null } = {}) {
  const job = {
    id: id || nextJobId(kind || 'job'),
    domainId: domainId || null,
    kind: String(kind || ''),
    dueDay: Math.round(Number(dueDay) || 0),
    state: 'pending',
    payload,
    attempts: 0,
  };
  jobList(world).push(job);
  return job;
}

export function findJob(world, jobId) {
  return jobList(world).find((j) => j.id === jobId) || null;
}

/** Снять с очереди всё, что подходит под условие. Возвращает снятые задания. */
export function cancelJobs(world, predicate) {
  const removed = [];
  const jobs = jobList(world);
  for (const job of jobs) {
    if (job.state !== 'pending') continue;
    if (!predicate(job)) continue;
    job.state = 'failed';
    job.cancelled = true;
    removed.push(job);
  }
  return removed;
}

export function cancelJobsForPlot(world, plotId) {
  return cancelJobs(world, (j) => j.payload?.plotId === plotId);
}

export function cancelJobsForThreat(world, threatId) {
  return cancelJobs(world, (j) => j.kind === 'threat_fire' && j.payload?.threatId === threatId);
}

/**
 * Просроченные задания в порядке наступления.
 * Порядок стабилен: при равном дне побеждает раньше поставленное.
 */
export function dueJobs(world, day, { domainId = null } = {}) {
  const d = Math.round(Number(day) || 0);
  return jobList(world)
    .filter((j) => j.state === 'pending' && j.dueDay <= d && (!domainId || j.domainId === domainId))
    .sort((a, b) => a.dueDay - b.dueDay || jobList(world).indexOf(a) - jobList(world).indexOf(b));
}

export function nextJobDay(world, { domainId = null } = {}) {
  let best = null;
  for (const job of jobList(world)) {
    if (job.state !== 'pending') continue;
    if (domainId && job.domainId !== domainId) continue;
    if (best == null || job.dueDay < best) best = job.dueDay;
  }
  return best;
}

/** Реальный момент, когда стоит проснуться. */
export function nextWakeAt(world, { config = null, domainId = null } = {}) {
  const day = nextJobDay(world, { domainId });
  if (day == null) return null;
  return realTimeOfDay(world, day, { config, pausedMs: world?.pausedMs || 0 });
}

export function claimJob(job) {
  if (!job || job.state !== 'pending') return false;
  job.state = 'running';
  job.attempts = Math.max(0, Math.round(Number(job.attempts) || 0)) + 1;
  job.startedAt = new Date().toISOString();
  return true;
}

export function completeJob(job, result = null) {
  if (!job) return false;
  job.state = 'done';
  job.finishedAt = new Date().toISOString();
  if (result != null) job.result = result;
  return true;
}

export function failJob(job, error = '') {
  if (!job) return false;
  job.state = job.attempts >= 3 ? 'failed' : 'pending';
  job.lastError = String(error || '').slice(0, 300);
  return true;
}

/** Выкинуть отработанное, чтобы очередь не росла вечно. */
export function pruneJobs(world, { keep = 200 } = {}) {
  const jobs = jobList(world);
  const settled = jobs.filter((j) => j.state === 'done' || j.state === 'failed');
  if (settled.length <= keep) return 0;
  const drop = new Set(settled.slice(0, settled.length - keep));
  world.jobs = jobs.filter((j) => !drop.has(j));
  return drop.size;
}

// ─────────────────────────── ход правителя ───────────────────────────

/**
 * Ход правителя останавливает время домена: пока жрец думает, мир не должен
 * уехать вперёд, иначе ответ будет про мир, которого уже нет.
 */
export function beginRulerTurn(world, now = Date.now()) {
  if (!world || typeof world !== 'object') return world;
  world.turnStartedAt = now;
  return world;
}

export function endRulerTurn(world, now = Date.now()) {
  if (!world || typeof world !== 'object') return world;
  const started = openTurnStart(world);
  if (started != null) {
    const held = Math.min(RULER_TURN_FAILSAFE_MS, Math.max(0, now - started));
    world.pausedMs = Math.max(0, Number(world.pausedMs) || 0) + held;
  }
  world.turnStartedAt = null;
  return world;
}

/** Открытый ход, если он есть. `null` и `0` — разные вещи: день 0 тоже день. */
function openTurnStart(world) {
  const raw = world?.turnStartedAt;
  if (raw == null) return null;
  const started = Number(raw);
  return Number.isFinite(started) ? started : null;
}

/** Зависший ход сбрасывается предохранителем, а не остаётся вечной паузой. */
export function rulerTurnStale(world, now = Date.now()) {
  const started = openTurnStart(world);
  if (started == null) return false;
  return now - started >= RULER_TURN_FAILSAFE_MS;
}

export function worldDay(world, { now = Date.now(), config = null } = {}) {
  let pausedMs = Math.max(0, Number(world?.pausedMs) || 0);
  const started = openTurnStart(world);
  if (started != null) {
    pausedMs += Math.min(RULER_TURN_FAILSAFE_MS, Math.max(0, now - started));
  }
  return currentDay(world, { now, config, pausedMs });
}

// ─────────────────────── один писатель на домен ───────────────────────

/**
 * Серийная очередь на домен. Всё, что мутирует домен, идёт через неё:
 * событие мира, ход правителя, разбор нити. Один писатель — нет гонок.
 */
export class DomainQueue {
  constructor() {
    this.tails = new Map();
  }

  size(domainId) {
    return this.tails.has(domainId) ? 1 : 0;
  }

  run(domainId, fn) {
    const key = String(domainId || '_');
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(
      key,
      next.then(
        () => {
          if (this.tails.get(key) === next) this.tails.delete(key);
        },
        () => {
          if (this.tails.get(key) === next) this.tails.delete(key);
        },
      ),
    );
    return next;
  }
}

/**
 * Замки на нити для событий, которые пишут в два домена (сопряжение).
 * Берутся в отсортированном порядке — иначе два события возьмут их
 * в разном порядке и встанут насмерть.
 */
export class LockSet {
  constructor() {
    this.held = new Map();
  }

  async acquire(keys) {
    const sorted = [...new Set(keys.map(String))].sort();
    const releases = [];
    for (const key of sorted) {
      const prev = this.held.get(key);
      if (prev) await prev;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      this.held.set(key, gate);
      releases.push(() => {
        if (this.held.get(key) === gate) this.held.delete(key);
        release();
      });
    }
    return () => {
      for (const r of releases.reverse()) r();
    };
  }
}
