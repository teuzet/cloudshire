/**
 * Сборка приложения для клиентов: конфиг с диска, адаптеры по окружению, мир.
 * Ключи берутся только из окружения и никуда не пишутся.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { systemClock } from '../adapters/clock/system.js';
import { AnthropicLlm } from '../adapters/llm/anthropic.js';
import { OpenAiLlm } from '../adapters/llm/openai.js';
import { RoutingLlm } from '../adapters/llm/router.js';
import { systemRandom } from '../adapters/random/system.js';
import { FileStorage } from '../adapters/storage/file.js';
import { MongoStorage } from '../adapters/storage/mongo.js';
import { parseAgentSettings } from '../agents/_shared/settings.js';
import { parseRules } from '../core/rules.js';
import { parseScenario } from '../core/world/scenario.js';
import { CityLocks } from '../flows/city-lock.js';
import type { FlowDeps, FlowLog } from '../flows/context.js';
import { ensureWorld, type NamesFile } from '../flows/world.js';
import type { Llm } from '../ports/llm.js';
import type { Notifier } from '../ports/notifier.js';
import type { Storage } from '../ports/storage.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Локально ключи удобно держать в .env (он в .gitignore). В облаке они приходят из секретов окружения. */
export function loadDotEnv(): void {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}

export function readYaml(file: string): unknown {
  return yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

export function loadScenarios() {
  const dir = path.join(ROOT, 'scenarios');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parseScenario(readYaml(`scenarios/${f}`)));
}

export const consoleLog: FlowLog = {
  warn(event, data) {
    console.warn(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  },
};

export function buildLlm(env: NodeJS.ProcessEnv): Llm {
  const providers: Record<string, Llm> = {};
  if (env.OPENAI_API_KEY) providers.openai = new OpenAiLlm({ apiKey: env.OPENAI_API_KEY });
  if (env.ANTHROPIC_API_KEY) providers.anthropic = new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY });
  if (!Object.keys(providers).length) throw new Error('нет ключей моделей: задай OPENAI_API_KEY и/или ANTHROPIC_API_KEY');
  return new RoutingLlm(providers);
}

async function buildStorage(env: NodeJS.ProcessEnv): Promise<{ storage: Storage; close: () => Promise<void> }> {
  if (env.MONGODB_URI) {
    const mongo = await MongoStorage.connect(env.MONGODB_URI, env.MONGODB_DB ?? 'cloudshire');
    return { storage: mongo, close: () => mongo.close() };
  }
  const dir = path.resolve(env.DATA_DIR ?? path.join(ROOT, 'data'));
  return { storage: new FileStorage(dir), close: async () => undefined };
}

export interface App {
  deps: FlowDeps;
  locks: CityLocks;
  close: () => Promise<void>;
}

export async function buildApp(env: NodeJS.ProcessEnv, notifier: Notifier, overrides: { llm?: Llm } = {}): Promise<App> {
  const rules = parseRules(readYaml('config/game.yaml'));
  const settings = parseAgentSettings(readYaml('config/agents.yaml'));
  const { storage, close } = await buildStorage(env);
  const deps: FlowDeps = {
    rules,
    agents: { llm: overrides.llm ?? buildLlm(env), settings },
    storage,
    clock: systemClock,
    random: systemRandom,
    notifier,
    scenarios: loadScenarios(),
    log: consoleLog,
  };
  await ensureWorld(deps, { names: readYaml('config/names.yaml') as NamesFile });
  return { deps, locks: new CityLocks(), close };
}
