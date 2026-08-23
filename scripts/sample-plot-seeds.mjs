#!/usr/bin/env node
/**
 * Прогон завязок на снимке локального города. Живое сохранение не пишет.
 *
 *   node scripts/sample-plot-seeds.mjs
 *   node scripts/sample-plot-seeds.mjs --count 20
 *   node scripts/sample-plot-seeds.mjs --domain domain_abc
 *   node scripts/sample-plot-seeds.mjs --out logs/plot-seeds/custom.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
import { initLogger } from '../src/log.js';
import { YamlStorage } from '../src/storage/yaml.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { seedPlot } from '../src/game/storyteller.js';
import { formatPlotTagsForPrompt, pickPlotTags, plotConfig } from '../src/game/plotlines.js';

function parseArgs(argv) {
  const out = { count: 20, domain: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--count') out.count = Math.max(1, Math.min(100, Number(argv[++i]) || 20));
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function cloneDomain(domain) {
  return structuredClone(domain);
}

function formatTags(tags) {
  return formatPlotTagsForPrompt(tags);
}

function tagFreq(rows, groupId) {
  const counts = new Map();
  for (const row of rows) {
    const tag = (row.tags || []).find((t) => t.groupId === groupId);
    const key = tag?.tagName || '(нет)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([name, n]) => `- ${name}: ${n}`)
    .join('\n');
}

async function resolveDomainId(storage, asked) {
  if (asked) return asked;
  const local = await storage.getUserBinding('local-user');
  if (local?.domainId) return local.domainId;
  const domains = await storage.listDomains();
  if (domains.length === 1) return domains[0].id;
  if (!domains.length) throw new Error('в data/domains нет городов');
  throw new Error(
    `городов несколько, укажи --domain. Есть: ${domains.map((d) => d.id).join(', ')}`,
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Прогон завязок на копии локального города. Сохранение не трогает.

  node scripts/sample-plot-seeds.mjs [--count 20] [--domain id] [--out файл]`);
  process.exit(0);
}

const config = loadConfig();
config.storage = config.storage || {};
config.storage.driver = 'yaml';
if (config.llm) config.llm.usage = { ...(config.llm.usage || {}), enabled: false };

const log = initLogger(config);
const storage = new YamlStorage(config);
await storage.init();

const domainId = await resolveDomainId(storage, args.domain);
const snapshot = await storage.getDomain(domainId);
if (!snapshot) throw new Error(`город ${domainId} не найден`);

const world = await storage.getWorld();
if (!world) throw new Error('world.yaml не найден');

const domainFile = storage.domainPath(domainId);
const worldFile = storage.worldPath();
const before = {
  domain: (await fs.stat(domainFile)).mtimeMs,
  world: (await fs.stat(worldFile)).mtimeMs,
};

const runtime = new AgentRuntime(config);
const cfg = plotConfig(config);
const liveStories = (snapshot.plotlines || []).filter((p) => p.kind !== 'errand');

const rows = [];
for (let i = 1; i <= args.count; i += 1) {
  const tags = pickPlotTags(cfg);
  process.stdout.write(`[${i}/${args.count}] ${formatTags(tags)}\n`);
  const domain = cloneDomain(snapshot);
  let result = null;
  let error = null;
  try {
    result = await seedPlot({
      config,
      runtime,
      domain,
      world,
      tags,
      log,
    });
  } catch (err) {
    error = err;
    log.warn('sample_seed_failed', { i, error: err.message });
  }

  const plot = result?.plot || null;
  rows.push({
    n: i,
    tags: plot?.tags?.length ? plot.tags : tags,
    ok: Boolean(plot),
    error: error ? String(error.message || error) : null,
    title: plot?.title || null,
    synopsis: plot?.synopsis || null,
    closeWhen: plot?.closeWhen || null,
    importance: plot?.importance ?? null,
    maxAgeMonths: plot?.maxAgeMonths ?? null,
    relatedStats: plot?.relatedStats || [],
    entry: result?.fact?.text || null,
    cast: (result?.cast || []).map((c) => c.name),
  });
}

const after = {
  domain: (await fs.stat(domainFile)).mtimeMs,
  world: (await fs.stat(worldFile)).mtimeMs,
};
if (after.domain !== before.domain || after.world !== before.world) {
  throw new Error('файл сохранения изменился — останавливаюсь. Сохранение должно остаться нетронутым.');
}

const ok = rows.filter((r) => r.ok);
const outPath = args.out
  ? path.isAbsolute(args.out)
    ? args.out
    : path.join(projectRoot(), args.out)
  : path.join(projectRoot(), 'logs', 'plot-seeds', `${snapshot.name || domainId}-${stampName()}.md`);

const body = [
  `# Прогон завязок: ${snapshot.name || domainId}`,
  '',
  `- город: ${snapshot.name} (${domainId})`,
  `- дата в мире: ${world.gameDate?.label || '—'} · тик ${world.tickIndex}`,
  `- живых историй на снимке: ${liveStories.length}`,
  `- попыток: ${rows.length} · взошло: ${ok.length} · пусто: ${rows.length - ok.length}`,
  `- сохранение не писалось`,
  '',
  '## Жребий',
  '',
  '### Характер',
  tagFreq(rows, 'character'),
  '',
  '### Сфера',
  tagFreq(rows, 'sphere'),
  '',
  '### Источник',
  tagFreq(rows, 'source'),
  '',
  '### Масштаб',
  tagFreq(rows, 'scale'),
  '',
  '## Истории',
  '',
];

for (const row of rows) {
  body.push(`### ${row.n}. ${row.ok ? `«${row.title}»` : 'не взошло'}`);
  body.push('');
  body.push(formatTags(row.tags));
  if (!row.ok) {
    body.push('');
    body.push(row.error ? `ошибка: ${row.error}` : 'движок отсёк завязку или агент ничего не вернул');
    body.push('');
    continue;
  }
  body.push('');
  body.push(
    [
      row.importance != null ? `важность ${row.importance}` : null,
      row.maxAgeMonths != null ? `срок ${row.maxAgeMonths}` : null,
      row.relatedStats.length ? `статы ${row.relatedStats.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (row.closeWhen) body.push(`закрыть когда: ${row.closeWhen}`);
  if (row.cast.length) body.push(`люди: ${row.cast.join(', ')}`);
  body.push('');
  if (row.entry) {
    body.push(row.entry);
    body.push('');
  }
  if (row.synopsis) {
    body.push(row.synopsis);
    body.push('');
  }
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${body.join('\n').trim()}\n`, 'utf8');
console.log(`отчёт: ${outPath}`);
console.log(`взошло ${ok.length} из ${rows.length}, сохранение не менялось`);
