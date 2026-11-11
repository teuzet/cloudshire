/**
 * Модель в настройках агента пишется как «провайдер:модель»
 * (openai:gpt-5.6-luna, anthropic:claude-opus-5-5). Роутер снимает префикс
 * и отдаёт запрос нужному адаптеру.
 */

import type { Llm, LlmRequest, LlmResponse } from '../../ports/llm.js';

export function splitModel(model: string): { provider: string; model: string } {
  const at = model.indexOf(':');
  if (at <= 0) throw new Error(`модель «${model}»: нужен префикс провайдера, например openai:${model}`);
  return { provider: model.slice(0, at), model: model.slice(at + 1) };
}

export class RoutingLlm implements Llm {
  constructor(private readonly providers: Record<string, Llm>) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const { provider, model } = splitModel(request.model);
    const llm = this.providers[provider];
    if (!llm) throw new Error(`провайдер ${provider} не подключён (агент ${request.agent})`);
    return llm.complete({ ...request, model });
  }
}
