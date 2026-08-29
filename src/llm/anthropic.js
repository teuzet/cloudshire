import { LlmError } from './openai.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function asBlocks(content) {
  if (content == null || content === '') return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: String(content) }];
}

function concatContent(a, b) {
  const left = asBlocks(a);
  const right = asBlocks(b);
  const onlyText = [...left, ...right].every((x) => x.type === 'text');
  if (onlyText) {
    const text = [...left, ...right]
      .map((x) => x.text)
      .filter(Boolean)
      .join('\n\n');
    return text;
  }
  return [...left, ...right];
}

export function toAnthropicTools(openAiTools = []) {
  return openAiTools.map((t) => {
    const fn = t?.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  });
}

export function toAnthropicToolChoice(toolChoice) {
  if (toolChoice == null || toolChoice === false) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required' || toolChoice === 'any') return { type: 'any' };
  const name = toolChoice?.function?.name || toolChoice?.name;
  if (name) return { type: 'tool', name };
  return undefined;
}

export function toAnthropicRequest(openaiMessages = []) {
  const systemParts = [];
  const raw = [];

  for (const m of openaiMessages) {
    if (!m) continue;
    if (m.role === 'system') {
      const t = asText(m.content).trim();
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      raw.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: asText(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = asText(m.content).trim();
      if (text) blocks.push({ type: 'text', text });
      for (const call of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(call.function?.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name,
          input,
        });
      }
      raw.push({
        role: 'assistant',
        content: blocks.length ? blocks : [{ type: 'text', text: '' }],
      });
      continue;
    }
    raw.push({ role: 'user', content: asText(m.content) });
  }

  const messages = [];
  for (const m of raw) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) {
      last.content = concatContent(last.content, m.content);
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  if (messages[0]?.role === 'assistant') {
    messages.unshift({ role: 'user', content: '(продолжение)' });
  }

  return {
    system: systemParts.join('\n\n'),
    messages,
  };
}

export function fromAnthropicMessage(resp) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  const texts = [];
  const tool_calls = [];
  for (const b of blocks) {
    if (b?.type === 'text' && b.text) texts.push(b.text);
    if (b?.type === 'tool_use') {
      tool_calls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  const message = {
    role: 'assistant',
    content: texts.join('\n') || null,
  };
  if (tool_calls.length) message.tool_calls = tool_calls;
  return message;
}

export class AnthropicProvider {
  constructor(config) {
    this.name = 'anthropic';
    this.config = config;
    const cfg = config?.llm?.anthropic || {};
    const keyEnv = cfg.apiKeyEnv || 'ANTHROPIC_API_KEY';
    this.apiKey = process.env[keyEnv] || '';
    this.missingKey = this.apiKey ? null : keyEnv;
    this.defaultModel = cfg.defaultModel || 'claude-sonnet-5';
    this.version = cfg.version || ANTHROPIC_VERSION;
    this.baseUrl = cfg.baseUrl || ANTHROPIC_URL;
  }

  ensureClient() {
    if (!this.apiKey) {
      throw new LlmError(
        `Anthropic API key missing. Set ${this.missingKey} in .env (see .env.example).`,
      );
    }
  }

  async chat({ model, messages, tools, toolChoice, maxTokens, timeoutMs }) {
    this.ensureClient();
    const { system, messages: converted } = toAnthropicRequest(messages || []);
    if (!converted.length) {
      throw new LlmError('Empty messages for Anthropic');
    }
    const body = {
      model: model || this.defaultModel,
      max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
      messages: converted,
    };
    if (system) body.system = system;
    if (tools?.length) {
      body.tools = toAnthropicTools(tools);
      const choice = toAnthropicToolChoice(toolChoice);
      if (choice) body.tool_choice = choice;
    }

    const ctrl = timeoutMs ? AbortSignal.timeout(Math.max(1, timeoutMs)) : undefined;
    let resp;
    let rawText = '';
    try {
      resp = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
        },
        body: JSON.stringify(body),
        signal: ctrl,
      });
      rawText = await resp.text();
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError(err.message || 'Anthropic request failed', err);
    }

    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }
    if (!resp.ok) {
      const msg =
        data?.error?.message || data?.error?.type || rawText.slice(0, 400) || `HTTP ${resp.status}`;
      throw new LlmError(`Anthropic ${resp.status}: ${msg}`);
    }
    if (!data) throw new LlmError('Empty completion from Anthropic');
    return {
      message: fromAnthropicMessage(data),
      usage: data.usage || {},
      raw: data,
    };
  }

  async image() {
    throw new LlmError('Anthropic provider does not generate images.');
  }
}
