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

  return config;
}

export function projectRoot() {
  return rootDir;
}
