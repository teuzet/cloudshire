/**
 * Один нарастающий лог агентов на живой город: полный промпт, вызовы tools, результаты.
 * Онбординг и генезис сюда не пишутся — только после того, как город уже играет.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.js';
import { getLogger } from '../log.js';
import { getCurrentWorldId } from '../llm/usage.js';
import { formatAgentPrompt } from './agentPrompt.js';

const RULE = '════════════════════════════════════════════════════════════════';
const THIN = '────────────────────────────────────────────────────────────────';

const GENESIS_AGENTS = new Set([
  'onboarding',
  'genesis',
  'genesisConcept',
  'cityStrengths',
  'cityBrief',
  'cityEntities',
  'officerNature',
  'islandImage',
]);

const GENESIS_SCENES = new Set([
  'onboarding',
  'city_brief',
  'city_strengths',
  'officer_nature',
  'city_entities',
  'island_image_prompt',
]);

const writeLocks = new Map();

/** @type {null | { appendAgentLog?: Function }} */
let agentLogStorage = null;

/**
 * Привязать лог агентов к хранилищу. Пишем в Mongo, только если у него есть appendAgentLog.
 */
export function initCityAgentLogRecording(storage = null) {
  agentLogStorage = storage && typeof storage.appendAgentLog === 'function' ? storage : null;
  return agentLogStorage;
}

export function cityAgentLogEnabled(config) {
  if (config?.logging?.cityAgent === false) return false;
  if (config?.logging?.file === false) return false;
  if (process.env.DYNO || process.env.RAILWAY_ENVIRONMENT) return false;
  return true;
}

/** Сервер с Mongo пишет каждый прогон любого агента, даже когда файлов нет. */
export function shouldLogAgentToMongo({ config } = {}) {
  if (config?.logging?.cityAgent === false) return false;
  return Boolean(agentLogStorage);
}

export function shouldCaptureAgentLog(payload = {}) {
  return shouldLogLiveCityAgent(payload) || shouldLogAgentToMongo(payload);
}

export function shouldLogLiveCityAgent({ config, domainId, agentId, scene } = {}) {
  if (!cityAgentLogEnabled(config)) return false;
  if (!String(domainId || '').trim()) return false;
  if (GENESIS_AGENTS.has(String(agentId || ''))) return false;
  const sc = String(scene || '');
  if (GENESIS_SCENES.has(sc) || sc.startsWith('genesis_')) return false;
  return true;
}

export function cityLogDomainIds(domainId) {
  const raw = String(domainId || '').trim();
  if (!raw) return [];
  if (!raw.includes('+')) return [raw];
  return [...new Set(raw.split('+').map((part) => part.trim()).filter(Boolean))];
}

export function cityAgentLogsDir(config, worldId) {
  const root = config?.logging?.dir || 'logs';
  const abs = path.isAbsolute(root) ? root : path.resolve(projectRoot(), root);
  const world = worldId || getCurrentWorldId();
  if (world) return path.join(abs, 'worlds', String(world), 'cities');
  return path.join(abs, 'cities');
}

export function cityAgentLogPath(config, { domainId, worldId } = {}) {
  const id = String(domainId || '').trim();
  if (!id) return null;
  return path.join(cityAgentLogsDir(config, worldId), `${id}.log`);
}

export function formatCityLogStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date || '');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function pretty(value) {
  if (value == null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function durationLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${Math.round(n)} мс`;
  return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} с`;
}

function formatEvent(event, index) {
  const at = event?.at ? formatCityLogStamp(event.at) : null;
  const kind = event?.type || 'event';
  if (kind === 'llm') {
    const calls = event.toolCalls || [];
    const speech = String(event.content || '').trim();
    const lines = [
      '',
      THIN,
      at ? `${at}  ход ${event.turn ?? index + 1} — ответ модели` : `ход ${event.turn ?? index + 1} — ответ модели`,
      THIN,
    ];
    lines.push(speech || '(без речи)');
    if (!calls.length) return lines.join('\n');
    for (const call of calls) {
      lines.push('', `вызов ${call.name || 'tool'}`, pretty(call.args ?? {}));
    }
    return lines.join('\n');
  }
  if (kind === 'tool') {
    const lines = [
      '',
      THIN,
      at
        ? `${at}  ход ${event.turn ?? '?'} — результат ${event.name || 'tool'}`
        : `результат ${event.name || 'tool'}`,
      THIN,
      pretty(event.result ?? null),
    ];
    return lines.join('\n');
  }
  if (kind === 'nudge') {
    return [
      '',
      THIN,
      at ? `${at}  пинк модели` : 'пинк модели',
      THIN,
      String(event.content || '').trim() || '(пусто)',
    ].join('\n');
  }
  if (kind === 'error') {
    return [
      '',
      THIN,
      at ? `${at}  ошибка` : 'ошибка',
      THIN,
      String(event.error || event.content || 'unknown'),
    ].join('\n');
  }
  return ['', THIN, pretty(event)].join('\n');
}

export function formatCityAgentTranscript(payload = {}) {
  const started = payload.startedAt ? formatCityLogStamp(payload.startedAt) : formatCityLogStamp();
  const city = payload.domainName ? `${payload.domainName}  ·  ${payload.domainId}` : payload.domainId || 'без города';
  const model = [payload.provider, payload.model].filter(Boolean).join('/') || payload.model || 'модель?';
  const scene = payload.scene || '—';
  const agent = payload.agentId || 'агент';
  const parts = [
    RULE,
    `${started}    ${agent}    ${scene}`,
    `город  ${city}`,
    `модель ${model}  ·  run ${payload.runId || '—'}`,
    RULE,
    '',
    'ПРОМПТ',
    THIN,
    formatAgentPrompt(payload.packed) || '(промпт пуст)',
  ];
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (let i = 0; i < events.length; i += 1) {
    parts.push(formatEvent(events[i], i));
  }
  const summary = [
    payload.failed ? 'сбой' : payload.truncated ? 'обрезан' : 'готово',
    Number.isFinite(Number(payload.turns)) ? `${payload.turns} ход.` : null,
    durationLabel(payload.ms),
    payload.toolsUsed?.length ? `tools: ${payload.toolsUsed.join(', ')}` : null,
    payload.error ? `ошибка: ${payload.error}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  parts.push('', THIN, `ИТОГ  ${summary}`, RULE, '');
  return parts.join('\n');
}

function fileBanner({ domainId, domainName, worldId, at }) {
  return [
    '# Лог агентов живого города (после генезиса и онбординга)',
    domainName ? `# город: ${domainName}` : null,
    `# domain: ${domainId}`,
    worldId ? `# мир: ${worldId}` : null,
    `# начат: ${formatCityLogStamp(at)}`,
    '',
  ]
    .filter((line) => line != null)
    .join('\n');
}

function withLock(filePath, fn) {
  const prev = writeLocks.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeLocks.set(filePath, next.catch(() => {}));
  return next;
}

function agentLogDocument(payload, text, worldId) {
  const ids = cityLogDomainIds(payload.domainId);
  const started = payload.startedAt ? new Date(payload.startedAt) : null;
  return {
    ts: new Date().toISOString(),
    worldId: worldId || null,
    domainId: payload.domainId ? String(payload.domainId) : null,
    domainIds: ids,
    domainName: payload.domainName || null,
    agentId: payload.agentId || null,
    scene: payload.scene || null,
    provider: payload.provider || null,
    model: payload.model || null,
    runId: payload.runId || null,
    startedAt: started && !Number.isNaN(started.getTime()) ? started.toISOString() : null,
    ms: Number.isFinite(Number(payload.ms)) ? Number(payload.ms) : null,
    turns: Number.isFinite(Number(payload.turns)) ? Number(payload.turns) : null,
    truncated: Boolean(payload.truncated),
    failed: Boolean(payload.failed),
    error: payload.error ? String(payload.error) : null,
    toolsUsed: Array.isArray(payload.toolsUsed) ? payload.toolsUsed.map(String) : [],
    text,
  };
}

export async function appendCityAgentTranscript(payload) {
  const fileOn = shouldLogLiveCityAgent(payload);
  const mongoOn = shouldLogAgentToMongo(payload);
  if (!fileOn && !mongoOn) return null;
  const worldId = payload.worldId || getCurrentWorldId() || null;
  const text = formatCityAgentTranscript({ ...payload, worldId });
  if (mongoOn) {
    await agentLogStorage.appendAgentLog(agentLogDocument(payload, text, worldId));
  }
  const ids = cityLogDomainIds(payload.domainId);
  if (!fileOn || !ids.length) return [];
  const paths = [];
  for (const domainId of ids) {
    const filePath = cityAgentLogPath(payload.config, { domainId, worldId });
    if (!filePath) continue;
    await withLock(filePath, async () => {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const existed = fs.existsSync(filePath);
      const chunk = existed
        ? text
        : `${fileBanner({
            domainId,
            domainName: payload.domainName || null,
            worldId,
            at: payload.startedAt || new Date(),
          })}\n${text}`;
      await fsp.appendFile(filePath, chunk.endsWith('\n') ? chunk : `${chunk}\n`, 'utf8');
    });
    paths.push(filePath);
  }
  return paths;
}

export function recordCityLlmEvent({ turn, message, at = new Date() } = {}) {
  const calls = (message?.tool_calls || []).map((call) => ({
    name: call.function?.name || call.name || '',
    args: parseToolArgs(call.function?.arguments ?? call.arguments),
  }));
  return {
    type: 'llm',
    turn,
    at,
    content: message?.content || '',
    toolCalls: calls,
  };
}

export function recordCityToolEvent({ turn, name, args, result, at = new Date() } = {}) {
  return { type: 'tool', turn, at, name, args: args ?? {}, result: result ?? null };
}
