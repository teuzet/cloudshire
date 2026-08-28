import OpenAI from 'openai';

/** DALL·E снят в мае 2026: response_format больше нельзя слать, модель — gpt-image-*. */
export function normalizeImageParams({ model, prompt, size, quality } = {}) {
  const requested = String(model || '').trim();
  const gptImage = !requested || /^dall-e/i.test(requested) ? 'gpt-image-2' : requested;
  let q = quality || undefined;
  if (!q || /^(standard|hd)$/i.test(q)) {
    q = /^hd$/i.test(q) ? 'high' : 'medium';
  }
  let s = size || '1536x1024';
  if (/^gpt-image-1(?!-2)/i.test(gptImage) && s === '1792x1024') s = '1536x1024';
  if (/^gpt-image-1(?!-2)/i.test(gptImage) && s === '1024x1792') s = '1024x1536';
  return {
    model: gptImage,
    prompt,
    n: 1,
    size: s,
    quality: q,
  };
}

export class LlmError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LlmError';
    this.cause = cause;
  }
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function normalizeReasoningEffort(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return REASONING_EFFORTS.includes(s) ? s : null;
}

/** Явная настройка агента; иначе gpt-5 + tools остаётся none. */
export function resolveReasoningEffort({ model, tools, reasoningEffort } = {}) {
  const requested = normalizeReasoningEffort(reasoningEffort);
  if (requested) return requested;
  if (tools?.length && /^gpt-5/i.test(model || '')) return 'none';
  return undefined;
}

export function createLlmProvider(config, providerName = 'openai') {
  if (providerName === 'openai') {
    return new OpenAiProvider(config);
  }
  throw new Error(`Unknown LLM provider: ${providerName}`);
}

export class OpenAiProvider {
  constructor(config) {
    this.name = 'openai';
    this.config = config;
    const keyEnv = config.llm.openai.apiKeyEnv || 'OPENAI_API_KEY';
    const apiKey = process.env[keyEnv];
    if (!apiKey) {
      this.client = null;
      this.missingKey = keyEnv;
    } else {
      this.client = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 1 });
      this.missingKey = null;
    }
    this.defaultModel = config.llm.openai.defaultModel || 'gpt-4o-mini';
  }

  ensureClient() {
    if (!this.client) {
      throw new LlmError(
        `OpenAI API key missing. Set ${this.missingKey} in .env (see .env.example).`,
      );
    }
  }

  /**
   * @param {object} opts
   * @param {string} opts.model
   * @param {array} opts.messages
   * @param {array} [opts.tools]
   * @param {string|object} [opts.toolChoice]
   */
  async chat({ model, messages, tools, toolChoice, maxTokens, reasoningEffort }) {
    this.ensureClient();
    try {
      const body = {
        model: model || this.defaultModel,
        messages,
      };
      if (tools?.length) {
        body.tools = tools;
        if (toolChoice) body.tool_choice = toolChoice;
      }
      const effort = resolveReasoningEffort({
        model: body.model,
        tools,
        reasoningEffort,
      });
      if (effort) body.reasoning_effort = effort;
      if (maxTokens) {
        if (/^gpt-5/i.test(body.model || '')) body.max_completion_tokens = maxTokens;
        else body.max_tokens = maxTokens;
      }
      const completion = await this.client.chat.completions.create(body);
      const message = completion.choices[0]?.message;
      if (!message) throw new LlmError('Empty completion from OpenAI');
      return {
        message,
        usage: completion.usage,
        raw: completion,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError(err.message || 'OpenAI request failed', err);
    }
  }

  /**
   * Картинка через Images API. Возвращает буфер PNG/JPEG.
   */
  async image({ model, prompt, size, quality }) {
    this.ensureClient();
    try {
      const body = normalizeImageParams({ model, prompt, size, quality });
      const result = await this.client.images.generate(body);
      const item = result.data?.[0];
      if (item?.b64_json) {
        return { buffer: Buffer.from(item.b64_json, 'base64'), raw: result };
      }
      if (item?.url) {
        const fetched = await fetch(item.url);
        if (!fetched.ok) throw new LlmError(`Image download failed: ${fetched.status}`);
        return { buffer: Buffer.from(await fetched.arrayBuffer()), raw: result };
      }
      throw new LlmError('Empty image from OpenAI');
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError(err.message || 'OpenAI image request failed', err);
    }
  }
}
