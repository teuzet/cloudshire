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

function formatJudgeDecision(label, judge) {
  if (!judge) return [];
  const lines = [
    `**${label}:** ${judge.verdict}${judge.summary ? ` — ${judge.summary}` : ''}`,
  ];
  for (const issue of judge.issues || []) {
    const loc = issue.location ? ` @ ${issue.location}` : '';
    lines.push(`- \`${issue.code}\`${loc}: ${issue.reason}`);
  }
  return lines;
}

function skipLabel(skip) {
  if (skip === 'no_seed') return 'генератор не вернул сюжет';
  if (skip === 'missing_graph') return 'нет причинного графа';
  if (skip === 'twin') return 'близнец уже идущей истории';
  return skip || null;
}

function formatIssue(issue) {
  if (!issue) return '';
  const loc = issue.location ? ` @ ${issue.location}` : '';
  return `${issue.code || 'OTHER'}${loc}: ${issue.reason || ''}`.trim();
}

function formatAttemptHeadline(a) {
  const n = a.attempt != null ? a.attempt : `g${Number(a.genTry) + 1}`;
  const prefix = `попытка ${n}`;
  if (a.skip && !a.lunaJudge) {
    return `${prefix}: ${skipLabel(a.skip)}${a.title ? ` «${a.title}»` : ''}`;
  }
  const luna = a.lunaJudge?.verdict || '?';
  const terra = a.terraJudge?.verdict;
  const summary = a.terraJudge?.summary || a.lunaJudge?.summary || '';
  const chain = terra ? `Luna ${luna} → Terra ${terra}` : `Luna ${luna}`;
  const mark = a.accepted ? 'принята' : a.skip ? skipLabel(a.skip) : 'отклонена';
  const title = a.title ? ` «${a.title}»` : '';
  return `${prefix}${title}: ${mark} (${chain})${summary ? ` — ${summary}` : ''}`;
}

function renderAttempt(a) {
  const lines = [];
  const n = a.attempt != null ? a.attempt : `g${Number(a.genTry) + 1}`;
  const status = skipLabel(a.skip) || (a.accepted ? 'принята' : 'отклонена');
  lines.push(`#### Попытка ${n} — ${status}`);
  lines.push('');
  if (a.tags?.length) lines.push(formatTags(a.tags));
  if (a.title) lines.push(`«${a.title}»`);
  if (a.graphShape) lines.push(`граф ${a.graphShape}${a.people?.length ? ` · люди: ${a.people.join(', ')}` : ''}`);
  if (a.anchors?.length) {
    lines.push('');
    lines.push(formatMysteryAnchorsForPrompt(a.anchors));
  }
  const luna = formatJudgeDecision('Luna', a.lunaJudge);
  const terra = formatJudgeDecision('Terra', a.terraJudge);
  if (luna.length || terra.length) {
    lines.push('');
    lines.push(...luna);
    if (terra.length) lines.push(...terra);
  }
  if (a.graph) {
    lines.push('');
    lines.push(formatTruthGraphForPrompt(a.graph));
  }
  if (a.entry) {
    lines.push('');
    lines.push(a.entry);
  }
  if (a.synopsis) {
    lines.push('');
    lines.push(a.synopsis);
  }
  if (a.closeWhen) lines.push(`закрыть когда: ${a.closeWhen}`);
  lines.push('');
  return lines;
}

function collectJudgeStats(rows) {
  const attempts = rows.flatMap((r) => r.judgeAttempts || []);
  const luna = { PASS: 0, FAIL: 0, UNCERTAIN: 0 };
  const terra = { PASS: 0, FAIL: 0, UNCERTAIN: 0 };
  const codes = new Map();
  let judged = 0;
  let skipped = 0;
  for (const a of attempts) {
    if (a.skip && !a.lunaJudge) {
      skipped += 1;
      continue;
    }
    judged += 1;
    if (a.lunaJudge?.verdict && luna[a.lunaJudge.verdict] != null) luna[a.lunaJudge.verdict] += 1;
    if (a.terraJudge?.verdict && terra[a.terraJudge.verdict] != null) {
      terra[a.terraJudge.verdict] += 1;
    }
    for (const issue of [...(a.lunaJudge?.issues || []), ...(a.terraJudge?.issues || [])]) {
      const key = issue.code || 'OTHER';
      codes.set(key, (codes.get(key) || 0) + 1);
    }
  }
  const codeLines = [...codes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `- ${code}: ${n}`);
  return { attempts: attempts.length, judged, skipped, luna, terra, codeLines };
}

function renderCard(row) {
  const lines = [];
  lines.push(`### ${row.n}. ${row.ok ? `«${row.title}»` : 'не взошло'}`);
  lines.push('');
  lines.push(formatTags(row.tags) || '(жребий пуст)');
  const attempts = row.judgeAttempts || [];
  const rejected = attempts.filter((a) => !a.accepted);
  const accepted = attempts.filter((a) => a.accepted);

  if (!row.ok) {
    lines.push('');
    if (!attempts.length) {
      lines.push(row.error ? `ошибка: ${row.error}` : 'движок отсёк завязку или агент ничего не вернул');
      lines.push('');
      return lines;
    }
    lines.push(`каскад: ${attempts.length} попыток, ни одна не принята.`);
    lines.push('');
    for (const a of attempts) lines.push(...renderAttempt(a));
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
      row.lunaJudge ? `Luna ${row.lunaJudge}` : null,
      row.terraJudge ? `Terra ${row.terraJudge}` : null,
      row.urgency != null ? `urgency ${row.urgency}` : null,
      row.gravity != null ? `gravity ${row.gravity}` : null,
      row.importance != null ? `важность ${row.importance}` : null,
      row.maxAgeMonths != null ? `срок ${row.maxAgeMonths}` : null,
      row.relatedStats.length ? `статы ${row.relatedStats.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const win = accepted[accepted.length - 1] || null;
  if (win?.lunaJudge || win?.terraJudge) {
    lines.push('');
    lines.push(...formatJudgeDecision('Luna', win.lunaJudge));
    if (win.terraJudge) lines.push(...formatJudgeDecision('Terra', win.terraJudge));
  }
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
  if (rejected.length) {
    lines.push('Отклонённые попытки до этой:');
    lines.push('');
    for (const a of rejected) lines.push(...renderAttempt(a));
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
    if (storyType === 'mystery') {
      for (const attempt of result?.attempts || []) {
        process.stdout.write(`  ${formatAttemptHeadline(attempt)}\n`);
        const issues = [
          ...(attempt.lunaJudge?.issues || []),
          ...(attempt.terraJudge?.issues || []),
        ];
        for (const issue of issues.slice(0, 8)) {
          process.stdout.write(`    · ${formatIssue(issue)}\n`);
        }
        if (issues.length > 8) {
          process.stdout.write(`    · … и ещё ${issues.length - 8}\n`);
        }
      }
      process.stdout.write(`  → ${plot ? 'карточка принята' : 'карточка пропущена'}\n`);
    }
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
      lunaJudge: result?.judge?.lunaJudge?.verdict || null,
      terraJudge: result?.judge?.terraJudge?.verdict || null,
      judgeAttempts: result?.attempts || null,
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
  ];

  if (mysteryRows.length) {
    const st = collectJudgeStats(mysteryRows);
    body.push(
      '## Каскад валидации',
      '',
      `- попыток генератора: ${st.attempts} · дошло до judge: ${st.judged} · без графа/ответа: ${st.skipped}`,
      `- Luna: PASS ${st.luna.PASS} · FAIL ${st.luna.FAIL} · UNCERTAIN ${st.luna.UNCERTAIN}`,
      `- Terra: PASS ${st.terra.PASS} · FAIL ${st.terra.FAIL} · UNCERTAIN ${st.terra.UNCERTAIN}`,
      '',
      'Частые коды отказов:',
      st.codeLines.length ? st.codeLines.join('\n') : '- (нет)',
      '',
    );
  }

  body.push(
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
  );

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
