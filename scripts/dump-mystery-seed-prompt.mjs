#!/usr/bin/env node
/**
 * Снимает пакет, который уходит агенту mysteryStart при посеве тайны.
 * Модель не вызывает, сохранение не пишет.
 *
 *   node scripts/dump-mystery-seed-prompt.mjs
 *   node scripts/dump-mystery-seed-prompt.mjs --name Аллерия --out logs/plot-seeds/mystery-prompt.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
import { initLogger } from '../src/log.js';
import { createStorage } from '../src/storage/index.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { seedPlot } from '../src/game/storyteller.js';
import { pickMysteryPlotTags, plotConfig } from '../src/game/plotlines.js';

function parseArgs(argv) {
  const out = { name: 'Аллерия', domain: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--name') out.name = String(argv[++i] || '').trim() || out.name;
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function resolveDomain(storage, { domain, name }) {
  const domains = await storage.listDomains();
  if (!domains.length) throw new Error('в хранилище нет городов');
  if (domain) {
    const found = domains.find((d) => d.id === domain);
    if (!found) {
      throw new Error(
        `город ${domain} не найден. Есть: ${domains.map((d) => `${d.name} (${d.id})`).join(', ')}`,
      );
    }
    return found;
  }
  const matches = domains.filter((d) => sameName(d.name, name));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `городов с именем «${name}» несколько: ${matches.map((d) => d.id).join(', ')}. Укажи --domain.`,
    );
  }
  if (domains.length === 1) return domains[0];
  throw new Error(
    `город «${name}» ещё не создан. Сейчас есть: ${domains.map((d) => `${d.name} (${d.id})`).join(', ')}`,
  );
}

function renderDump({ snapshot, world, captured, tags }) {
  const user = (captured.messages || []).find((m) => m.role === 'user');
  const toolChoice =
    typeof captured.toolChoice === 'object'
      ? captured.toolChoice?.function?.name
      : captured.toolChoice;
  const lines = [
    `# Промпт посева тайны`,
    '',
    `- город: ${snapshot.name} (${snapshot.id})`,
    `- дата в мире: ${world.gameDate?.label || '—'} · тик ${world.tickIndex}`,
    `- агент: ${captured.agentId}`,
    `- модель: ${captured.model}`,
    `- reasoning: ${captured.reasoningEffort || captured.agent?.reasoningEffort || '—'}`,
    `- сцена: ${captured.scene || 'plot_seed'}`,
    `- tool: ${toolChoice || 'submit_plot_seed'}`,
    `- живых нитей на снимке: ${(snapshot.plotlines || []).length}`,
    '',
    'Жребий направления в этом дампе случаен, как у настоящего посева:',
    '',
    tags?.length
      ? tags.map((t) => `- ${t.groupName}: «${t.tagName}»`).join('\n')
      : '- (нет)',
    '',
    '---',
    '',
    '## System',
    '',
    captured.systemContent || '(пусто)',
    '',
    '---',
    '',
    '## User',
    '',
    user?.content || '(пусто)',
    '',
    '---',
    '',
    '## Tool schema',
    '',
    '```json',
    JSON.stringify(captured.tools, null, 2),
    '```',
    '',
  ];
  return `${lines.join('\n').trim()}\n`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Снимает промпт mysteryStart. Модель не вызывает.

  node scripts/dump-mystery-seed-prompt.mjs
  node scripts/dump-mystery-seed-prompt.mjs --name Аллерия --out logs/plot-seeds/mystery-prompt.md`);
  process.exit(0);
}

const config = loadConfig();
if (config.llm) config.llm.usage = { ...(config.llm.usage || {}), enabled: false };

const log = initLogger(config);
const storage = await createStorage(config);
try {
  const found = await resolveDomain(storage, args);
  const snapshot = (await storage.getDomain(found.id)) || found;
  const world = await storage.getWorld();
  if (!world) throw new Error('мир не найден');

  const runtime = new AgentRuntime(config);
  let captured = null;
  runtime.run = async (opts) => {
    if (opts.agentId === 'mysteryStart' && !captured) {
      captured = {
        ...runtime.assembleChat(opts),
        toolChoice: opts.toolChoice,
        scene: opts.scene,
      };
    }
    return { text: '', toolTrace: [] };
  };

  const cfg = plotConfig(config);
  const tags = pickMysteryPlotTags(cfg);
  await seedPlot({
    config,
    runtime,
    domain: structuredClone(snapshot),
    world: structuredClone(world),
    tags,
    storyType: 'mystery',
    log,
  });

  if (!captured) throw new Error('посев не вызвал агента — промпт снять не удалось');

  const outPath = args.out
    ? path.isAbsolute(args.out)
      ? args.out
      : path.join(projectRoot(), args.out)
    : path.join(
        projectRoot(),
        'logs',
        'plot-seeds',
        `mystery-prompt-${snapshot.name || snapshot.id}-${stampName()}.md`,
      );

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, renderDump({ snapshot, world, captured, tags }), 'utf8');
  console.log(`промпт: ${outPath}`);
  console.log(`агент ${captured.agentId} · ${captured.model} · system ${captured.systemContent.length} символов`);
} finally {
  await storage.close();
}
