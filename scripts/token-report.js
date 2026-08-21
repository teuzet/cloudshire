#!/usr/bin/env node
/**
 * Отчёт по токенам / $ по мирам.
 *
 *   npm run tokens
 *   npm run tokens -- --world world_abc123
 *   npm run tokens -- --archives
 *   npm run tokens -- --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, projectRoot } from '../src/config.js';
import { archivesRoot } from '../src/storage/worldArchive.js';

void fileURLToPath;

function parseArgs(argv) {
  const out = { dir: null, file: null, world: null, archives: false, limit: 20, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--world') out.world = argv[++i];
    else if (a === '--archives') out.archives = true;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 20);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows;
}

function discoverUsageFiles(config, { world = null, includeArchives = true } = {}) {
  const files = [];
  const logsDir = path.resolve(projectRoot(), config.logging?.dir || 'logs');
  const liveRoot = path.join(logsDir, 'worlds');

  if (world) {
    const live = path.join(liveRoot, world, 'usage.jsonl');
    if (fs.existsSync(live)) files.push({ path: live, worldId: world, source: 'live' });
    const arch = path.join(archivesRoot(config), world, 'logs', 'usage.jsonl');
    if (fs.existsSync(arch)) files.push({ path: arch, worldId: world, source: 'archive' });
    return files;
  }

  if (fs.existsSync(liveRoot)) {
    for (const name of fs.readdirSync(liveRoot)) {
      const p = path.join(liveRoot, name, 'usage.jsonl');
      if (fs.existsSync(p)) {
        files.push({
          path: p,
          worldId: name,
          source: 'live',
          mtime: fs.statSync(p).mtimeMs,
        });
      }
    }
  }

  // legacy session-scoped usage-*.jsonl
  if (fs.existsSync(logsDir)) {
    for (const name of fs.readdirSync(logsDir)) {
      if (!/^usage-.*\.jsonl$/i.test(name)) continue;
      files.push({
        path: path.join(logsDir, name),
        worldId: null,
        source: 'legacy',
        mtime: fs.statSync(path.join(logsDir, name)).mtimeMs,
      });
    }
  }

  if (includeArchives) {
    const archRoot = archivesRoot(config);
    if (fs.existsSync(archRoot)) {
      for (const name of fs.readdirSync(archRoot)) {
        const p = path.join(archRoot, name, 'logs', 'usage.jsonl');
        if (fs.existsSync(p)) {
          files.push({
            path: p,
            worldId: name,
            source: 'archive',
            mtime: fs.statSync(p).mtimeMs,
          });
        }
      }
    }
  }

  return files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

function emptyBucket() {
  return {
    runs: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    costUsd: 0,
    turns: 0,
    ms: 0,
  };
}

function addToBucket(b, row) {
  const u = row.usage || {};
  b.runs += 1;
  b.prompt_tokens += Number(u.prompt_tokens) || 0;
  b.completion_tokens += Number(u.completion_tokens) || 0;
  b.total_tokens += Number(u.total_tokens) || 0;
  b.costUsd += Number(row.costUsd) || 0;
  b.turns += Number(row.turns) || 0;
  b.ms += Number(row.ms) || 0;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    if (row.kind && row.kind !== 'agent_run') continue;
    if (!row.usage && row.costUsd == null) continue;
    const key = keyFn(row) || '(none)';
    if (!map.has(key)) map.set(key, emptyBucket());
    addToBucket(map.get(key), row);
  }
  return [...map.entries()]
    .map(([key, b]) => ({ key, ...b }))
    .sort((a, b) => b.costUsd - a.costUsd || b.total_tokens - a.total_tokens);
}

function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(4)}`;
}

function fmtInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function printTable(title, rows, { limit = 20 } = {}) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) {
    console.log('(пусто)');
    return;
  }
  const head = ['key', 'runs', 'prompt', 'compl', 'total', 'cost', 'turns'];
  const slice = rows.slice(0, limit);
  const widths = head.map((h) => h.length);
  const cells = slice.map((r) => {
    const row = [
      String(r.key).slice(0, 44),
      fmtInt(r.runs),
      fmtInt(r.prompt_tokens),
      fmtInt(r.completion_tokens),
      fmtInt(r.total_tokens),
      fmtUsd(r.costUsd),
      fmtInt(r.turns),
    ];
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i], c.length);
    });
    return row;
  });
  console.log(head.map((h, i) => h.padEnd(widths[i])).join('  '));
  for (const row of cells) {
    console.log(row.map((c, i) => c.padEnd(widths[i])).join('  '));
  }
  if (rows.length > limit) console.log(`… ещё ${rows.length - limit}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      `Usage: node scripts/token-report.js [--world id] [--archives] [--file path] [--json]`,
    );
    process.exit(0);
  }

  const config = loadConfig();
  let files;
  if (args.file) {
    const fp = path.isAbsolute(args.file) ? args.file : path.join(projectRoot(), args.file);
    files = [{ path: fp, worldId: null, source: 'file' }];
  } else {
    files = discoverUsageFiles(config, {
      world: args.world,
      includeArchives: args.archives || !args.world,
    });
    if (!args.archives && !args.world) {
      // по умолчанию: live + archives, но можно сузить
      files = discoverUsageFiles(config, { includeArchives: true });
    }
  }

  const rows = [];
  for (const f of files) {
    for (const row of loadJsonl(f.path)) {
      if (!row.worldId && f.worldId) row.worldId = f.worldId;
      row._source = f.source;
      rows.push(row);
    }
  }

  const runs = rows.filter((r) => r.usage || r.costUsd != null);
  const totals = emptyBucket();
  for (const r of runs) addToBucket(totals, r);

  const report = {
    files: files.map((f) => `${f.source}:${f.worldId || path.basename(f.path)}`),
    runs: totals.runs,
    usage: {
      prompt_tokens: totals.prompt_tokens,
      completion_tokens: totals.completion_tokens,
      total_tokens: totals.total_tokens,
    },
    costUsd: Math.round(totals.costUsd * 1e6) / 1e6,
    byWorld: groupBy(runs, (r) => r.worldId || '(no world)'),
    byScene: groupBy(runs, (r) => r.scene || '(no scene)'),
    byAgent: groupBy(runs, (r) => r.agentId || '?'),
    byModel: groupBy(runs, (r) => r.model || '?'),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Files: ${report.files.slice(0, args.limit).join(', ') || '(none)'}`);
  console.log(
    `Runs: ${report.runs}  tokens: ${fmtInt(report.usage.total_tokens)} ` +
      `(prompt ${fmtInt(report.usage.prompt_tokens)} / completion ${fmtInt(report.usage.completion_tokens)})  ` +
      `cost ≈ ${fmtUsd(report.costUsd)}`,
  );
  printTable('By world', report.byWorld, { limit: args.limit });
  printTable('By scene', report.byScene, { limit: args.limit });
  printTable('By agent', report.byAgent, { limit: args.limit });
  printTable('By model', report.byModel, { limit: args.limit });

  if (!report.runs) {
    console.log(
      '\nНет данных. Usage: logs/worlds/<worldId>/usage.jsonl; после wipe — data/archives/<worldId>/logs/.',
    );
  }
}

main();
