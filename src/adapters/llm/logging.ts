/**
 * Журнал вызовов агентов: каждый вызов модели ложится отдельным файлом в папку
 * (промпт, сообщения, ответ, токены, время, ошибка), а строка сводки — в calls.jsonl.
 * Нужен, чтобы разбирать живую игру: что агент увидел и что ответил.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Llm, LlmRequest, LlmResponse } from '../../ports/llm.js';

export interface CallSummary {
  n: number;
  at: string;
  agent: string;
  model: string;
  ms: number;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  file: string;
  error?: string;
}

function fence(text: string): string {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}\n${text}\n${ticks}`;
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function renderCall(request: LlmRequest, response: LlmResponse | null, error: string | null, ms: number): string {
  const out: string[] = [`# ${request.agent} · ${request.model} · ${ms} мс`];
  if (response) out.push(`токены: вход ${response.usage.inputTokens} (кэш ${response.usage.cachedInputTokens}), выход ${response.usage.outputTokens}, стоп ${response.stop}`);
  if (error) out.push(`**Ошибка:** ${error}`);
  out.push('## Системный промпт', fence(request.system));
  if (request.tools?.length) out.push('## Тулы', request.tools.map((t) => `- \`${t.name}\`: ${t.description}`).join('\n'));
  out.push('## Сообщения');
  for (const m of request.messages) {
    if (m.role === 'user') out.push('### user', fence(m.content));
    else if (m.role === 'tool') out.push(`### tool → ${m.toolCallId}`, fence(pretty(m.content)));
    else {
      out.push('### assistant');
      if (m.content) out.push(fence(m.content));
      for (const c of m.toolCalls ?? []) out.push(`\`${c.name}\``, fence(pretty(c.arguments)));
    }
  }
  if (response) {
    out.push('## Ответ');
    if (response.text) out.push(fence(response.text));
    for (const c of response.toolCalls) out.push(`\`${c.name}\``, fence(pretty(c.arguments)));
  }
  return out.join('\n\n') + '\n';
}

export class LoggingLlm implements Llm {
  private n: number;

  constructor(
    private readonly inner: Llm,
    private readonly dir: string,
    private readonly onCall: (s: CallSummary) => void = () => {},
  ) {
    fs.mkdirSync(dir, { recursive: true });
    const summary = path.join(dir, 'calls.jsonl');
    this.n = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8').split('\n').filter(Boolean).length : 0;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const n = ++this.n;
    const started = Date.now();
    let response: LlmResponse | null = null;
    let error: string | null = null;
    try {
      response = await this.inner.complete(request);
      return response;
    } catch (err) {
      error = String(err);
      throw err;
    } finally {
      const ms = Date.now() - started;
      const file = `${String(n).padStart(4, '0')}-${request.agent}.md`;
      const summary: CallSummary = {
        n,
        at: new Date(started).toISOString(),
        agent: request.agent,
        model: request.model,
        ms,
        ok: !error,
        inputTokens: response?.usage.inputTokens ?? 0,
        outputTokens: response?.usage.outputTokens ?? 0,
        cachedInputTokens: response?.usage.cachedInputTokens ?? 0,
        file,
        ...(error ? { error } : {}),
      };
      try {
        fs.writeFileSync(path.join(this.dir, file), renderCall(request, response, error, ms));
        fs.appendFileSync(path.join(this.dir, 'calls.jsonl'), JSON.stringify(summary) + '\n');
      } catch {
        // Журнал не должен ронять игру.
      }
      this.onCall(summary);
    }
  }
}
