import { createAppContext } from './bootstrap.js';
import { createWebServer } from './clients/web/server.js';
import { startTelegramBot } from './clients/telegram/bot.js';
import { startTickScheduler } from './scheduler/ticks.js';
import { runWorldTick } from './game/tick.js';

async function main() {
  const { config, storage, runtime, app } = await createAppContext();

  const web = createWebServer({ config, app, runtime, storage });
  const host = config.server.host || '127.0.0.1';
  const port = config.server.port || 3000;

  const server = web.listen(port, host, () => {
    console.log(`[cloudshire] web http://${host}:${port}`);
    console.log(`[cloudshire] storage=${storage.driver} world=${config.world.id}`);
  });

  const telegram = startTelegramBot({ config, app });

  const scheduler = startTickScheduler({
    config,
    onTick: async ({ reason }) => {
      console.log(`[tick] starting (${reason})`);
      const result = await runWorldTick({ config, runtime, storage, app });
      console.log(`[tick] done tick=${result.world.tickIndex} domains=${result.results.length}`);
    },
  });

  const shutdown = async () => {
    console.log('\n[cloudshire] shutting down…');
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
