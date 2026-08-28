import { createAppContext } from './bootstrap.js';
import { createWebServer } from './clients/web/server.js';
import { startTelegramBot } from './clients/telegram/bot.js';
import { startTickScheduler, recordTickCompleted } from './scheduler/ticks.js';
import { runWorldTick } from './game/tick.js';
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
      tickIndex: result.world.tickIndex,
      domains: result.results.length,
    });
    return result;
  }

  const scheduler = startTickScheduler({
    config,
    storage,
    onTick: ({ reason }) => doTick(reason),
  });

  web.set('runTick', async (reason = 'manual') => {
    if (scheduler.triggerNow) {
      return scheduler.triggerNow(reason);
    }
    const result = await doTick(reason);
    await recordTickCompleted(storage, config);
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
