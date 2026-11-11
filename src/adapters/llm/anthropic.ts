/**
 * Адаптер Anthropic (Messages API). Один запрос — один ответ.
 *
 * Особенности текущих моделей:
 * - принудительный tool_choice (any/tool) у Opus 5.5, Sonnet 5.5, Fable 5.1+ даёт 400,
 *   поэтому для них просим auto — агенты и так требуют итоговый тул словами и повторяют;
 * - блоки мышления надо вернуть в следующем запросе как есть: они лежат в providerContent;
 * - на отказ модели включён серверный фолбэк (fallbacks: "default").
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Llm, LlmMessage, LlmRequest, LlmResponse } from '../../ports/llm.js';

const PROVIDER = 'anthropic';
const NO_FORCED_TOOL = /^claude-(opus-5-5|sonnet-5-5|fable-5-[12]|mythos-5-[12])/;
const SERVER_FALLBACK = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-[12])$/;

type Param = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

export function toAnthropicMessages(messages: LlmMessage[]): Param[] {
  const out: Param[] = [];
  const pushUser = (block: Block) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
    else out.push({ role: 'user', content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'user') pushUser({ type: 'text', text: m.content });
    else if (m.role === 'tool') pushUser({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    else if (m.providerContent?.provider === PROVIDER) {
      out.push({ role: 'assistant', content: m.providerContent.blocks as Block[] });
    } else {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: JSON.parse(c.arguments || '{}') as Record<string, unknown> });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] });
    }
  }
  return out;
}

export function anthropicToolChoice(model: string, choice: LlmRequest['toolChoice']): Anthropic.Beta.BetaToolChoice | undefined {
  if (!choice || choice === 'auto' || NO_FORCED_TOOL.test(model)) return choice ? { type: 'auto' } : undefined;
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.name };
}

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; timeoutMs?: number } = {}) {
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: 0,
    });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const fallback = SERVER_FALLBACK.test(request.model);
    const choice = anthropicToolChoice(request.model, request.toolChoice);
    const response = await this.client.beta.messages.create(
      {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 16000,
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: toAnthropicMessages(request.messages),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
              })),
              ...(choice ? { tool_choice: choice } : {}),
            }
          : {}),
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    let text = '';
    const toolCalls: LlmResponse['toolCalls'] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
    const stop = response.stop_reason === 'refusal' ? 'refusal' : response.stop_reason === 'max_tokens' ? 'length' : 'done';
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      model: response.model,
      stop,
      providerContent: { provider: PROVIDER, blocks: response.content },
    };
  }
}
