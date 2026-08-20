import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export function loadConfig(configPath = process.env.CLOUDSHIRE_CONFIG || 'config/default.yaml') {
  const absolute = path.isAbsolute(configPath) ? configPath : path.join(rootDir, configPath);
  const raw = fs.readFileSync(absolute, 'utf8');
  const config = yaml.load(raw);

  config.__rootDir = rootDir;
  config.__configPath = absolute;

  if (config.storage?.yaml?.dir && !path.isAbsolute(config.storage.yaml.dir)) {
    config.storage.yaml.dir = path.join(rootDir, config.storage.yaml.dir);
  }

  config.server = config.server || {};
  config.server.port = Number(process.env.PORT || config.server.port || 3000);

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
