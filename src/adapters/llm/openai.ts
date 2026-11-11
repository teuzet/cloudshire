/**
 * Адаптер OpenAI (Chat Completions). Один запрос — один ответ, без ретраев:
 * повтор решает вызывающий.
 */

import OpenAI from 'openai';
import type { Llm, LlmMessage, LlmRequest, LlmResponse } from '../../ports/llm.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAiMessages(system: string, messages: LlmMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      });
  }
  return out;
}

function toolChoice(choice: LlmRequest['toolChoice']): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'required') return choice;
  return { type: 'function', function: { name: choice.name } };
}

export class OpenAiLlm implements Llm {
  private readonly client: OpenAI;

  constructor(opts: { apiKey: string; timeoutMs?: number }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 0 });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const reasoning = /^(gpt-5|o\d)/i.test(request.model);
    const completion = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAiMessages(request.system, request.messages),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                type: 'function' as const,
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: toolChoice(request.toolChoice),
            }
          : {}),
        ...(request.maxOutputTokens
          ? reasoning
            ? { max_completion_tokens: request.maxOutputTokens }
            : { max_tokens: request.maxOutputTokens }
          : {}),
        ...(reasoning && request.effort ? { reasoning_effort: request.effort } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );
    const choice = completion.choices[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((c) =>
      c.type === 'function' ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
    );
    return {
      text: message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cachedInputTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      model: completion.model,
      stop: choice?.finish_reason === 'length' ? 'length' : message?.refusal ? 'refusal' : 'done',
    };
  }
}
