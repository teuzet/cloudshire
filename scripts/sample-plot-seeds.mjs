#!/usr/bin/env node
/**
 * Прогон завязок на снимке города. Живое сохранение не пишет.
 *
 * По умолчанию: Аллерия, 20 тайн + 20 саспенсов.
 *
 *   node scripts/sample-plot-seeds.mjs
 *   node scripts/sample-plot-seeds.mjs --name Аллерия
 *   node scripts/sample-plot-seeds.mjs --mysteries 20 --suspense 20 --out logs/plot-seeds/custom.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
import { initLogger } from '../src/log.js';
import { createStorage } from '../src/storage/index.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { seedPlot } from '../src/game/storyteller.js';
import { formatPlotTagsForPrompt, pickSeedTags, plotConfig } from '../src/game/plotlines.js';
import { formatTruthGraphForPrompt } from '../src/game/mysteryGraph.js';
import { ensureCityEntities, formatMysteryAnchorsForPrompt } from '../src/game/cityEntities.js';

function parseArgs(argv) {
  const out = {
    mysteries: 20,
    suspense: 20,
    name: 'Аллерия',
    domain: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mysteries') out.mysteries = Math.max(0, Math.min(100, Number(argv[++i]) || 0));
    else if (a === '--suspense') out.suspense = Math.max(0, Math.min(100, Number(argv[++i]) || 0));
    else if (a === '--count') {
      const n = Math.max(0, Math.min(100, Number(argv[++i]) || 0));
      out.mysteries = n;
      out.suspense = n;
    }
    else if (a === '--name') out.name = String(argv[++i] || '').trim() || out.name;
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function formatTags(tags) {
  return formatPlotTagsForPrompt(tags);
}

function tagFreq(rows, groupId, { all = false } = {}) {
  const counts = new Map();
  for (const row of rows) {
    const tags = (row.tags || []).filter((t) => t.groupId === groupId);
    if (!tags.length) {
      counts.set('(нет)', (counts.get('(нет)') || 0) + 1);
      continue;
    }
    const picked = all ? tags : tags.slice(0, 1);
    for (const tag of picked) {
      const key = tag?.tagName || '(нет)';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([name, n]) => `- ${name}: ${n}`)
    .join('\n');
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
  throw new Error(
    `город «${name}» ещё не создан. Сейчас есть: ${
      domains.map((d) => `${d.name} (${d.id})`).join(', ') || 'пусто'
    }`,
  );
}

function renderCard(row) {
  const lines = [];
  lines.push(`### ${row.n}. ${row.ok ? `«${row.title}»` : 'не взошло'}`);
  lines.push('');
  lines.push(formatTags(row.tags) || '(жребий пуст)');
  if (!row.ok) {
    lines.push('');
    lines.push(row.error ? `ошибка: ${row.error}` : 'движок отсёк завязку или агент ничего не вернул');
    lines.push('');
    return lines;
  }
  lines.push('');
  lines.push(
    [
      `тип ${row.storyType}`,
      row.mysteryKind ? `род ${row.mysteryKind}` : null,
      row.graphShape ? `граф ${row.graphShape}` : null,
      row.sideOpen ? 'виден ещё E' : null,
      row.asksSequel ? 'просит сиквела' : null,
      row.urgency != null ? `urgency ${row.urgency}` : null,
      row.gravity != null ? `gravity ${row.gravity}` : null,
      row.importance != null ? `важность ${row.importance}` : null,
      row.maxAgeMonths != null ? `срок ${row.maxAgeMonths}` : null,
      row.relatedStats.length ? `статы ${row.relatedStats.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (row.closeWhen) lines.push(`закрыть когда: ${row.closeWhen}`);
  if (row.anchors?.length) {
    lines.push('');
    lines.push(formatMysteryAnchorsForPrompt(row.anchors));
  }
  if (row.graph) {
    lines.push('');
    lines.push(formatTruthGraphForPrompt(row.graph));
  }
  if (row.cast.length) lines.push(`люди: ${row.cast.join(', ')}`);
  lines.push('');
  if (row.entry) {
    lines.push(row.entry);
    lines.push('');
  }
  if (row.synopsis) {
    lines.push(row.synopsis);
    lines.push('');
  }
  return lines;
}

async function runBatch({
  storyType,
  count,
  snapshot,
  world,
  config,
  runtime,
  log,
  cfg,
}) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    const tags = pickSeedTags(cfg, { storyType });
    process.stdout.write(`[${storyType} ${i}/${count}] ${formatTags(tags)}\n`);
    const domain = structuredClone(snapshot);
    const worldCopy = structuredClone(world);
    let result = null;
    let error = null;
    try {
      result = await seedPlot({
        config,
        runtime,
        domain,
        world: worldCopy,
        tags,
        storyType,
        log,
      });
    } catch (err) {
      error = err;
      log.warn('sample_seed_failed', { storyType, i, error: err.message });
    }
    const plot = result?.plot || null;
    rows.push({
      n: i,
      storyType,
      tags: plot?.tags?.length ? plot.tags : tags,
      ok: Boolean(plot),
      error: error ? String(error.message || error) : null,
      title: plot?.title || null,
      synopsis: plot?.synopsis || null,
      closeWhen: plot?.closeWhen || null,
      truth: plot?.truth || null,
      graph: plot?.truthGraph || null,
      importance: plot?.importance ?? null,
      urgency: plot?.urgency ?? null,
      gravity: plot?.gravity ?? null,
      maxAgeMonths: plot?.maxAgeMonths ?? null,
      relatedStats: plot?.relatedStats || [],
      entry: result?.fact?.text || null,
      cast: (result?.cast || []).map((c) => c.name),
      anchors: result?.anchors || [],
      mysteryKind: result?.mysteryKind?.tagName || result?.mysteryKind?.tagId || null,
      graphShape: result?.graphShape || null,
      sideOpen: Boolean(result?.sideOpen),
      asksSequel: Boolean(plot?.asksSequel),
    });
  }
  return rows;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Прогон завязок на копии города. Сохранение не трогает.

  node scripts/sample-plot-seeds.mjs
  node scripts/sample-plot-seeds.mjs --name Аллерия --mysteries 20 --suspense 20
  node scripts/sample-plot-seeds.mjs --domain domain_abc --out logs/plot-seeds/custom.md`);
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
  const cfg = plotConfig(config);
  const liveStories = (snapshot.plotlines || []).filter((p) => p.kind === 'story');

  if (args.mysteries) {
    await ensureCityEntities({ domain: snapshot, config, runtime, log });
  }

  const mysteryRows = args.mysteries
    ? await runBatch({
        storyType: 'mystery',
        count: args.mysteries,
        snapshot,
        world,
        config,
        runtime,
        log,
        cfg,
      })
    : [];
  const suspenseRows = args.suspense
    ? await runBatch({
        storyType: 'suspense',
        count: args.suspense,
        snapshot,
        world,
        config,
        runtime,
        log,
        cfg,
      })
    : [];

  const rows = [...mysteryRows, ...suspenseRows];
  const ok = rows.filter((r) => r.ok);
  const outPath = args.out
    ? path.isAbsolute(args.out)
      ? args.out
      : path.join(projectRoot(), args.out)
    : path.join(
        projectRoot(),
        'logs',
        'plot-seeds',
        `${snapshot.name || snapshot.id}-${stampName()}.md`,
      );

  const body = [
    `# Прогон завязок: ${snapshot.name || snapshot.id}`,
    '',
    `- город: ${snapshot.name} (${snapshot.id})`,
    `- хранилище: ${storage.driver}`,
    `- дата в мире: ${world.gameDate?.label || '—'} · тик ${world.tickIndex}`,
    `- живых историй на снимке: ${liveStories.length}`,
    `- якорей в каталоге города: ${(snapshot.cityEntities || []).length} (модели не отдаётся; в тайну — 1, редко 2)`,
    `- тайн: ${mysteryRows.length} · взошло ${mysteryRows.filter((r) => r.ok).length}`,
    `- саспенсов: ${suspenseRows.length} · взошло ${suspenseRows.filter((r) => r.ok).length}`,
    `- каждая попытка шла с одного и того же снимка; сохранение не писалось`,
    '',
    '## Жребий тайн',
    '',
    '### Ассоциативное поле',
    tagFreq(mysteryRows, 'association') || '- (нет)',
    '',
    '### Тип тайны',
    tagFreq(mysteryRows, 'type') || '- (нет)',
    '',
    '## Жребий саспенса',
    '',
    '### Характер',
    tagFreq(suspenseRows, 'character') || '- (нет)',
    '',
    '### Сфера',
    tagFreq(suspenseRows, 'sphere') || '- (нет)',
    '',
    '### Источник',
    tagFreq(suspenseRows, 'source') || '- (нет)',
    '',
    '### Масштаб',
    tagFreq(suspenseRows, 'scale') || '- (нет)',
    '',
    '## Тайны',
    '',
  ];

  if (!mysteryRows.length) body.push('(не сеяли)');
  for (const row of mysteryRows) body.push(...renderCard(row));

  body.push('## Саспенс', '');
  if (!suspenseRows.length) body.push('(не сеяли)');
  for (const row of suspenseRows) body.push(...renderCard(row));

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${body.join('\n').trim()}\n`, 'utf8');
  console.log(`отчёт: ${outPath}`);
  console.log(`взошло ${ok.length} из ${rows.length}, сохранение не менялось`);
} finally {
  await storage.close();
}
