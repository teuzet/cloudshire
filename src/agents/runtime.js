import { createLlmProvider } from '../llm/index.js';

export function toOpenAiTools(toolDefs = []) {
  return toolDefs.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

export class AgentRuntime {
  constructor(config) {
    this.config = config;
    this.providers = new Map();
  }

  getProvider(name) {
    const key = name || this.config.llm.defaultProvider || 'openai';
    if (!this.providers.has(key)) {
      this.providers.set(key, createLlmProvider(this.config, key));
    }
    return this.providers.get(key);
  }

  getAgentConfig(agentId) {
    const agent = this.config.agents?.[agentId];
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  async run({
    agentId,
    userMessages = [],
    tools = [],
    maxTurns = 8,
    extraSystem = '',
    toolChoice,
    maxTokens,
  }) {
    const agent = this.getAgentConfig(agentId);
    const provider = this.getProvider(agent.provider);
    const model = agent.model || provider.defaultModel;
    const tokens = maxTokens ?? agent.maxTokens;
    let choice = toolChoice;

    const systemContent = [
      this.config.agentSafety || '',
      agent.instructions,
      extraSystem,
    ]
      .filter(Boolean)
      .join('\n\n');

    const messages = [{ role: 'system', content: systemContent }, ...userMessages];

    const openAiTools = toOpenAiTools(tools);
    const handlers = Object.fromEntries(tools.map((t) => [t.name, t.handler]));

    const toolTrace = [];

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const { message } = await provider.chat({
        model,
        messages,
        tools: openAiTools.length ? openAiTools : undefined,
        toolChoice: openAiTools.length ? choice : undefined,
        maxTokens: tokens,
      });

      messages.push(message);

      const toolCalls = message.tool_calls || [];
      if (!toolCalls.length) {
        return {
          text: message.content || '',
          messages,
          toolTrace,
          model,
          agentId,
        };
      }

      for (const call of toolCalls) {
        const name = call.function?.name;
        const handler = handlers[name];
        let args = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }

        let result;
        try {
          if (!handler) {
            result = { ok: false, error: `Unknown tool: ${name}` };
          } else {
            result = await handler(args, { agentId, messages });
          }
        } catch (err) {
          result = { ok: false, error: err.message || String(err) };
        }

        toolTrace.push({ name, args, result });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result ?? { ok: true }),
        });
      }

      // After a forced tool call, allow free continuation on later turns
      choice = undefined;
    }

    return {
      text: 'Не удалось завершить ответ агента за отведённое число шагов. Попробуй ещё раз.',
      messages,
      toolTrace,
      model,
      agentId,
      truncated: true,
    };
  }
}
