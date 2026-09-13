/**
 * Будильник непрерывного времени.
 *
 * Месячный тик просыпался по часам, потому что был календарём. Дневной цикл
 * ничего не отсчитывает — он просыпается к сроку ближайшего дела или беды.
 * Поэтому расписание считается из очереди заданий, а не из интервала.
 *
 * Нижняя граница нужна против плотной очереди (иначе цикл встанет в busy-loop),
 * верхняя — против пустой: без неё мир, у которого нечего разбирать, никогда
 * не проснулся бы и не завёл себе новых сроков.
 */

import { normalizeWorld } from '../game/models.js';
import { startClock } from '../game/gameClock.js';
import { nextWakeAt, rulerTurnStale } from '../game/scheduler.js';
import { getLogger } from '../log.js';

export const MIN_WAKE_MS = 5_000;
export const MAX_WAKE_MS = 4 * 60 * 1000;

export function wakeDelayMs(world, { config = null, now = Date.now() } = {}) {
  if (world?.clockHeldAt != null) return MAX_WAKE_MS;
  // Ход правителя держит часы: смысла просыпаться раньше предохранителя нет.
  if (world?.turnStartedAt != null && !rulerTurnStale(world, now)) return MAX_WAKE_MS;
  const at = nextWakeAt(world, { config });
  if (at == null) return MAX_WAKE_MS;
  return Math.max(MIN_WAKE_MS, Math.min(MAX_WAKE_MS, at - now));
}

export function startDayScheduler({ config, storage, onDay }) {
  if (config?.time?.enabled === false) {
    return { stop() {}, triggerNow: async () => null, resync: async () => null };
  }

  const log = getLogger().child({ scope: 'dayScheduler' });
  let timer = null;
  let stopped = false;
  // Промотка не должна теряться, если цикл уже идёт: очередь дождётся
  // текущего прохода и разберёт просроченные стыковки на новом дне.
  let tail = Promise.resolve();

  function arm(delay) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void enqueue('schedule');
    }, Math.max(MIN_WAKE_MS, delay));
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function runOne(reason) {
    if (stopped) return null;
    try {
      return await onDay({ reason });
    } catch (err) {
      log.error('dayScheduler.failed', { reason, error: err.message, stack: err.stack });
      return null;
    } finally {
      try {
        const world = await storage.getWorld();
        normalizeWorld(world, config);
        startClock(world);
        arm(wakeDelayMs(world, { config }));
      } catch (err) {
        log.error('dayScheduler.rearm_failed', { error: err.message });
        arm(MAX_WAKE_MS);
      }
    }
  }

  function enqueue(reason) {
    const run = tail.then(() => runOne(reason));
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  void enqueue('boot');
  log.info('dayScheduler.start', { minWakeMs: MIN_WAKE_MS, maxWakeMs: MAX_WAKE_MS });

  async function resync() {
    if (stopped) return;
    try {
      const world = await storage.getWorld();
      normalizeWorld(world, config);
      startClock(world);
      arm(wakeDelayMs(world, { config }));
    } catch (err) {
      log.error('dayScheduler.resync_failed', { error: err.message });
      arm(MAX_WAKE_MS);
    }
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    triggerNow(reason = 'manual') {
      return enqueue(reason);
    },
    resync,
  };
}
