/**
 * Адаптер OpenAI (Responses API). Один запрос — один ответ, без ретраев:
 * повтор решает вызывающий.
 *
 * Responses, а не Chat Completions: у моделей с рассуждением (gpt-5.x) Chat Completions
 * не принимает тулы вместе с рассуждением. Запросы не хранятся на стороне OpenAI (store: false),
 * поэтому элементы ответа, включая зашифрованное рассуждение, лежат в providerContent
 * и в следующем ходе того же агента отдаются назад как есть.
 */

import OpenAI from 'openai';
import type { Llm, LlmMessage, LlmRequest, LlmResponse } from '../../ports/llm.js';

type InputItem = OpenAI.Responses.ResponseInputItem;

const PROVIDER = 'openai';

export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

export function toOpenAiInput(messages: LlmMessage[]): InputItem[] {
  const out: InputItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    else if (m.providerContent?.provider === PROVIDER) out.push(...(m.providerContent.blocks as InputItem[]));
    else {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      for (const c of m.toolCalls ?? []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
    }
  }
  return out;
}

export function openAiToolChoice(choice: LlmRequest['toolChoice']): OpenAI.Responses.ResponseCreateParams['tool_choice'] {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'required') return choice;
  return { type: 'function', name: choice.name };
}

export class OpenAiLlm implements Llm {
  private readonly client: OpenAI;

  constructor(opts: { apiKey: string; timeoutMs?: number }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 0 });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const reasoning = isReasoningModel(request.model);
    const response = await this.client.responses.create(
      {
        model: request.model,
        instructions: request.system,
        input: toOpenAiInput(request.messages),
        store: false,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                type: 'function' as const,
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                strict: false,
              })),
              tool_choice: openAiToolChoice(request.toolChoice),
            }
          : {}),
        ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
        ...(reasoning
          ? {
              include: ['reasoning.encrypted_content' as const],
              ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
            }
          : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    let text = '';
    let refusal = false;
    const toolCalls: LlmResponse['toolCalls'] = [];
    for (const item of response.output) {
      if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') text += part.text;
          else if (part.type === 'refusal') refusal = true;
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
      }
    }
    const truncated = response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens';
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      model: response.model,
      stop: truncated ? 'length' : refusal ? 'refusal' : 'done',
      providerContent: { provider: PROVIDER, blocks: response.output },
    };
  }
}
