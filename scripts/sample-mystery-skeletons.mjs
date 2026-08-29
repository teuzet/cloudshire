#!/usr/bin/env node
/**
 * Прогон абстрактных skeleton-тайн (Phase 1). Город не нужен, сохранение не пишет.
 *
 *   node scripts/sample-mystery-skeletons.mjs
 *   node scripts/sample-mystery-skeletons.mjs --count 20 --out logs/plot-seeds/skeletons.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
import { initLogger } from '../src/log.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { plotConfig, formatPlotTagsForPrompt, gravityBand } from '../src/game/plotlines.js';
import {
  seedMysterySkeleton,
  formatMysterySkeletonCard,
} from '../src/game/mysteryArchitect.js';

function parseArgs(argv) {
  const out = { count: 12, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--count' || a === '-n') out.count = Math.max(1, Math.min(80, Number(argv[++i]) || 12));
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function tagFreq(rows, groupId) {
  const counts = new Map();
  for (const row of rows) {
    const tags = (row.seed?.tags || []).filter((t) => t.groupId === groupId);
    if (!tags.length) {
      counts.set('(нет)', (counts.get('(нет)') || 0) + 1);
      continue;
    }
    for (const tag of tags) {
      const key = tag?.tagName || '(нет)';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([name, n]) => `- ${name}: ${n}`)
    .join('\n');
}

function skipFreq(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const a of row.attempts || []) {
      if (!a.skip) continue;
      const key = String(a.skip).split(':')[0];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `- ${name}: ${n}`)
    .join('\n');
}

function gravityFreq(rows) {
  const bands = new Map();
  for (const row of rows) {
    const key = gravityBand(row.seed?.gravity);
    bands.set(key, (bands.get(key) || 0) + 1);
  }
  return [...bands.entries()]
    .map(([name, n]) => `- ${name}: ${n}`)
    .join('\n');
}

function formatIssue(issue) {
  if (!issue) return '';
  const loc = issue.location ? ` @ ${issue.location}` : '';
  return `${issue.code || 'OTHER'}${loc}: ${issue.reason || ''}`.trim();
}

function formatAttemptHeadline(a) {
  const n = Number(a.genTry) + 1;
  if (a.skip && !a.judge) {
    return `попытка ${n}: ${a.skip}${a.title ? ` «${a.title}»` : ''}`;
  }
  const v = a.judge?.verdict || '?';
  const mark = a.accepted ? 'принята' : 'отклонена';
  const title = a.title ? ` «${a.title}»` : '';
  const summary = a.judge?.summary ? ` — ${a.judge.summary}` : '';
  return `попытка ${n}${title}: ${mark} (${v})${summary}`;
}

function renderAttempt(a) {
  const n = Number(a.genTry) + 1;
  const status = a.skip || (a.accepted ? 'принята' : 'отклонена');
  const lines = [`#### Попытка ${n} — ${status}`, ''];
  if (a.judge) {
    lines.push(`**судья:** ${a.judge.verdict}${a.judge.summary ? ` — ${a.judge.summary}` : ''}`);
    for (const issue of a.judge.issues || []) {
      lines.push(`- \`${issue.code}\`${issue.location ? ` @ ${issue.location}` : ''}: ${issue.reason}`);
    }
    lines.push('');
  }
  if (a.skeleton) {
    lines.push(formatMysterySkeletonCard(a.skeleton));
    lines.push('');
  }
  return lines;
}

function renderCard(row) {
  const lines = [`### ${row.n}. ${row.ok ? `«${row.title}»` : 'не взошло'}`, ''];
  lines.push(formatPlotTagsForPrompt(row.seed?.tags) || '(жребий пуст)');
  lines.push(`gravity ${row.seed?.gravity} (${gravityBand(row.seed?.gravity)})`);
  const attempts = row.attempts || [];
  if (row.error) {
    lines.push('', `ошибка: ${row.error}`, '');
    return lines;
  }
  if (!row.ok && !attempts.length) {
    lines.push('', 'генератор ничего не вернул', '');
    return lines;
  }
  lines.push('');
  if (row.ok && row.skeleton) {
    if (row.judge) {
      lines.push(`**судья:** ${row.judge.verdict}${row.judge.summary ? ` — ${row.judge.summary}` : ''}`);
      lines.push('');
    }
    lines.push(formatMysterySkeletonCard(row.skeleton));
    lines.push('');
  }
  const rejected = attempts.filter((a) => !a.accepted);
  if (rejected.length && !(row.ok && rejected.length === 0)) {
    const shown = row.ok ? rejected : attempts;
    if (shown.length) {
      lines.push(row.ok ? 'Отклонённые попытки до этой:' : 'Попытки:', '');
      for (const a of shown) lines.push(...renderAttempt(a));
    }
  }
  return lines;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Прогон абстрактных skeleton-тайн. Город не нужен.

  node scripts/sample-mystery-skeletons.mjs
  node scripts/sample-mystery-skeletons.mjs --count 20 --out logs/plot-seeds/skeletons.md`);
  process.exit(0);
}

const config = loadConfig();
if (config.llm) config.llm.usage = { ...(config.llm.usage || {}), enabled: false };

const log = initLogger(config);
const runtime = new AgentRuntime(config);
const cfg = plotConfig(config);
const rows = [];

for (let i = 1; i <= args.count; i += 1) {
  process.stdout.write(`[skeleton ${i}/${args.count}]\n`);
  let result = null;
  let error = null;
  try {
    result = await seedMysterySkeleton({ config, runtime, log });
  } catch (err) {
    error = err;
    log.warn('sample_skeleton_failed', { i, error: err.message });
  }
  const seed = result?.seed || null;
  process.stdout.write(`  ${formatPlotTagsForPrompt(seed?.tags) || '(нет тегов)'} · g${seed?.gravity ?? '?'}\n`);
  for (const attempt of result?.attempts || []) {
    process.stdout.write(`  ${formatAttemptHeadline(attempt)}\n`);
    for (const issue of (attempt.judge?.issues || []).slice(0, 8)) {
      process.stdout.write(`    · ${formatIssue(issue)}\n`);
    }
  }
  process.stdout.write(`  → ${result?.ok ? 'принят' : 'отклонён'}\n`);
  rows.push({
    n: i,
    ok: Boolean(result?.ok),
    error: error ? String(error.message || error) : null,
    seed,
    title: result?.skeleton?.workingTitle || null,
    skeleton: result?.skeleton || null,
    judge: result?.judge || null,
    attempts: result?.attempts || [],
  });
}

const outPath = args.out
  ? path.isAbsolute(args.out)
    ? args.out
    : path.join(projectRoot(), args.out)
  : path.join(projectRoot(), 'logs', 'plot-seeds', `skeletons-${stampName()}.md`);

const ok = rows.filter((r) => r.ok);
const attempts = rows.flatMap((r) => r.attempts || []);
const judged = attempts.filter((a) => a.judge);
const codes = new Map();
const verdicts = { PASS: 0, FAIL: 0, UNCERTAIN: 0 };
for (const a of judged) {
  if (verdicts[a.judge.verdict] != null) verdicts[a.judge.verdict] += 1;
  for (const issue of a.judge.issues || []) {
    const key = issue.code || 'OTHER';
    codes.set(key, (codes.get(key) || 0) + 1);
  }
}
const codeLines = [...codes.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([code, n]) => `- ${code}: ${n}`);

const groups = [
  'type',
  'association',
  'scale',
  'source',
  'entry',
  'tonePrimary',
  'toneSecondary',
  'situation',
  'dynamic',
  'canonRelation',
];

const body = [
  '# Прогон абстрактных skeleton-тайн (Phase 1)',
  '',
  `- попыток карточек: ${rows.length} · принято ${ok.length}`,
  `- генераций: ${attempts.length} · до судьи: ${judged.length}`,
  `- судья: PASS ${verdicts.PASS} · FAIL ${verdicts.FAIL} · UNCERTAIN ${verdicts.UNCERTAIN}`,
  `- агент: ${config.agents?.mysteryArchitect?.model || 'mysteryArchitect'} / судья ${config.agents?.mysteryArchitectJudge?.model || 'mysteryArchitectJudge'}`,
  `- лимит попыток на карточку: ${cfg.mysteryArchitect?.judgeAttempts || 3}`,
  `- города нет; сохранение не писалось`,
  '',
  'Частые коды отказов:',
  codeLines.length ? codeLines.join('\n') : '- (нет)',
  '',
  'Пропуски до судьи:',
  skipFreq(rows) || '- (нет)',
  '',
  '## Жребий',
  '',
  '### Gravity',
  gravityFreq(rows) || '- (нет)',
  '',
];

for (const id of groups) {
  const label = {
    type: 'Тип тайны',
    association: 'Ассоциация',
    scale: 'Масштаб',
    source: 'Источник',
    entry: 'Вход',
    tonePrimary: 'Тон основной',
    toneSecondary: 'Тон второй',
    situation: 'Ситуация',
    dynamic: 'Динамика',
    canonRelation: 'Отношение к канону',
  }[id];
  body.push(`### ${label}`, tagFreq(rows, id) || '- (нет)', '');
}

body.push('## Карточки', '');
for (const row of rows) body.push(...renderCard(row));

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${body.join('\n').trim()}\n`, 'utf8');
console.log(`отчёт: ${outPath}`);
console.log(`принято ${ok.length} из ${rows.length}`);
