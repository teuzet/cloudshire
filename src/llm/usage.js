/**
 * Учёт токенов и оценка $ по конфигу llm.pricing.
 * Sink: Mongo collection `usage` (если storage с appendUsage) и/или logs/worlds/<worldId>/usage.jsonl.
 */

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.js';
import { getLogger } from '../log.js';

export function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

/** Нормализовать usage из ответа API (включая cached, если есть). */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const total = Number(raw.total_tokens) || prompt + completion;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
  const cached =
    raw.prompt_tokens_details?.cached_tokens ??
    raw.input_tokens_details?.cached_tokens ??
    raw.cached_tokens;
  if (cached != null && Number.isFinite(Number(cached))) {
    out.cached_tokens = Number(cached);
  }
  return out;
}

export function addUsage(a, b) {
  const x = normalizeUsage(a);
  const y = normalizeUsage(b);
  const out = {
    prompt_tokens: x.prompt_tokens + y.prompt_tokens,
    completion_tokens: x.completion_tokens + y.completion_tokens,
    total_tokens: x.total_tokens + y.total_tokens,
  };
  const cached = (x.cached_tokens || 0) + (y.cached_tokens || 0);
  if (cached) out.cached_tokens = cached;
  return out;
}

/** Цены за 1M токенов: { input, output, cachedInput? }. */
export function lookupPricing(model, config) {
  const table = config?.llm?.pricing?.models || {};
  const key = String(model || '').trim();
  if (table[key]) return { ...table[key], model: key };
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (key.startsWith(k)) return { ...table[k], model: k, matched: key };
  }
  return config?.llm?.pricing?.default || { input: 0, output: 0, unknown: true };
}

/**
 * Оценка USD. cachedInput — если задан и есть cached_tokens.
 */
export function estimateCostUsd(usage, model, config) {
  const u = normalizeUsage(usage);
  const price = lookupPricing(model, config);
  const inputRate = Number(price.input) || 0;
  const outputRate = Number(price.output) || 0;
  const cachedRate =
    price.cachedInput != null ? Number(price.cachedInput) : inputRate * 0.1;

  let promptBillable = u.prompt_tokens;
  let cached = 0;
  if (u.cached_tokens > 0) {
    cached = Math.min(u.cached_tokens, u.prompt_tokens);
    promptBillable = u.prompt_tokens - cached;
  }

  const usd =
    (promptBillable / 1e6) * inputRate +
    (cached / 1e6) * cachedRate +
    (u.completion_tokens / 1e6) * outputRate;

  return {
    usd: Math.round(usd * 1e6) / 1e6,
    pricing: price,
    unknownPricing: Boolean(price.unknown),
  };
}

/** Грубая оценка токенов по символам (для разбивки prompt до ответа API). */
export function estimateTokensFromChars(chars) {
  const n = Math.max(0, Number(chars) || 0);
  return Math.ceil(n / 3.5);
}

export function jsonSize(value) {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
}

/**
 * Размер частей запроса до вызова (chars + грубые tokens).
 */
export function measureRequestFootprint({ systemContent = '', tools = [], messages = [] } = {}) {
  const systemChars = String(systemContent || '').length;
  const toolsChars = jsonSize(tools);
  let historyChars = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.content) historyChars += String(m.content).length;
    if (m.tool_calls) historyChars += jsonSize(m.tool_calls);
  }
  const totalChars = systemChars + toolsChars + historyChars;
  return {
    chars: {
      system: systemChars,
      tools: toolsChars,
      history: historyChars,
      total: totalChars,
    },
    estTokens: {
      system: estimateTokensFromChars(systemChars),
      tools: estimateTokensFromChars(toolsChars),
      history: estimateTokensFromChars(historyChars),
      total: estimateTokensFromChars(totalChars),
    },
  };
}

let usageFilePath = null;
let usageEnabled = true;
let currentWorldId = null;
/** @type {null | { appendUsage?: Function }} */
let usageStorage = null;
let usageWriteFile = true;

export function worldLogsDir(config, worldId) {
  const logsDir = path.resolve(projectRoot(), config.logging?.dir || 'logs');
  return path.join(logsDir, 'worlds', String(worldId));
}

export function getCurrentWorldId() {
  return currentWorldId;
}

/**
 * Привязать запись usage к миру. Вызывать после getWorld / после wipe.
 * @param {object} [storage] — если есть appendUsage, пишем в Mongo.
 */
export function initUsageRecording(config = {}, worldId = null, storage = null) {
  const cfg = config.llm?.usage || {};
  usageEnabled = cfg.enabled !== false;
  currentWorldId = worldId ? String(worldId) : null;
  usageStorage =
    storage && typeof storage.appendUsage === 'function' ? storage : null;
  usageWriteFile = config.logging?.file !== false && !process.env.DYNO;

  if (!usageEnabled) {
    usageFilePath = null;
    return null;
  }
  if (!currentWorldId) {
    usageFilePath = null;
    getLogger().warn('usage.no_world', {
      hint: 'initUsageRecording без worldId — usage не пишется',
    });
    return null;
  }

  usageFilePath = null;
  if (usageWriteFile) {
    try {
      const dir = worldLogsDir(config, currentWorldId);
      fs.mkdirSync(dir, { recursive: true });
      usageFilePath = path.join(dir, 'usage.jsonl');
    } catch (err) {
      getLogger().warn('usage.file_unavailable', { error: err.message });
    }
  }

  getLogger().info('usage.recording', {
    filePath: usageFilePath,
    mongo: Boolean(usageStorage),
    worldId: currentWorldId,
    enabled: true,
  });
  return usageFilePath;
}

export function getUsageFilePath() {
  return usageFilePath;
}

export function recordUsageEvent(event) {
  if (!usageEnabled) return;
  const row = {
    ...event,
    worldId: event.worldId || currentWorldId || null,
  };
  if (usageStorage) {
    void usageStorage.appendUsage(row).catch((err) => {
      getLogger().warn('usage.mongo_write_failed', { error: err.message });
    });
  }
  if (!usageFilePath) return;
  try {
    fs.appendFileSync(usageFilePath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (err) {
    getLogger().warn('usage.write_failed', { error: err.message });
  }
}

/** Сводка одного agent.run для лога и JSONL. */
export function buildRunUsageRecord({
  agentId,
  model,
  scene,
  domainId,
  runId,
  turns,
  usage,
  config,
  footprint = null,
  toolsUsed = [],
  truncated = false,
  ms = null,
  worldId = null,
}) {
  const norm = normalizeUsage(usage);
  const cost = estimateCostUsd(norm, model, config);
  return {
    ts: new Date().toISOString(),
    kind: 'agent_run',
    worldId: worldId || currentWorldId || null,
    agentId,
    model,
    scene: scene || null,
    domainId: domainId || null,
    runId: runId || null,
    turns,
    truncated: Boolean(truncated),
    ms,
    usage: norm,
    costUsd: cost.usd,
    unknownPricing: cost.unknownPricing,
    pricingModel: cost.pricing?.model || model,
    footprint,
    toolsUsed,
  };
}
