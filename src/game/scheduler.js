/**
 * Планировщик: очередь заданий на игровой день вместо мирового тика.
 *
 * Задания персистентны — падение посреди вызова модели не должно ни потерять
 * событие, ни выдать его дважды. Поэтому `claim` отделён от `complete`.
 */

import { currentDay, realTimeOfDay, skipGameDays } from './gameClock.js';

export const JOB_KINDS = [
  'threat_fire',
  'process_finish',
  'seed_attempt',
  'seed_appear',
  'conflux_beat',
  'conflux_dock',
  'conflux_undock',
  'conflux_contact',
  'conflux_transfer',
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
export function nextWakeAt(world, { config = null, domainId = null, now = Date.now() } = {}) {
  const day = nextJobDay(world, { domainId });
  if (day == null) return null;
  return realTimeOfDay(world, day, { config, pausedMs: clockPausedMs(world, now) });
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

const SETTLED = new Set(['done', 'failed']);

/**
 * Слить очередь заданий: свою правленую копию поверх свежей из хранилища.
 *
 * Мир держат минутами — дневной цикл разбирает задания, пока жрец в чате
 * заводит дело и ставит своё. Кто сохранит последним, тот затрёт чужое, а
 * потерянное задание означает дело, которое никогда не кончится.
 *
 * Правила: отработанное не воскресает (иначе событие выстрелит дважды),
 * чужие задания остаются, свои новые дописываются.
 */
export function mergeWorldJobs(fresh, mine) {
  const theirs = jobList(fresh);
  const ours = Array.isArray(mine?.jobs) ? mine.jobs : [];
  const ourById = new Map(ours.map((job) => [job.id, job]));
  const merged = theirs.map((job) => {
    const own = ourById.get(job.id);
    if (!own) return job;
    return SETTLED.has(job.state) && !SETTLED.has(own.state) ? job : own;
  });
  const known = new Set(theirs.map((j) => j.id));
  for (const job of ours) {
    if (!known.has(job.id)) merged.push(job);
  }
  fresh.jobs = merged;
  return fresh;
}

/**
 * Отдать свою правку мира, не затирая чужую.
 *
 * Мир общий: часы правит движок времени, ход правителя — чат, очередь — все
 * разом, пул имён — генезис. Тот, кто держал копию минутами и пишет её
 * целиком, отбирает у остальных всё, что они успели записать. Поэтому писатель
 * называет, чем владеет, и переносит в свежий мир только это.
 */
export function commitWorldChanges(fresh, mine, { fields = [] } = {}) {
  if (!fresh || !mine) return fresh;
  mergeWorldJobs(fresh, mine);
  for (const field of fields) fresh[field] = mine[field];
  return fresh;
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
export function beginRulerTurn(world, now = Date.now(), { domainId = null } = {}) {
  if (!world || typeof world !== 'object') return world;
  world.turnStartedAt = now;
  // Чей ход: дневной цикл уступает только этому городу, остальные идут дальше.
  world.turnDomainId = domainId ? String(domainId) : null;
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
  world.turnDomainId = null;
  return world;
}

/** Идёт ли прямо сейчас ход правителя этого города. */
export function rulerTurnHolds(world, domainId, now = Date.now()) {
  if (openTurnStart(world) == null) return false;
  if (rulerTurnStale(world, now)) return false;
  const held = world?.turnDomainId;
  // Старые миры без пометки города: считаем, что ход держит весь мир.
  if (!held) return true;
  return String(held) === String(domainId);
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
  return currentDay(world, { now, config, pausedMs: clockPausedMs(world, now) });
}

/** Промотать живой мир на игровые дни и записать. Пауза часов учитывается. */
export async function skipStoredWorldDays(storage, days, { config = null, now = Date.now() } = {}) {
  const jump = Math.max(0, Math.round(Number(days) || 0));
  let day = 0;
  const world = await storage.updateWorld((fresh) => {
    day = skipGameDays(fresh, jump, {
      config,
      now,
      pausedMs: clockPausedMs(fresh, now),
    });
  });
  if (!world) throw new Error('мира нет');
  return { day, days: jump, world };
}

function clockHeldAt(world) {
  const raw = world?.clockHeldAt;
  if (raw == null) return null;
  const held = Number(raw);
  return Number.isFinite(held) ? held : null;
}

/** Сколько реального времени часы мира уже не тикали. */
export function clockPausedMs(world, now = Date.now()) {
  let paused = Math.max(0, Number(world?.pausedMs) || 0);
  const started = openTurnStart(world);
  if (started != null) {
    paused += Math.min(RULER_TURN_FAILSAFE_MS, Math.max(0, now - started));
  }
  const held = clockHeldAt(world);
  if (held != null) paused += Math.max(0, now - held);
  return paused;
}

export function clockIsHeld(world) {
  return clockHeldAt(world) != null;
}

/** Остановить ход игрового времени: дела и истории сами не наступают. */
export function holdClock(world, now = Date.now()) {
  if (!world || typeof world !== 'object') return world;
  if (clockHeldAt(world) != null) return world;
  world.clockHeldAt = now;
  return world;
}

/** Снова пустить время. Накопленную паузу складываем в pausedMs. */
export function releaseClock(world, now = Date.now()) {
  if (!world || typeof world !== 'object') return world;
  const held = clockHeldAt(world);
  if (held == null) return world;
  world.pausedMs = Math.max(0, Number(world.pausedMs) || 0) + Math.max(0, now - held);
  world.clockHeldAt = null;
  return world;
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

  /**
   * Занят ли город прямо сейчас. Проверка синхронная, и это важно: между ней
   * и постановкой в очередь не должно быть await, иначе двое решат, что свободно.
   */
  busy(domainId) {
    return this.tails.has(String(domainId || '_'));
  }

  run(domainId, fn) {
    const key = String(domainId || '_');
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    this.tails.set(key, next);
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
