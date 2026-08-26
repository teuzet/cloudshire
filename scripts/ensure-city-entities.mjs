#!/usr/bin/env node
/**
 * Собрать каталог якорей города и записать в сейв (как после генезиса).
 *
 *   node scripts/ensure-city-entities.mjs
 *   node scripts/ensure-city-entities.mjs --name Аллерия
 *   node scripts/ensure-city-entities.mjs --domain domain_abc --force
 */

import { loadConfig } from '../src/config.js';
import { initLogger } from '../src/log.js';
import { createStorage } from '../src/storage/index.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { ensureCityEntities, ENTITY_KIND_LABELS } from '../src/game/cityEntities.js';

function parseArgs(argv) {
  const out = { name: 'Аллерия', domain: null, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--name') out.name = String(argv[++i] || '').trim() || out.name;
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

async function resolveDomain(storage, { domain, name }) {
  const domains = await storage.listDomains();
  if (!domains.length) throw new Error('в хранилище нет городов');
  if (domain) {
    const found = domains.find((d) => d.id === domain);
    if (!found) {
      throw new Error(`город ${domain} не найден. Есть: ${domains.map((d) => `${d.name} (${d.id})`).join(', ')}`);
    }
    return found;
  }
  const matches = domains.filter((d) => sameName(d.name, name));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`городов с именем «${name}» несколько: ${matches.map((d) => d.id).join(', ')}. Укажи --domain.`);
  }
  throw new Error(`город «${name}» ещё не создан. Сейчас есть: ${domains.map((d) => `${d.name} (${d.id})`).join(', ')}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Собрать каталог якорей и записать в сейв.

  node scripts/ensure-city-entities.mjs
  node scripts/ensure-city-entities.mjs --name Аллерия
  node scripts/ensure-city-entities.mjs --domain domain_abc --force`);
  process.exit(0);
}

const config = loadConfig();
const log = initLogger(config);
const storage = await createStorage(config);
try {
  const found = await resolveDomain(storage, args);
  const domain = (await storage.getDomain(found.id)) || found;
  if (!args.force && domain.cityEntities?.length) {
    console.log(`каталог уже есть: ${domain.name} (${domain.id}), ${domain.cityEntities.length} якорей`);
    for (const item of domain.cityEntities) {
      const kind = ENTITY_KIND_LABELS[item.kind] || item.kind;
      console.log(`- ${kind} «${item.name}»: ${item.about}`);
    }
    process.exit(0);
  }
  if (args.force) {
    domain.cityEntities = [];
    domain.cityEntitiesReady = false;
  }

  const runtime = new AgentRuntime(config);
  const list = await ensureCityEntities({ domain, config, runtime, log });
  if (!list.length) throw new Error('агент не вернул каталог');

  const live = await storage.getDomain(found.id);
  live.cityEntities = list;
  live.cityEntitiesReady = true;
  await storage.saveDomain(live);

  console.log(`записано в сейв: ${live.name} (${live.id}), ${list.length} якорей, driver ${storage.driver}`);
  for (const item of list) {
    const kind = ENTITY_KIND_LABELS[item.kind] || item.kind;
    console.log(`- ${kind} «${item.name}»: ${item.about}`);
  }
} finally {
  await storage.close();
}
