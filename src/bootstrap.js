import { loadConfig } from './config.js';
import { createStorage } from './storage/index.js';
import { AgentRuntime } from './agents/runtime.js';
import { GameApp } from './game/app.js';
import { initLogger } from './log.js';

export async function createAppContext(configPath) {
  const config = loadConfig(configPath);
  const log = initLogger(config);
  const storage = await createStorage(config);
  const runtime = new AgentRuntime(config);
  const app = new GameApp({ config, storage, runtime });
  return { config, storage, runtime, app, log };
}
