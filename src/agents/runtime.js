import { createLlmProvider } from '../llm/index.js';
import { getLogger, truncate } from '../log.js';

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
    log: parentLog,
  }) {
    const agent = this.getAgentConfig(agentId);
    const provider = this.getProvider(agent.provider);
    const model = agent.model || provider.defaultModel;
    const tokens = maxTokens ?? agent.maxTokens;
    let choice = toolChoice;

    const log = (parentLog || getLogger()).child({ agentId, model });
    const runId = Math.random().toString(36).slice(2, 8);
    const slog = log.child({ runId });

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
    const forcedTool =
      typeof choice === 'object' && choice?.function?.name ? choice.function.name : choice || null;

    slog.info('agent.run.start', {
      maxTurns,
      toolNames: tools.map((t) => t.name),
      forcedTool,
      userPreview: truncate(
        userMessages.map((m) => m.content).filter(Boolean).join('\n'),
        300,
      ),
      extraSystemChars: extraSystem?.length || 0,
    });

    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        let lastToolFailed = false;
        const tlog = slog.child({ turn });

        tlog.debug('agent.llm.request', {
          messageCount: messages.length,
          toolChoice: forcedTool && choice ? forcedTool : null,
        });

        const started = Date.now();
        let usage;
        let message;
        try {
          const resp = await provider.chat({
            model,
            messages,
            tools: openAiTools.length ? openAiTools : undefined,
            toolChoice: openAiTools.length ? choice : undefined,
            maxTokens: tokens,
          });
          message = resp.message;
          usage = resp.usage;
        } catch (err) {
          tlog.error('agent.llm.error', {
            error: err.message,
            ms: Date.now() - started,
          });
          throw err;
        }

        tlog.info('agent.llm.response', {
          ms: Date.now() - started,
          usage,
          hasContent: Boolean(message.content),
          contentPreview: truncate(message.content || '', 250),
          toolCallNames: (message.tool_calls || []).map((c) => c.function?.name),
        });

        messages.push(message);

        const toolCalls = message.tool_calls || [];
        if (!toolCalls.length) {
          if (choice && turn < maxTurns - 1) {
            tlog.warn('agent.nudge.no_tool', { expected: forcedTool });
            messages.push({
              role: 'user',
              content: 'Ответ без tool недопустим. Сейчас вызови требуемый tool.',
            });
            continue;
          }
          slog.info('agent.run.done', {
            turns: turn + 1,
            truncated: false,
            toolsUsed: toolTrace.map((t) => t.name),
            replyPreview: truncate(message.content || '', 300),
          });
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
          } catch (parseErr) {
            const result = {
              ok: false,
              error: `Невалидный JSON аргументов: ${parseErr.message}. Вызови tool снова.`,
            };
            toolTrace.push({ name, args: {}, result });
            tlog.warn('agent.tool.parse_error', {
              tool: name,
              rawPreview: truncate(call.function?.arguments || '', 400),
              error: parseErr.message,
            });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
            lastToolFailed = true;
            continue;
          }

          let result;
          const toolStarted = Date.now();
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
          tlog.info('agent.tool', {
            tool: name,
            ok: result?.ok !== false,
            ms: Date.now() - toolStarted,
            args: truncate(args, 500),
            result: truncate(result, 500),
          });

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result ?? { ok: true }),
          });
          if (result && result.ok === false) lastToolFailed = true;
        }

        if (!lastToolFailed) choice = undefined;
        else tlog.debug('agent.keep_forcing', { tool: forcedTool });
      }

      slog.warn('agent.run.truncated', {
        maxTurns,
        toolsUsed: toolTrace.map((t) => t.name),
        lastTools: toolTrace.slice(-3).map((t) => ({
          name: t.name,
          ok: t.result?.ok !== false,
          error: t.result?.error,
        })),
      });

      return {
        text: 'Не удалось завершить ответ агента за отведённое число шагов. Попробуй ещё раз.',
        messages,
        toolTrace,
        model,
        agentId,
        truncated: true,
      };
    } catch (err) {
      slog.error('agent.run.failed', { error: err.message });
      throw err;
    }
  }
}
