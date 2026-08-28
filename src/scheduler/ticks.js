import { normalizeWorld } from '../game/models.js';
import { nextAlignedTickAt, tickIntervalHours, tickIntervalMs } from '../game/tickClock.js';
import { getLogger } from '../log.js';

const STALE_TICK_MS = 45 * 60 * 1000;

async function patchScheduler(storage, patch) {
  const world = await storage.getWorld();
  normalizeWorld(world);
  world.scheduler = { ...world.scheduler, ...patch };
  await storage.saveWorld(world);
  return world;
}

/**
 * После успешного тика: lastTickAt=now, nextTickAt=следующая часовая граница.
 */
export async function recordTickCompleted(storage, config, now = Date.now()) {
  return patchScheduler(storage, {
    tickInProgress: false,
    tickStartedAt: null,
    lastTickAt: new Date(now).toISOString(),
    nextTickAt: nextAlignedTickAt(now, config),
  });
}

function pickNextTickAt(sch, config, now = Date.now()) {
  const aligned = nextAlignedTickAt(now, config);
  const alignedMs = new Date(aligned).getTime();
  const savedMs = sch?.nextTickAt ? new Date(sch.nextTickAt).getTime() : NaN;
  if (!Number.isFinite(savedMs)) return aligned;
  if (savedMs <= now) return aligned;
  return savedMs > alignedMs ? aligned : sch.nextTickAt;
}

/**
 * Расписание тиков с якорем в world.scheduler (Mongo/yaml).
 * Тики на 00:00 / 02:00 / … по часам сервера. Пропуск: один catch-up.
 */
export function startTickScheduler({ config, storage, onTick }) {
  if (!config.tick?.enabled) {
    return { stop() {}, triggerNow: async () => null, resync: async () => null };
  }

  const log = getLogger().child({ scope: 'scheduler' });
  let timer = null;
  let running = false;
  let stopped = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(nextTickAtIso) {
    if (stopped) return;
    clearTimer();
    const when = new Date(nextTickAtIso).getTime();
    const delay = Number.isFinite(when) ? Math.max(1000, when - Date.now()) : tickIntervalMs(config);
    log.info('scheduler.arm', { nextTickAt: nextTickAtIso, delayMs: delay });
    timer = setTimeout(() => {
      void runOne('schedule');
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function runOne(reason) {
    if (stopped || running) return null;
    running = true;
    const startedAt = new Date().toISOString();
    try {
      await patchScheduler(storage, {
        tickInProgress: true,
        tickStartedAt: startedAt,
      });
      log.info('scheduler.tick', { reason });
      const result = await onTick({ reason });
      const world = await recordTickCompleted(storage, config);
      arm(world.scheduler.nextTickAt);
      return result;
    } catch (err) {
      log.error('scheduler.tick_failed', { reason, error: err.message, stack: err.stack });
      try {
        const next = nextAlignedTickAt(Date.now(), config);
        await patchScheduler(storage, {
          tickInProgress: false,
          tickStartedAt: null,
          nextTickAt: next,
        });
        arm(next);
      } catch (e2) {
        log.error('scheduler.recover_failed', { error: e2.message });
      }
      throw err;
    } finally {
      running = false;
    }
  }

  async function resync() {
    if (stopped) return null;
    const world = await storage.getWorld();
    normalizeWorld(world);
    const next = pickNextTickAt(world.scheduler, config);
    if (next !== world.scheduler.nextTickAt) {
      await patchScheduler(storage, { nextTickAt: next });
    }
    const due = new Date(next).getTime() <= Date.now();
    if (due) {
      log.info('scheduler.catchup_one', { nextTickAt: next });
      try {
        return await runOne('catchup');
      } catch {
        return null;
      }
    }
    arm(next);
    return null;
  }

  async function boot() {
    const world = await storage.getWorld();
    normalizeWorld(world);
    const sch = world.scheduler;

    if (sch.tickInProgress && sch.tickStartedAt) {
      const age = Date.now() - new Date(sch.tickStartedAt).getTime();
      if (!Number.isFinite(age) || age > STALE_TICK_MS) {
        log.warn('scheduler.stale_in_progress_cleared', {
          tickStartedAt: sch.tickStartedAt,
          ageMs: age,
        });
        await patchScheduler(storage, {
          tickInProgress: false,
          tickStartedAt: null,
        });
      } else {
        log.warn('scheduler.wait_in_progress', { tickStartedAt: sch.tickStartedAt });
      }
    }

    await resync();
  }

  void boot();

  log.info('scheduler.start', {
    intervalHours: tickIntervalHours(config),
    intervalMs: tickIntervalMs(config),
  });

  return {
    stop() {
      stopped = true;
      clearTimer();
    },
    /** Force tick (admin/CLI): runs one tick and reschedules to the next clock boundary. */
    async triggerNow(reason = 'manual') {
      clearTimer();
      return runOne(reason);
    },
    resync,
  };
}
