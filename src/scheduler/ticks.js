import { normalizeWorld } from '../game/models.js';
import { getLogger } from '../log.js';

const STALE_TICK_MS = 45 * 60 * 1000;

function intervalMs(config) {
  return (Number(config.tick?.intervalHours) || 2) * 60 * 60 * 1000;
}

async function patchScheduler(storage, patch) {
  const world = await storage.getWorld();
  normalizeWorld(world);
  world.scheduler = { ...world.scheduler, ...patch };
  await storage.saveWorld(world);
  return world;
}

/**
 * После успешного тика: lastTickAt=now, nextTickAt=now+interval.
 */
export async function recordTickCompleted(storage, config) {
  const now = Date.now();
  const next = new Date(now + intervalMs(config)).toISOString();
  return patchScheduler(storage, {
    tickInProgress: false,
    tickStartedAt: null,
    lastTickAt: new Date(now).toISOString(),
    nextTickAt: next,
  });
}

/**
 * Расписание тиков с якорем в world.scheduler (Mongo/yaml).
 * Пропущенные тики: максимум один catch-up при старте / по таймеру.
 */
export function startTickScheduler({ config, storage, onTick }) {
  if (!config.tick?.enabled) {
    return { stop() {}, triggerNow: async () => null };
  }

  const ms = intervalMs(config);
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
    const delay = Number.isFinite(when) ? Math.max(1000, when - Date.now()) : ms;
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
        const next = new Date(Date.now() + ms).toISOString();
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

    let next = sch.nextTickAt;
    if (!next) {
      next = new Date(Date.now() + ms).toISOString();
      await patchScheduler(storage, { nextTickAt: next });
      log.info('scheduler.seed_next', { nextTickAt: next, intervalHours: config.tick.intervalHours });
    }

    const due = new Date(next).getTime() <= Date.now();
    if (due) {
      log.info('scheduler.catchup_one', { nextTickAt: next });
      try {
        await runOne('catchup');
      } catch {
        /* already logged; timer re-armed in runOne */
      }
    } else {
      arm(next);
    }
  }

  void boot();

  log.info('scheduler.start', { intervalHours: config.tick.intervalHours, intervalMs: ms });

  return {
    stop() {
      stopped = true;
      clearTimer();
    },
    /** Force tick (admin/CLI): runs one tick and reschedules from completion. */
    async triggerNow(reason = 'manual') {
      clearTimer();
      return runOne(reason);
    },
  };
}
