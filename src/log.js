import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function stamp() {
  return new Date().toISOString();
}

function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

function truncate(value, max = 800) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}…[+${value.length - max}]` : value;
  }
  try {
    const s = JSON.stringify(value);
    if (s.length <= max) return value;
    return JSON.parse(JSON.stringify(value, (_k, v) => {
      if (typeof v === 'string' && v.length > 200) return `${v.slice(0, 200)}…`;
      return v;
    }));
  } catch {
    return String(value).slice(0, max);
  }
}

function summarizeMessages(messages = []) {
  return messages.map((m) => {
    const base = { role: m.role };
    if (m.content) base.content = truncate(String(m.content), 400);
    if (m.tool_calls?.length) {
      base.tool_calls = m.tool_calls.map((c) => ({
        name: c.function?.name,
        argsPreview: truncate(c.function?.arguments || '', 300),
      }));
    }
    if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
    return base;
  });
}

class Logger {
  constructor({ level = 'info', filePath = null, context = {} } = {}) {
    this.level = LEVELS[level] != null ? level : 'info';
    this.filePath = filePath;
    this.context = context;
  }

  child(extra = {}) {
    return new Logger({
      level: this.level,
      filePath: this.filePath,
      context: { ...this.context, ...extra },
    });
  }

  enabled(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  write(level, event, data = {}) {
    if (!this.enabled(level)) return;
    const entry = {
      ts: stamp(),
      event,
      ...this.context,
      ...data,
      level,
    };
    const line = JSON.stringify(entry);
    const pretty = `[${entry.ts}] ${level.toUpperCase()} ${event}${this.context.reqId ? ` req=${this.context.reqId}` : ''}${this.context.agentId ? ` agent=${this.context.agentId}` : ''}`;

    if (level === 'error') console.error(pretty, data?.error || data?.message || '');
    else if (level === 'warn') console.warn(pretty);
    else console.log(pretty);

    if (level === 'debug' || data.detail || data.tool || data.usage || data.error) {
      const detail = { ...data };
      if (detail.messages) detail.messages = summarizeMessages(detail.messages);
      if (detail.args) detail.args = truncate(detail.args, 600);
      if (detail.result) detail.result = truncate(detail.result, 600);
      if (detail.reply) detail.reply = truncate(detail.reply, 400);
      if (detail.text) detail.text = truncate(detail.text, 400);
      console.log('  └', JSON.stringify(detail));
    }

    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
      } catch (err) {
        console.error('[log] write failed', err.message);
      }
    }
  }

  debug(event, data) {
    this.write('debug', event, data);
  }

  info(event, data) {
    this.write('info', event, data);
  }

  warn(event, data) {
    this.write('warn', event, data);
  }

  error(event, data) {
    this.write('error', event, data);
  }
}

let rootLogger = null;

export function initLogger(config = {}) {
  const level = process.env.LOG_LEVEL || config.logging?.level || 'debug';
  const wantFile = config.logging?.file !== false;
  let filePath = null;
  let session = new Date().toISOString().replace(/[:.]/g, '-');

  if (wantFile) {
    const dir = path.resolve(
      projectRoot(),
      config.logging?.dir || process.env.LOG_DIR || 'logs',
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, `session-${session}.log`);
    } catch (err) {
      console.warn('[log] file sink disabled:', err.message);
      filePath = null;
    }
  }

  rootLogger = new Logger({ level, filePath, context: { session } });
  rootLogger.info('session.start', {
    filePath: filePath || null,
    logToFile: Boolean(filePath),
    logLevel: level,
    pid: process.pid,
    node: process.version,
  });
  return rootLogger;
}

/** Привязать текущий worldId ко всем последующим лог-событиям. */
export function setLoggerWorldId(worldId) {
  if (!rootLogger) return;
  if (worldId) rootLogger.context.worldId = String(worldId);
  else delete rootLogger.context.worldId;
}

export function getLogger() {
  if (!rootLogger) {
    rootLogger = new Logger({ level: process.env.LOG_LEVEL || 'info' });
  }
  return rootLogger;
}

export function requestLogger() {
  return getLogger().child({ reqId: shortId() });
}

export { summarizeMessages, truncate, shortId };
