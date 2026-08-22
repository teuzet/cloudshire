import { createLlmProvider } from '../llm/index.js';
import { getLogger, truncate } from '../log.js';
import {
  emptyUsage,
  normalizeUsage,
  addUsage,
  measureRequestFootprint,
  buildRunUsageRecord,
  recordUsageEvent,
  getCurrentWorldId,
} from '../llm/usage.js';

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
    scene = null,
    domainId = null,
  }) {
    const agent = this.getAgentConfig(agentId);
    const provider = this.getProvider(agent.provider);
    const model = agent.model || provider.defaultModel;
    const tokens = maxTokens ?? agent.maxTokens;
    let choice = toolChoice;

    const log = (parentLog || getLogger()).child({
      agentId,
      model,
      scene: scene || undefined,
      worldId: getCurrentWorldId() || undefined,
    });
    const runId = Math.random().toString(36).slice(2, 8);
    const slog = log.child({ runId });
    const runStarted = Date.now();

    // Контракт безопасности нужен только агентам, говорящим с игроком.
    // Системные агенты (resolver/director/genesis/loremaster) общаются с движком.
    // Канон мира раздаётся блоками из config.canon по списку agent.canon.
    const canon = (Array.isArray(agent.canon) ? agent.canon : [])
      .map((key) => this.config.canon?.[key])
      .filter(Boolean)
      .join('\n\n');

    const systemContent = [
      agent.safety ? this.config.agentSafety || '' : '',
      canon,
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

    const footprint = measureRequestFootprint({
      systemContent,
      tools: openAiTools,
      messages,
    });

    let usageTotal = emptyUsage();
    const callUsages = [];

    slog.info('agent.run.start', {
      maxTurns,
      scene: scene || null,
      domainId: domainId || null,
      toolNames: tools.map((t) => t.name),
      forcedTool,
      userPreview: truncate(
        userMessages.map((m) => m.content).filter(Boolean).join('\n'),
        300,
      ),
      extraSystemChars: extraSystem?.length || 0,
      footprint,
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
          usage = normalizeUsage(resp.usage);
          usageTotal = addUsage(usageTotal, usage);
          callUsages.push({ turn, ...usage, ms: Date.now() - started });
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
          const record = this.#finishUsage({
            slog,
            agentId,
            model,
            scene,
            domainId,
            runId,
            turns: turn + 1,
            usageTotal,
            footprint,
            toolTrace,
            truncated: false,
            ms: Date.now() - runStarted,
            callUsages,
          });
          slog.info('agent.run.done', {
            turns: turn + 1,
            truncated: false,
            toolsUsed: toolTrace.map((t) => t.name),
            replyPreview: truncate(message.content || '', 300),
            usage: record.usage,
            costUsd: record.costUsd,
          });
          return {
            text: message.content || '',
            messages,
            toolTrace,
            model,
            agentId,
            scene,
            usage: record.usage,
            costUsd: record.costUsd,
            callUsages,
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
              error: 'invalid_json_args',
              agentMessage: `Невалидный JSON аргументов: ${parseErr.message}. Исправь arguments и вызови tool снова.`,
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
              result = {
                ok: false,
                error: 'unknown_tool',
                agentMessage: `Неизвестный tool «${name}». Вызови один из доступных tools агента.`,
              };
            } else {
              result = await handler(args, { agentId, messages });
            }
          } catch (err) {
            result = {
              ok: false,
              error: 'tool_exception',
              agentMessage: `Сбой tool: ${err.message || String(err)}. Исправь аргументы и повтори, либо выбери другой tool.`,
            };
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

      const record = this.#finishUsage({
        slog,
        agentId,
        model,
        scene,
        domainId,
        runId,
        turns: maxTurns,
        usageTotal,
        footprint,
        toolTrace,
        truncated: true,
        ms: Date.now() - runStarted,
        callUsages,
      });

      slog.warn('agent.run.truncated', {
        maxTurns,
        toolsUsed: toolTrace.map((t) => t.name),
        lastTools: toolTrace.slice(-3).map((t) => ({
          name: t.name,
          ok: t.result?.ok !== false,
          error: t.result?.error,
        })),
        usage: record.usage,
        costUsd: record.costUsd,
      });

      return {
        text: 'Не удалось завершить ответ агента за отведённое число шагов. Попробуй ещё раз.',
        messages,
        toolTrace,
        model,
        agentId,
        scene,
        truncated: true,
        usage: record.usage,
        costUsd: record.costUsd,
        callUsages,
      };
    } catch (err) {
      if (usageTotal.total_tokens > 0) {
        this.#finishUsage({
          slog,
          agentId,
          model,
          scene,
          domainId,
          runId,
          turns: callUsages.length,
          usageTotal,
          footprint,
          toolTrace,
          truncated: false,
          ms: Date.now() - runStarted,
          callUsages,
          failed: true,
        });
      }
      slog.error('agent.run.failed', { error: err.message });
      throw err;
    }
  }

  #finishUsage({
    slog,
    agentId,
    model,
    scene,
    domainId,
    runId,
    turns,
    usageTotal,
    footprint,
    toolTrace,
    truncated,
    ms,
    callUsages,
    failed = false,
  }) {
    const record = buildRunUsageRecord({
      agentId,
      model,
      scene,
      domainId,
      runId,
      turns,
      usage: usageTotal,
      config: this.config,
      footprint,
      toolsUsed: toolTrace.map((t) => t.name),
      truncated,
      ms,
      worldId: getCurrentWorldId(),
    });
    if (failed) record.failed = true;
    if (callUsages?.length) record.calls = callUsages.length;
    slog.info('agent.run.usage', {
      scene: record.scene,
      usage: record.usage,
      costUsd: record.costUsd,
      unknownPricing: record.unknownPricing,
      footprint: record.footprint?.estTokens || null,
      turns: record.turns,
      ms: record.ms,
    });
    recordUsageEvent(record);
    return record;
  }
}
