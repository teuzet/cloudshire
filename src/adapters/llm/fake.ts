/**
 * Модель-заглушка для тестов и офлайн-прогонов. Отвечает по сценарию:
 * на каждый агент — очередь ответов или функция от запроса.
 * Все запросы записываются, чтобы тест мог проверить, что ушло в модель.
 */

import type { Llm, LlmRequest, LlmResponse, ToolCall } from '../../ports/llm.js';

export type FakeReply = Partial<LlmResponse> | ((request: LlmRequest) => Partial<LlmResponse>);

let seq = 0;

/** Ответ моделью-вызовом тула. */
export function toolReply(name: string, args: unknown, extra: Partial<LlmResponse> = {}): Partial<LlmResponse> {
  const call: ToolCall = { id: `call_${++seq}`, name, arguments: JSON.stringify(args) };
  return { toolCalls: [call], ...extra, ...(extra.toolCalls ? { toolCalls: [...extra.toolCalls, call] } : {}) };
}

/** Несколько вызовов тулов в одном ответе. */
export function toolsReply(...calls: Array<[string, unknown]>): Partial<LlmResponse> {
  return { toolCalls: calls.map(([name, args]) => ({ id: `call_${++seq}`, name, arguments: JSON.stringify(args) })) };
}

export function textReply(text: string): Partial<LlmResponse> {
  return { text };
}

export class FakeLlm implements Llm {
  readonly requests: LlmRequest[] = [];
  private readonly queues = new Map<string, FakeReply[]>();
  private readonly fallbacks = new Map<string, FakeReply>();

  /** Очередь ответов агенту: каждый вызов снимает следующий. */
  script(agent: string, ...replies: FakeReply[]): this {
    this.queues.set(agent, [...(this.queues.get(agent) ?? []), ...replies]);
    return this;
  }

  /** Ответ агенту, когда очередь пуста (или её нет). */
  always(agent: string, reply: FakeReply): this {
    this.fallbacks.set(agent, reply);
    return this;
  }

  callsTo(agent: string): LlmRequest[] {
    return this.requests.filter((r) => r.agent === agent);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const queue = this.queues.get(request.agent);
    const reply = queue?.length ? queue.shift() : this.fallbacks.get(request.agent);
    if (!reply) throw new Error(`FakeLlm: нет ответа для агента ${request.agent}`);
    const partial = typeof reply === 'function' ? reply(request) : reply;
    return {
      text: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      model: `fake:${request.model}`,
      stop: 'done',
      ...partial,
    };
  }
}
