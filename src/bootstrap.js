import path from 'node:path';
import { loadConfig, projectRoot } from './config.js';
import { createStorage } from './storage/index.js';
import { AgentRuntime } from './agents/runtime.js';
import { GameApp } from './game/app.js';
import { initLogger, setLoggerWorldId } from './log.js';
import { initUsageRecording } from './llm/usage.js';

/**
 * @param {string | { configPath?: string, dataDir?: string }} [opts]
 */
export async function createAppContext(opts) {
  const options =
    typeof opts === 'string' || opts == null
      ? { configPath: opts }
      : opts;

  const config = loadConfig(options.configPath);
  if (options.dataDir) {
    const dir = path.isAbsolute(options.dataDir)
      ? options.dataDir
      : path.join(projectRoot(), options.dataDir);
    config.storage = config.storage || {};
    config.storage.yaml = { ...(config.storage.yaml || {}), dir };
  }

  const log = initLogger(config);
  const storage = await createStorage(config);
  const world = await storage.getWorld();
  if (world?.id) {
    setLoggerWorldId(world.id);
    initUsageRecording(config, world.id);
    log.info('world.active', {
      worldId: world.id,
      seasonKey: world.seasonKey || null,
      tickIndex: world.tickIndex,
      gameDate: world.gameDate?.label,
    });
  } else {
    initUsageRecording(config, null);
  }
  const runtime = new AgentRuntime(config);
  const app = new GameApp({ config, storage, runtime });
  return { config, storage, runtime, app, log, world };
}
