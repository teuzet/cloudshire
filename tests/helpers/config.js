import { loadConfig } from '../../src/config.js';

let cached = null;

export function testConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}
