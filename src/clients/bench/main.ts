/**
 * CLI стенда тюнинга агентов. Подробности — bench/README.md.
 *
 *   npm run bench -- list
 *   npm run bench -- run <этап> <кейс> [--replay <прогон>] [--live a,b] [--model агент=провайдер:модель]
 *                                      [--label метка] [--seed N] [--state снимок]
 *   npm run bench -- save-state <прогон> <имя> [--note текст]
 *   npm run bench -- compare <прогон A> <прогон B>
 *
 * `run` без --replay и вообще любой промах кассеты идут в настоящие модели:
 * запускать только по просьбе Ника.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentSettings } from '../../agents/_shared/settings.js';
import { parseRules } from '../../core/rules.js';
import type { NamesFile } from '../../flows/world.js';
import type { Llm } from '../../ports/llm.js';
import { buildLlm, loadDotEnv, loadScenarios, readYaml, ROOT } from '../app.js';
import { compareRuns, isStage, listBench, runStage, saveState, type BenchConfig } from './bench.js';

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      const v = inline ?? argv[++i] ?? '';
      (flags[k] ??= []).push(v);
    } else positional.push(a);
  }
  return { positional, flags };
}

function gitSha(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function liveLlm(): Llm | null {
  try {
    return buildLlm(process.env);
  } catch {
    return null;
  }
}

function config(): BenchConfig {
  return {
    dir: path.join(ROOT, 'bench'),
    rules: parseRules(readYaml('config/game.yaml')),
    settings: parseAgentSettings(readYaml('config/agents.yaml')),
    scenarios: loadScenarios(),
    names: readYaml('config/names.yaml') as NamesFile,
    live: liveLlm(),
    now: () => Date.now(),
    gitSha: gitSha(),
  };
}

const USAGE = `Стенд агентов. Команды:
  list
  run <genesis|will|seeding> <кейс> [--replay <прогон>] [--live агент,агент] [--model агент=провайдер:модель] [--label метка] [--seed N] [--state снимок]
  save-state <прогон> <имя> [--note текст]
  compare <прогон A> <прогон B>`;

async function main(): Promise<void> {
  loadDotEnv();
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const one = (k: string) => flags[k]?.at(-1) ?? null;

  if (cmd === 'list') return console.log(listBench(config()));

  if (cmd === 'run') {
    const [stage, caseName] = rest;
    if (!stage || !isStage(stage) || !caseName) throw new Error(USAGE);
    const models = Object.fromEntries(
      (flags.model ?? []).map((m) => {
        const at = m.indexOf('=');
        if (at <= 0) throw new Error(`--model ${m}: нужно агент=провайдер:модель`);
        return [m.slice(0, at), m.slice(at + 1)];
      }),
    );
    const cfg = config();
    if (!cfg.live && !one('replay')) {
      throw new Error('нет ключей моделей (OPENAI_API_KEY / ANTHROPIC_API_KEY в окружении или в .env): живой прогон невозможен. Без ключей можно только повторить прогон с --replay.');
    }
    const seed = one('seed');
    const meta = await runStage(cfg, {
      stage,
      caseName,
      replay: one('replay'),
      forceLive: (flags.live ?? []).flatMap((s) => s.split(',')).filter(Boolean),
      models,
      label: one('label'),
      ...(seed ? { seed: Number(seed) } : {}),
      state: one('state'),
    });
    const t = meta.totals;
    console.log(`${meta.error ? 'УПАЛ' : 'готово'}: ${meta.error ?? meta.outcome}`);
    console.log(`вызовов ${t.calls} (вживую ${t.live}, с кассеты ${t.cassette}), токены ${t.inputTokens} / ${t.outputTokens}`);
    console.log(`отчёт: bench/runs/${meta.id}/report.md`);
    if (meta.error) process.exitCode = 1;
    return;
  }

  if (cmd === 'save-state') {
    const [run, name] = rest;
    if (!run || !name) throw new Error(USAGE);
    console.log(`снимок: ${path.relative(ROOT, saveState(config(), run, name, one('note') ?? undefined))}`);
    return;
  }

  if (cmd === 'compare') {
    const [a, b] = rest;
    if (!a || !b) throw new Error(USAGE);
    compareRuns(config(), a, b);
    console.log(`сравнение: bench/compare/${a}__${b}.md`);
    return;
  }

  console.log(USAGE);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
