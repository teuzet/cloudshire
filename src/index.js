import { createAppContext } from './bootstrap.js';
import { createWebServer } from './clients/web/server.js';
import { startTelegramBot } from './clients/telegram/bot.js';
import { startTickScheduler, recordTickCompleted } from './scheduler/ticks.js';
import { startDayScheduler } from './scheduler/days.js';
import { runWorldTick } from './game/tick.js';
import { runDayLoop } from './game/dayLoop.js';
import { DomainQueue } from './game/scheduler.js';
import { DAYS_PER_MONTH, skipGameDays } from './game/gameClock.js';
import { getLogger } from './log.js';

async function main() {
  const { config, storage, runtime, app, log, world } = await createAppContext();

  const web = createWebServer({ config, app, runtime, storage });
  const host = config.server.host || '0.0.0.0';
  const port = config.server.port || 3000;

  async function doTick(reason) {
    const tickLog = getLogger().child({ scope: 'tick', reason });
    tickLog.info('tick.start', { reason });
    const result = await runWorldTick({ config, runtime, storage, app });
    tickLog.info('tick.done', {
      tickIndex: result.world?.tickIndex ?? result.tickIndex ?? null,
      domains: result.results?.length ?? 0,
    });
    return result;
  }

  const scheduler = startTickScheduler({
    config,
    storage,
    onTick: ({ reason }) => doTick(reason),
  });

  // Один писатель на город: событие мира и ход правителя не пишут домен разом.
  const domainQueue = new DomainQueue();
  const days = startDayScheduler({
    config,
    storage,
    onDay: ({ reason }) =>
      runDayLoop({
        config,
        runtime,
        storage,
        app,
        queue: domainQueue,
        log: getLogger().child({ scope: 'dayLoop', reason }),
      }),
  });
  app.onClockReleased = (reason) => days.triggerNow(reason);

  /**
   * Ручной сдвиг времени. Месячная доска сопряжения ходит тиком, одиночный
   * город — часами: без промотки часов ему в дневном цикле нечего разбирать,
   * и force_tick выглядел бы сломанным.
   */
  web.set('runTick', async (reason = 'manual') => {
    const world = await storage.getWorld();
    const day = skipGameDays(world, DAYS_PER_MONTH, { config });
    await storage.saveWorld(world);
    getLogger().info('tick.skip_days', { reason, days: DAYS_PER_MONTH, day });

    const result = scheduler.triggerNow
      ? await scheduler.triggerNow(reason)
      : await (async () => {
          const r = await doTick(reason);
          await recordTickCompleted(storage, config);
          return r;
        })();
    await days.triggerNow(reason);
    return result;
  });
  web.set('resyncScheduler', async () => {
    if (typeof scheduler.resync === 'function') return scheduler.resync();
    return null;
  });

  const server = web.listen(port, host, () => {
    log.info('server.listen', {
      url: `http://${host}:${port}`,
      storage: storage.driver,
      worldId: world?.id || null,
      seasonKey: world?.seasonKey || config.world.id,
      logFile: log.filePath || null,
      adminAuth: Boolean(config.admin?.user && config.admin?.password),
    });
  });

  const telegram = startTelegramBot({
    config,
    app,
    storage,
    runTick: (reason = 'telegram-force') => web.get('runTick')(reason),
  });
  log.info('telegram.status', {
    enabled: Boolean(config.telegram?.enabled),
    running: Boolean(telegram.enabled),
  });

  const shutdown = async () => {
    log.info('session.shutdown');
    scheduler.stop();
    days.stop();
    await telegram.stop?.();
    server.close();
    await storage.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
