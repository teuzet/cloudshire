import OpenAI from 'openai';

export class LlmError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LlmError';
    this.cause = cause;
  }
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
  async chat({ model, messages, tools, toolChoice, maxTokens }) {
    this.ensureClient();
    try {
      const body = {
        model: model || this.defaultModel,
        messages,
      };
      if (tools?.length) {
        body.tools = tools;
        if (toolChoice) body.tool_choice = toolChoice;
        // gpt-5.x chat/completions + tools require reasoning_effort none
        if (/^gpt-5/i.test(body.model || '')) {
          body.reasoning_effort = 'none';
        }
      }
      if (maxTokens) {
        // GPT-5+ chat completions expect max_completion_tokens
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
}
