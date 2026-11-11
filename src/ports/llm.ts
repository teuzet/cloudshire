/**
 * Порт языковой модели. Один вызов — один ответ модели: текст и/или вызовы тулов.
 * Цикл «вызвал тул → получил результат → продолжил» собирает агент, не адаптер.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-строка аргументов как её вернула модель. */
  arguments: string;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema аргументов. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  /** Какой агент зовёт: для логов, учёта и выбора модели. */
  agent: string;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  /** required — модель обязана вызвать какой-то тул; объект — конкретный. */
  toolChoice?: 'auto' | 'required' | { name: string };
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  model: string;
}

export interface Llm {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
