/**
 * Стенд тюнинга агентов: прогон этапа по кейсу, запись всех вызовов моделей,
 * отчёты, снимки состояния и сравнение двух прогонов.
 *
 * Раскладка (корень — bench/ в репо):
 *   cases/<этап>/<кейс>.yaml   входы этапов
 *   states/<имя>.json          снимки состояния игры: на них стоят кейсы will и seeding
 *   runs/<id>/                 прогоны: report.md, agents/*.md, calls.json, cassette.json, state.json, run.json
 *   compare/<A>__<B>.md        сравнения прогонов
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AgentDeps, AgentSettings } from '../../agents/_shared/runtime.js';
import type { Rules } from '../../core/rules.js';
import type { Scenario } from '../../core/world/scenario.js';
import type { NamesFile } from '../../flows/world.js';
import type { Llm } from '../../ports/llm.js';
import { BenchLlm, type CallRecord, type Tape } from './llm.js';
import { agentReport, agentStats, mainReport, type RunMeta, type Warning } from './report.js';
import {
  caseState,
  parseCase,
  runGenesisStage,
  runSeedingStage,
  runWillStage,
  STAGES,
  type GenesisCase,
  type SeedingCase,
  type Snapshot,
  type StageName,
  type StageResult,
  type WillCase,
} from './stages.js';

export interface BenchConfig {
  /** Папка стенда (обычно <репо>/bench). */
  dir: string;
  rules: Rules;
  settings: (agent: string) => AgentSettings;
  scenarios: readonly Scenario[];
  names: NamesFile;
  /** Настоящая модель; null — ключей нет, работаем только с кассет. */
  live: Llm | null;
  now: () => number;
  gitSha: string | null;
}

export interface RunOptions {
  stage: StageName;
  caseName: string;
  /** Прогон, чью кассету проигрываем. */
  replay?: string | null;
  /** Эти агенты всегда идут в настоящую модель. */
  forceLive?: string[];
  /** Подменить модель агенту: agent → «провайдер:модель». */
  models?: Record<string, string>;
  label?: string | null;
  seed?: number;
  /** Подменить снимок кейса. */
  state?: string | null;
}

export function isStage(s: string): s is StageName {
  return (STAGES as readonly string[]).includes(s);
}

const p = (cfg: BenchConfig, ...parts: string[]) => path.join(cfg.dir, ...parts);

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
}

function writeJson(file: string, value: unknown): void {
  writeFile(file, JSON.stringify(value, null, 2));
}

export function loadCase(cfg: BenchConfig, stage: StageName, name: string) {
  const file = p(cfg, 'cases', stage, `${name}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`нет кейса ${path.relative(cfg.dir, file)}`);
  return parseCase(stage, yaml.load(fs.readFileSync(file, 'utf8')));
}

export function loadState(cfg: BenchConfig, name: string): Snapshot {
  const file = p(cfg, 'states', `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`нет снимка states/${name}.json — сохрани его из прогона: bench save-state <прогон> ${name}`);
  return readJson<Snapshot>(file);
}

function runId(cfg: BenchConfig, opts: RunOptions): string {
  const d = new Date(cfg.now());
  const stamp = `${d.toISOString().slice(0, 10)}-${d.toISOString().slice(11, 16).replace(':', '')}`;
  const base = [stamp, opts.stage, opts.caseName, opts.label].filter(Boolean).join('-').replace(/[^\w.-]+/g, '_');
  let id = base;
  for (let i = 2; fs.existsSync(p(cfg, 'runs', id)); i++) id = `${base}-${i}`;
  return id;
}

function promptHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);
}

/** Прогнать этап по кейсу и записать всё в runs/<id>/. */
export async function runStage(cfg: BenchConfig, opts: RunOptions): Promise<RunMeta> {
  const c = loadCase(cfg, opts.stage, opts.caseName);
  const stateName = opts.state ?? caseState(c);
  const state = stateName ? loadState(cfg, stateName) : null;
  const replay = opts.replay ? readJson<Tape>(p(cfg, 'runs', opts.replay, 'cassette.json')) : undefined;
  const llm = new BenchLlm({ replay, live: cfg.live, forceLive: new Set(opts.forceLive ?? []), now: cfg.now });
  const warnings: Warning[] = [];
  const models = opts.models ?? {};
  const agents: AgentDeps = {
    llm,
    settings: (agent) => (models[agent] ? { ...cfg.settings(agent), model: models[agent] } : cfg.settings(agent)),
    onCall: (e) => llm.markAttempt(e.agent, e.attempt),
  };
  const env = { rules: cfg.rules, agents, scenarios: cfg.scenarios, names: cfg.names, warn: (event: string, data: Record<string, unknown>) => warnings.push({ event, data }) };
  const seed = opts.seed ?? c.seed ?? 1;
  const id = runId(cfg, opts);
  const startedAt = new Date(cfg.now()).toISOString();

  let result: StageResult | null = null;
  let error: string | null = null;
  try {
    if (opts.stage === 'genesis') result = await runGenesisStage(env, c as GenesisCase, seed);
    else if (opts.stage === 'will') result = await runWillStage(env, c as WillCase, seed, state!);
    else result = await runSeedingStage(env, c as SeedingCase, seed, state!);
    result.after.origin = { run: id, stage: opts.stage, case: opts.caseName };
  } catch (err) {
    error = String(err instanceof Error ? err.message : err);
  }

  const stats = agentStats(llm.calls, warnings);
  const meta: RunMeta = {
    id,
    stage: opts.stage,
    case: opts.caseName,
    title: c.title,
    note: c.note ?? null,
    label: opts.label ?? null,
    state: stateName,
    replayOf: opts.replay ?? null,
    forceLive: opts.forceLive ?? [],
    startedAt,
    gitSha: cfg.gitSha,
    seed,
    agents: Object.fromEntries(
      stats.map((s) => [s.agent, { model: s.model, promptHash: promptHash(llm.calls.find((x) => x.agent === s.agent)!.request.system) }]),
    ),
    totals: {
      calls: llm.calls.length,
      live: llm.calls.filter((x) => x.source === 'live').length,
      cassette: llm.calls.filter((x) => x.source === 'cassette').length,
      inputTokens: stats.reduce((a, s) => a + s.inputTokens, 0),
      outputTokens: stats.reduce((a, s) => a + s.outputTokens, 0),
      ms: stats.reduce((a, s) => a + s.ms, 0),
    },
    outcome: result?.outcome ?? '',
    error,
  };

  const dir = p(cfg, 'runs', id);
  writeJson(path.join(dir, 'run.json'), { ...meta, warnings });
  writeJson(path.join(dir, 'calls.json'), llm.calls);
  writeJson(path.join(dir, 'cassette.json'), llm.tape);
  if (result) writeJson(path.join(dir, 'state.json'), result.after);
  writeFile(path.join(dir, 'report.md'), mainReport(meta, result, stats, warnings));
  for (const s of stats) {
    writeFile(path.join(dir, 'agents', `${s.agent}.md`), agentReport(s.agent, llm.calls.filter((x) => x.agent === s.agent), s, meta));
  }
  return meta;
}

/** Сохранить состояние после прогона как именованный снимок — на нём встанут следующие этапы. */
export function saveState(cfg: BenchConfig, run: string, name: string, note?: string): string {
  const src = p(cfg, 'runs', run, 'state.json');
  if (!fs.existsSync(src)) throw new Error(`у прогона ${run} нет state.json (прогон упал?)`);
  const snap = readJson<Snapshot>(src);
  if (note) snap.origin.note = note;
  const file = p(cfg, 'states', `${name}.json`);
  writeJson(file, snap);
  return file;
}

// ───────────────────────────── сравнение ─────────────────────────────

function finalArgs(c: CallRecord): string {
  const r = c.response;
  if (!r) return `ошибка: ${c.error ?? '?'}`;
  const parts = r.toolCalls.map((t) => {
    try {
      return `${t.name}: ${JSON.stringify(JSON.parse(t.arguments), null, 2)}`;
    } catch {
      return `${t.name}: ${t.arguments}`;
    }
  });
  if (r.text) parts.unshift(r.text);
  return parts.join('\n\n') || '(пусто)';
}

/** Сравнить два прогона по агентам: модели, промпты, токены и ответы бок о бок. */
export function compareRuns(cfg: BenchConfig, a: string, b: string): string {
  const load = (id: string) => ({
    meta: readJson<RunMeta>(p(cfg, 'runs', id, 'run.json')),
    calls: readJson<CallRecord[]>(p(cfg, 'runs', id, 'calls.json')),
  });
  const A = load(a);
  const B = load(b);
  const agents = [...new Set([...Object.keys(A.meta.agents), ...Object.keys(B.meta.agents)])];
  const out = [
    `# Сравнение: A = ${a}, B = ${b}`,
    '',
    `A: ${A.meta.stage}/${A.meta.case}${A.meta.label ? ` [${A.meta.label}]` : ''} — ${A.meta.error ?? A.meta.outcome}`,
    `B: ${B.meta.stage}/${B.meta.case}${B.meta.label ? ` [${B.meta.label}]` : ''} — ${B.meta.error ?? B.meta.outcome}`,
    '',
    '| Агент | Модель A | Модель B | Промпт | Вызовов A / B | Токены out A / B |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const agent of agents) {
    const ma = A.meta.agents[agent];
    const mb = B.meta.agents[agent];
    const ca = A.calls.filter((x) => x.agent === agent);
    const cb = B.calls.filter((x) => x.agent === agent);
    const tok = (cs: CallRecord[]) => cs.reduce((s, x) => s + (x.response?.usage.outputTokens ?? 0), 0);
    const prompt = !ma || !mb ? '—' : ma.promptHash === mb.promptHash ? 'тот же' : 'другой';
    out.push(`| ${agent} | ${ma?.model ?? '—'} | ${mb?.model ?? '—'} | ${prompt} | ${ca.length} / ${cb.length} | ${tok(ca)} / ${tok(cb)} |`);
  }
  for (const agent of agents) {
    const ca = A.calls.filter((x) => x.agent === agent);
    const cb = B.calls.filter((x) => x.agent === agent);
    out.push('', `## ${agent}`);
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
      const x = ca[i];
      const y = cb[i];
      out.push('', `### Вызов ${i + 1}${x && y && x.key === y.key ? ' — запрос тот же' : ''}`, '');
      out.push('**A**', '', '~~~~', x ? finalArgs(x) : '(нет вызова)', '~~~~', '', '**B**', '', '~~~~', y ? finalArgs(y) : '(нет вызова)', '~~~~');
    }
  }
  const text = out.join('\n');
  writeFile(p(cfg, 'compare', `${a}__${b}.md`), text);
  return text;
}

export function listBench(cfg: BenchConfig): string {
  const ls = (...parts: string[]) => (fs.existsSync(p(cfg, ...parts)) ? fs.readdirSync(p(cfg, ...parts)).sort() : []);
  const lines = ['Кейсы:'];
  for (const stage of STAGES) lines.push(`  ${stage}: ${ls('cases', stage).map((f) => f.replace(/\.yaml$/, '')).join(', ') || '—'}`);
  lines.push(`Снимки: ${ls('states').map((f) => f.replace(/\.json$/, '')).join(', ') || '—'}`);
  const runs = ls('runs');
  lines.push(`Прогоны (последние 10 из ${runs.length}):`, ...runs.slice(-10).map((r) => `  ${r}`));
  return lines.join('\n');
}
