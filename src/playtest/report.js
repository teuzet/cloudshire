import fs from 'node:fs/promises';
import path from 'node:path';
import { chronicleEntries } from '../game/models.js';
import { collectFlags } from './heuristics.js';

function factsOf(domain) {
  return (domain.lore || []).filter((f) => (f.tags || []).includes('fact'));
}

function activePending(domain) {
  return (domain.state?.pendingActions || [])
    .filter((a) => a.status === 'active')
    .map((a) => ({
      id: a.id,
      summary: a.summary,
      detail: a.detail,
      monthsDone: a.monthsDone ?? 0,
      durationMonths: a.durationMonths ?? 1,
    }));
}

export function splitLore(domain) {
  return {
    chronicle: chronicleEntries(domain.lore).map((e) => ({
      id: e.id,
      text: e.text,
      tags: e.tags,
      tick: e.tick,
      gameDateLabel: e.gameDateLabel,
    })),
    facts: factsOf(domain).map((e) => ({
      id: e.id,
      text: e.text,
      tags: e.tags,
      author: e.author,
    })),
  };
}

export function buildGenesisSnapshot(domain) {
  const lore = splitLore(domain);
  const character = domain.characters?.[0];
  return {
    domainId: domain.id,
    name: domain.name,
    population: domain.population,
    stats: domain.stats,
    ruler: character
      ? { name: character.name, title: character.title, description: character.description }
      : null,
    descriptionPreview: String(domain.description || '').slice(0, 800),
    factCount: lore.facts.length,
    chronicleCount: lore.chronicle.length,
    milestones: (domain.milestones || []).map((m) => m.text),
  };
}

export function buildDomainSnapshot(domain) {
  const lore = splitLore(domain);
  return {
    domainId: domain.id,
    name: domain.name,
    population: domain.population,
    stats: domain.stats,
    pending: activePending(domain),
    state: {
      events: domain.state?.events || [],
      modifiers: domain.state?.modifiers || [],
    },
    milestones: (domain.milestones || []).map((m) => ({
      text: m.text,
      status: m.status,
      points: m.points,
    })),
    ...lore,
  };
}

function mdEscape(s) {
  return String(s || '').replace(/\r\n/g, '\n');
}

export function buildSummaryMarkdown({
  scenario,
  ticks,
  ticksDone,
  steps,
  scripted,
  forcedRemaining,
  genesis,
  snapshot,
  transcript,
  flags,
  dataDir,
  outDir,
}) {
  const lines = [];
  lines.push(`# Playtest: ${scenario.id || 'smoke'}`);
  lines.push('');
  lines.push(`- scenario: \`${scenario.id}\``);
  lines.push(`- cityName (forced): **${scenario.cityName}**`);
  lines.push(`- domain: **${genesis.name}** (\`${genesis.domainId}\`)`);
  lines.push(`- ruler: ${genesis.ruler?.name || '?'} (${genesis.ruler?.title || ''})`);
  lines.push(
    `- ticks: **${ticksDone}/${ticks}** за ${steps} шагов${scripted ? ' (scripted)' : ' (LLM player)'}`,
  );
  if (forcedRemaining) lines.push('- warning: оставшиеся тики дожаты harness (`max_steps`)');
  if (scenario.ambition) {
    lines.push(`- ambition: ${String(scenario.ambition).replace(/\s+/g, ' ').trim()}`);
  }
  lines.push(`- data-dir: \`${dataDir}\``);
  lines.push(`- out: \`${outDir}\``);
  lines.push('');
  lines.push('## Genesis');
  lines.push('');
  lines.push(`- facts: ${genesis.factCount}, chronicle: ${genesis.chronicleCount}`);
  lines.push(`- population: ${genesis.population}`);
  lines.push(`- stats: \`${JSON.stringify(genesis.stats)}\``);
  if (genesis.milestones?.length) {
    lines.push('- milestones:');
    for (const m of genesis.milestones) lines.push(`  - ${m}`);
  }
  lines.push('');
  lines.push('## Timeline');
  lines.push('');
  for (const t of transcript) {
    if (t.kind === 'tick') {
      lines.push(`### Шаг ${t.step} — FORCE TICK (#${t.ticksDone})`);
      lines.push('');
      if (t.forced) lines.push(`_forced:_ ${t.reason || 'yes'}`);
      if (t.tick) {
        lines.push(
          `_date:_ ${t.tick.gameDate?.label || '?'} (tickIndex=${t.tick.tickIndex})`,
        );
      }
      if (t.tickNews) {
        lines.push('');
        lines.push(`**Новости месяца:** ${mdEscape(t.tickNews)}`);
      }
      lines.push('');
      continue;
    }

    lines.push(`### Шаг ${t.step} — диалог (тиков сделано: ${t.ticksDone})`);
    lines.push('');
    lines.push(`**Покровитель:** ${mdEscape(t.player)}`);
    lines.push('');
    lines.push(`**Правитель:** ${mdEscape(t.ruler)}`);
    lines.push('');
    const tools = (t.toolTrace || []).map((x) => x.name).filter(Boolean);
    if (tools.length) lines.push(`_ruler tools:_ ${tools.join(', ')}`);
    lines.push('');
  }

  lines.push('## Pending (итог)');
  lines.push('');
  if (!snapshot.pending.length) {
    lines.push('(нет active pending)');
  } else {
    for (const p of snapshot.pending) {
      lines.push(
        `- **${p.summary}** (${p.monthsDone}/${p.durationMonths}): ${p.detail || ''}`,
      );
    }
  }
  lines.push('');

  lines.push('## State (итог)');
  lines.push('');
  const events = snapshot.state?.events || [];
  const modifiers = snapshot.state?.modifiers || [];
  lines.push('### events');
  if (!events.length) lines.push('(нет)');
  else for (const e of events) lines.push(`- ${e.text || e}`);
  lines.push('');
  lines.push('### modifiers (постоянные)');
  if (!modifiers.length) lines.push('(нет)');
  else for (const m of modifiers) lines.push(`- [${m.kind || 'other'}] ${m.text}`);
  lines.push('');

  lines.push('## Milestones (только игрок / отчёт)');
  lines.push('');
  const ms = snapshot.milestones || [];
  if (!ms.length) lines.push('(нет)');
  else for (const m of ms) lines.push(`- [${m.status || 'open'}] ${m.text}`);
  lines.push('');

  lines.push('## Chronicle (итог)');
  lines.push('');
  if (!snapshot.chronicle.length) {
    lines.push('(пусто)');
  } else {
    for (const c of snapshot.chronicle) {
      lines.push(`- [${c.gameDateLabel || ''}] ${c.text}`);
    }
  }
  lines.push('');

  lines.push('## Facts (итог, первые 20)');
  lines.push('');
  const facts = snapshot.facts.slice(0, 20);
  for (const f of facts) {
    lines.push(`- ${f.text}`);
  }
  if (snapshot.facts.length > 20) {
    lines.push(`- … ещё ${snapshot.facts.length - 20}`);
  }
  lines.push('');

  lines.push('## Heuristic flags');
  lines.push('');
  if (!flags.length) {
    lines.push('(нет)');
  } else {
    for (const f of flags) {
      lines.push(`- step ${f.step}: \`${f.flag}\``);
    }
  }
  lines.push('');

  return lines.join('\n');
}

export async function writeArtifacts(outDir, {
  scenario,
  ticks,
  ticksDone,
  steps,
  scripted,
  forcedRemaining,
  tickResults,
  genesis,
  domain,
  transcript,
  dataDir,
}) {
  await fs.mkdir(outDir, { recursive: true });
  const snapshot = buildDomainSnapshot(domain);
  const flags = collectFlags(transcript, domain);
  if (forcedRemaining) {
    flags.push({ step: steps, flag: 'forced_remaining_ticks' });
  }
  const summary = buildSummaryMarkdown({
    scenario,
    ticks,
    ticksDone,
    steps,
    scripted,
    forcedRemaining,
    genesis,
    snapshot,
    transcript,
    flags,
    dataDir,
    outDir,
  });

  await fs.writeFile(path.join(outDir, 'summary.md'), summary, 'utf8');
  await fs.writeFile(
    path.join(outDir, 'genesis.json'),
    JSON.stringify(genesis, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'transcript.json'),
    JSON.stringify(transcript, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'domain-snapshot.json'),
    JSON.stringify(snapshot, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'flags.json'),
    JSON.stringify(flags, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'ticks.json'),
    JSON.stringify(tickResults || [], null, 2),
    'utf8',
  );

  return { outDir, flags, snapshot };
}
