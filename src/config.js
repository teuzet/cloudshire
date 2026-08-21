import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function truthyEnv(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return null;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

export function loadConfig(configPath = process.env.CLOUDSHIRE_CONFIG || 'config/default.yaml') {
  const absolute = path.isAbsolute(configPath) ? configPath : path.join(rootDir, configPath);
  const raw = fs.readFileSync(absolute, 'utf8');
  const config = yaml.load(raw);

  config.__rootDir = rootDir;
  config.__configPath = absolute;

  if (config.storage?.yaml?.dir && !path.isAbsolute(config.storage.yaml.dir)) {
    config.storage.yaml.dir = path.join(rootDir, config.storage.yaml.dir);
  }

  config.storage = config.storage || {};
  if (process.env.STORAGE_DRIVER) {
    config.storage.driver = String(process.env.STORAGE_DRIVER).trim().toLowerCase();
  }
  config.storage.mongo = config.storage.mongo || {};
  if (process.env.MONGODB_URI || process.env.MONGO_URI) {
    config.storage.mongo.uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  }
  if (process.env.MONGODB_DB || process.env.MONGO_DB) {
    config.storage.mongo.db = process.env.MONGODB_DB || process.env.MONGO_DB;
  }

  config.server = config.server || {};
  config.server.port = Number(process.env.PORT || config.server.port || 3000);
  // Heroku / containers: bind all interfaces. Local override: SERVER_HOST=127.0.0.1
  if (process.env.SERVER_HOST) {
    config.server.host = process.env.SERVER_HOST;
  } else if (process.env.DYNO) {
    config.server.host = '0.0.0.0';
  } else {
    config.server.host = config.server.host || '127.0.0.1';
  }

  config.logging = config.logging || {};
  const fileFlag = truthyEnv('LOG_TO_FILE');
  if (fileFlag != null) config.logging.file = fileFlag;
  else if (process.env.DYNO) config.logging.file = false;
  else if (config.logging.file == null) config.logging.file = true;

  if (process.env.LOG_LEVEL) config.logging.level = process.env.LOG_LEVEL;
  if (process.env.LOG_DIR) {
    config.logging.dir = path.isAbsolute(process.env.LOG_DIR)
      ? process.env.LOG_DIR
      : path.join(rootDir, process.env.LOG_DIR);
  } else if (config.logging.dir && !path.isAbsolute(config.logging.dir)) {
    config.logging.dir = path.join(rootDir, config.logging.dir);
  }

  config.tick = config.tick || {};
  if (process.env.TICK_INTERVAL_HOURS) {
    config.tick.intervalHours = Number(process.env.TICK_INTERVAL_HOURS);
  }
  const tickEnabled = truthyEnv('TICK_ENABLED');
  if (tickEnabled != null) config.tick.enabled = tickEnabled;

  config.admin = {
    user: process.env.ADMIN_USER || config.admin?.user || '',
    password: process.env.ADMIN_PASSWORD || config.admin?.password || '',
  };

  config.telegram = config.telegram || {};
  config.telegram.enabled = resolveTelegramEnabled(config.telegram);

  return config;
}

/**
 * TELEGRAM_ENABLED=1/0 overrides YAML.
 * If unset: enable when TELEGRAM_BOT_TOKEN (or tokenEnv) is present, else YAML flag.
 */
function resolveTelegramEnabled(telegram) {
  const envFlag = process.env.TELEGRAM_ENABLED;
  if (envFlag != null && String(envFlag).trim() !== '') {
    return /^(1|true|yes|on)$/i.test(String(envFlag).trim());
  }
  const tokenEnv = telegram.tokenEnv || 'TELEGRAM_BOT_TOKEN';
  if (process.env[tokenEnv]) return true;
  return Boolean(telegram.enabled);
}

export function projectRoot() {
  return rootDir;
}

/** Есть ли пара логин/пароль для Basic auth. */
export function hasAdminCredentials(config) {
  return Boolean(config?.admin?.user && config?.admin?.password);
}
