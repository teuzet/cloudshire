import { createAppContext } from './bootstrap.js';
import { createWebServer } from './clients/web/server.js';
import { startTelegramBot } from './clients/telegram/bot.js';
import { startTickScheduler } from './scheduler/ticks.js';
import { runWorldTick } from './game/tick.js';
import { getLogger } from './log.js';

async function main() {
  const { config, storage, runtime, app, log, world } = await createAppContext();

  const web = createWebServer({ config, app, runtime, storage });
  const host = config.server.host || '127.0.0.1';
  const port = config.server.port || 3000;

  const server = web.listen(port, host, () => {
    log.info('server.listen', {
      url: `http://${host}:${port}`,
      storage: storage.driver,
      worldId: world?.id || null,
      seasonKey: world?.seasonKey || config.world.id,
      logFile: log.filePath,
    });
  });

  const telegram = startTelegramBot({ config, app, storage });
  log.info('telegram.status', {
    enabled: Boolean(config.telegram?.enabled),
    running: Boolean(telegram.enabled),
  });

  const scheduler = startTickScheduler({
    config,
    onTick: async ({ reason }) => {
      const tickLog = getLogger().child({ scope: 'tick', reason });
      tickLog.info('tick.start', { reason });
      const result = await runWorldTick({ config, runtime, storage, app });
      tickLog.info('tick.done', {
        tickIndex: result.world.tickIndex,
        domains: result.results.length,
      });
    },
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
