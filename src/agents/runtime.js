import { AsyncLocalStorage } from 'node:async_hooks';
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

const deadlineStore = new AsyncLocalStorage();

export function runDeadlineAt() {
  const at = deadlineStore.getStore();
  return Number.isFinite(at) ? at : null;
}

export function deadlineRemainingMs() {
  const at = runDeadlineAt();
  if (at == null) return null;
  return at - Date.now();
}

function llmTimeoutMs() {
  const left = deadlineRemainingMs();
  if (left == null) return undefined;
  return Math.max(2500, Math.min(120_000, left - 200));
}

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

function forcedToolName(toolChoice) {
  if (typeof toolChoice === 'object' && toolChoice?.function?.name) return toolChoice.function.name;
  return typeof toolChoice === 'string' && toolChoice ? toolChoice : null;
}

/**
 * Итоговый tool сдаёт работу агента и заканчивает ход.
 * toolChoice только принуждает первый вызов; сам по себе ход не закрывает.
 * terminal: true/false на определении tool перекрывает правило по имени.
 */
export function toolEndsAgentRun(tool, { soleTool = false } = {}) {
  if (!tool || typeof tool !== 'object') return false;
  if (tool.terminal === true) return true;
  if (tool.terminal === false) return false;
  if (soleTool) return true;
  return /^(submit_|emit_)/.test(String(tool.name || ''));
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

  /** Пакет, который уйдёт в модель: system, user, схема tool. Без вызова провайдера. */
  assembleChat({ agentId, userMessages = [], extraSystem = '', tools = [] } = {}) {
    const agent = this.getAgentConfig(agentId);
    const provider = this.getProvider(agent.provider);
    const model = agent.model || provider.defaultModel;
    const canon = (Array.isArray(agent.canon) ? agent.canon : [])
      .map((key) => this.config.canon?.[key])
      .filter(Boolean)
      .join('\n\n');
    const styles = (Array.isArray(agent.styles) ? agent.styles : [])
      .map((key) => this.config.styles?.[key])
      .filter(Boolean)
      .join('\n\n');
    const systemContent = [
      agent.safety ? this.config.agentSafety || '' : '',
      canon,
      styles,
      agent.instructions,
      extraSystem,
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      agent,
      agentId,
      model,
      provider: agent.provider,
      reasoningEffort: agent.reasoningEffort || null,
      maxTokens: agent.maxTokens || null,
      systemContent,
      messages: [{ role: 'system', content: systemContent }, ...userMessages],
      tools: toOpenAiTools(tools),
    };
  }

  async run({
    agentId,
    userMessages = [],
    tools = [],
    maxTurns = 8,
    extraSystem = '',
    toolChoice,
    maxTokens,
    reasoningEffort,
    log: parentLog,
    scene = null,
    domainId = null,
    deadlineAt = null,
  }) {
    const inherited = runDeadlineAt();
    const nextDeadline = [deadlineAt, inherited]
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reduce((a, b) => Math.min(a, b), Infinity);
    const bound = Number.isFinite(nextDeadline) ? nextDeadline : null;
    if (bound != null && bound !== inherited) {
      return deadlineStore.run(bound, () =>
        this.run({
          agentId,
          userMessages,
          tools,
          maxTurns,
          extraSystem,
          toolChoice,
          maxTokens,
          reasoningEffort,
          log: parentLog,
          scene,
          domainId,
        }),
      );
    }

    const assembled = this.assembleChat({ agentId, userMessages, extraSystem, tools });
    const agent = assembled.agent;
    const provider = this.getProvider(agent.provider);
    const model = assembled.model;
    const tokens = maxTokens ?? agent.maxTokens;
    const effort = reasoningEffort ?? agent.reasoningEffort;
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

    const messages = assembled.messages;
    const openAiTools = assembled.tools;
    const systemContent = assembled.systemContent;
    const handlers = Object.fromEntries(tools.map((t) => [t.name, t.handler]));

    const toolTrace = [];
    const forcedTool = forcedToolName(choice);
    const soleTool = tools.length === 1;
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const endsRun = (name) => toolEndsAgentRun(toolByName.get(name) || { name }, { soleTool });
    const expectsDelivery = tools.some((t) => toolEndsAgentRun(t, { soleTool }));
    const delivered = () =>
      toolTrace.some((t) => t.result?.ok !== false && endsRun(t.name));

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
      reasoningEffort: effort || null,
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
      const finish = ({ truncated = false, turns, text = '', extra = {} } = {}) => {
        const record = this.#finishUsage({
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
          ms: Date.now() - runStarted,
          callUsages,
        });
        const payload = {
          turns,
          truncated: Boolean(truncated),
          toolsUsed: toolTrace.map((t) => t.name),
          replyPreview: truncate(text || '', 300),
          usage: record.usage,
          costUsd: record.costUsd,
          ...extra,
        };
        if (truncated) slog.warn('agent.run.truncated', payload);
        else slog.info('agent.run.done', payload);
        return {
          text: text || '',
          messages,
          toolTrace,
          model,
          agentId,
          scene,
          ...(truncated ? { truncated: true } : {}),
          usage: record.usage,
          costUsd: record.costUsd,
          callUsages,
        };
      };

      for (let turn = 0; turn < maxTurns; turn += 1) {
        let lastToolFailed = false;
        const tlog = slog.child({ turn });
        const left = deadlineRemainingMs();
        if (left != null && left < 2500) {
          tlog.warn('agent.llm.deadline', { remainingMs: left });
          break;
        }

        tlog.debug('agent.llm.request', {
          messageCount: messages.length,
          toolChoice: forcedTool && choice ? forcedTool : null,
          reasoningEffort: effort || null,
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
            reasoningEffort: effort,
            timeoutMs: llmTimeoutMs(),
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
          const stillForcing = Boolean(choice);
          const waiting = expectsDelivery && !delivered();
          if ((stillForcing || waiting) && turn < maxTurns - 1) {
            tlog.warn('agent.nudge.no_tool', {
              expected: stillForcing ? forcedTool : 'deliverable',
            });
            messages.push({
              role: 'user',
              content: stillForcing
                ? 'Ответ без tool недопустим. Сейчас вызови требуемый tool.'
                : 'Ход ещё не сдан. Вызови итоговый tool (submit_… / emit_…).',
            });
            continue;
          }
          return finish({
            turns: turn + 1,
            text: message.content || '',
          });
        }

        const orderedCalls = [...toolCalls].sort((a, b) => {
          const aEnd = endsRun(a.function?.name) ? 1 : 0;
          const bEnd = endsRun(b.function?.name) ? 1 : 0;
          return aEnd - bEnd;
        });

        for (const call of orderedCalls) {
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

        if (delivered()) {
          return finish({
            turns: turn + 1,
            text: message.content || '',
          });
        }

        if (!lastToolFailed) choice = undefined;
        else tlog.debug('agent.keep_forcing', { tool: forcedTool });
      }

      return finish({
        truncated: true,
        turns: maxTurns,
        text: 'Не удалось завершить ответ агента за отведённое число шагов. Попробуй ещё раз.',
        extra: {
          lastTools: toolTrace.slice(-3).map((t) => ({
            name: t.name,
            ok: t.result?.ok !== false,
            error: t.result?.error,
          })),
        },
      });
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
