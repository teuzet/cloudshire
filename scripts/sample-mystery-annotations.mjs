#!/usr/bin/env node
/**
 * Прогон mystery-брифов. Город не нужен, сохранение не пишет.
 *
 *   npm run seed-annotations -- --count 15 --out logs/plot-seeds/annotations5-2-a.md
 *   npm run seed-annotations -- --count 15 --no-truth-nature --out logs/plot-seeds/annotations5-2-b.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.js';
import { initLogger } from '../src/log.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { plotConfig, formatPlotTagsForPrompt, annotationGravityBand } from '../src/game/plotlines.js';
import {
  seedMysteryAnnotation,
  formatMysteryAnnotationCard,
} from '../src/game/mysteryAnnotation.js';

function parseArgs(argv) {
  const out = { count: 12, out: null, help: false, omitTruthNature: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--count' || a === '-n') out.count = Math.max(1, Math.min(80, Number(argv[++i]) || 12));
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--no-truth-nature') out.omitTruthNature = true;
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
    if (!row.attempts?.length && row.skip) {
      const key = String(row.skip).split(':')[0];
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
    const key = annotationGravityBand(row.seed?.gravity);
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

function attemptKind(a) {
  return a.revise || Number(a.genTry) > 0 ? 'доработка' : 'черновик';
}

function formatAttemptHeadline(a) {
  const kind = attemptKind(a);
  if (a.skip && !a.judge) {
    return `${kind}: ${a.skip}${a.title ? ` «${a.title}»` : ''}`;
  }
  const v = a.judge?.verdict || '?';
  const mark = a.accepted ? 'принята' : 'отклонена';
  const title = a.title ? ` «${a.title}»` : '';
  const summary = a.judge?.summary ? ` — ${a.judge.summary}` : '';
  return `${kind}${title}: ${mark} (${v})${summary}`;
}

function renderAttempt(a) {
  const status = a.skip || (a.accepted ? 'принята' : 'отклонена');
  const lines = [`#### ${attemptKind(a)} — ${status}`, ''];
  if (a.judge) {
    lines.push(`**судья:** ${a.judge.verdict}${a.judge.summary ? ` — ${a.judge.summary}` : ''}`);
    for (const issue of a.judge.issues || []) {
      lines.push(`- \`${issue.code}\`${issue.location ? ` @ ${issue.location}` : ''}: ${issue.reason}`);
    }
    lines.push('');
  }
  if (a.annotation) {
    lines.push(formatMysteryAnnotationCard(a.annotation));
    lines.push('');
  }
  return lines;
}

function renderCard(row) {
  const lines = [`### ${row.n}. ${row.ok ? `«${row.title}»` : 'не взошло'}`, ''];
  lines.push(formatPlotTagsForPrompt(row.seed?.tags) || '(жребий пуст)');
  lines.push(`gravity ${row.seed?.gravity} (${annotationGravityBand(row.seed?.gravity)})`);
  const attempts = row.attempts || [];
  if (row.error) {
    lines.push('', `ошибка: ${row.error}`, '');
    return lines;
  }
  if (!row.ok && !attempts.length) {
    lines.push('', `пропуск: ${row.skip || 'NO_OUTPUT'}`, '');
    return lines;
  }
  lines.push('');
  if (row.ok && row.annotation) {
    if (row.judge) {
      lines.push(`**судья:** ${row.judge.verdict}${row.judge.summary ? ` — ${row.judge.summary}` : ''}`);
      lines.push('');
    }
    lines.push(formatMysteryAnnotationCard(row.annotation));
    lines.push('');
  }
  const rejected = attempts.filter((a) => !a.accepted);
  if (rejected.length) {
    const shown = row.ok ? rejected : attempts;
    if (shown.length) {
      lines.push(row.ok ? 'Отклонённый черновик:' : 'Черновик и доработка:', '');
      for (const a of shown) lines.push(...renderAttempt(a));
    }
  }
  return lines;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Прогон mystery-брифов. Город не нужен.

  node scripts/sample-mystery-annotations.mjs
  node scripts/sample-mystery-annotations.mjs --count 12 --out logs/plot-seeds/annotations.md

  A/B V5.2 (truthNature), 15 карточек на ветку:

  npm run seed-annotations -- --count 15 --out logs/plot-seeds/annotations5-2-a.md
  npm run seed-annotations -- --count 15 --no-truth-nature --out logs/plot-seeds/annotations5-2-b.md`);
  process.exit(0);
}

const config = loadConfig();
if (config.llm) config.llm.usage = { ...(config.llm.usage || {}), enabled: false };

const log = initLogger(config);
const runtime = new AgentRuntime(config);
const cfg = plotConfig(config);
const rows = [];

for (let i = 1; i <= args.count; i += 1) {
  process.stdout.write(`[annotation ${i}/${args.count}]\n`);
  let result = null;
  let error = null;
  try {
    result = await seedMysteryAnnotation({
      config,
      runtime,
      log,
      omitTruthNature: args.omitTruthNature,
    });
  } catch (err) {
    error = err;
    log.warn('sample_annotation_failed', { i, error: err.message });
  }
  const seed = result?.seed || null;
  process.stdout.write(`  ${formatPlotTagsForPrompt(seed?.tags) || '(нет тегов)'} · g${seed?.gravity ?? '?'}\n`);
  for (const attempt of result?.attempts || []) {
    process.stdout.write(`  ${formatAttemptHeadline(attempt)}\n`);
    for (const issue of (attempt.judge?.issues || []).slice(0, 8)) {
      process.stdout.write(`    · ${formatIssue(issue)}\n`);
    }
  }
  process.stdout.write(`  → ${result?.ok ? 'принята' : 'отклонена'}\n`);
  rows.push({
    n: i,
    ok: Boolean(result?.ok),
    error: error ? String(error.message || error) : null,
    seed,
    title: result?.annotation?.workingTitle || null,
    annotation: result?.annotation || null,
    judge: result?.judge || null,
    skip: result?.skip || null,
    attempts: result?.attempts || [],
  });
}

const outPath = args.out
  ? path.isAbsolute(args.out)
    ? args.out
    : path.join(projectRoot(), args.out)
  : path.join(projectRoot(), 'logs', 'plot-seeds', `annotations-${stampName()}.md`);

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
  'truthArena',
  'truthNature',
  'worldRelation',
  'manifestation',
  'tonePrimary',
];

const labels = {
  truthArena: 'Арена истины',
  truthNature: 'Природа истины',
  worldRelation: 'Отношение к миру',
  manifestation: 'Проявление',
  tonePrimary: 'Тон',
};

const body = [
  '# Прогон mystery-аннотаций',
  '',
  `- карточек: ${rows.length} · принято ${ok.length}`,
  `- генераций: ${attempts.length} · до судьи: ${judged.length}`,
  `- судья: PASS ${verdicts.PASS} · FAIL ${verdicts.FAIL} · UNCERTAIN ${verdicts.UNCERTAIN}`,
  `- агент: ${config.agents?.mysteryAnnotation?.model || 'mysteryAnnotation'} / судья ${config.agents?.mysteryAnnotationJudge?.model || 'mysteryAnnotationJudge'}`,
  `- лимит: один черновик + одна доработка по замечаниям судьи (новый жребий не бросается)`,
  `- города нет; сохранение не писалось`,
  `- gravity ${cfg.mysteryAnnotation?.gravityMin}–${cfg.mysteryAnnotation?.gravityMax}; situation/scale/association/второй тон не бросаются`,
  `- вариант: ${args.omitTruthNature ? 'B без truthNature' : 'A с truthNature'}`,
  `- пустая доска: карточки независимы, recent/cooldown города нет`,
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
  body.push(`### ${labels[id]}`, tagFreq(rows, id) || '- (нет)', '');
}

body.push('## Карточки', '');
for (const row of rows) body.push(...renderCard(row));

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${body.join('\n').trim()}\n`, 'utf8');
console.log(`отчёт: ${outPath}`);
console.log(`принято ${ok.length} из ${rows.length}`);
