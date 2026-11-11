/**
 * Кассеты: записанные ответы настоящей модели, которые тест проигрывает без сети.
 * Ключ — хеш значимой части запроса (агент, модель, system, сообщения, тулы).
 *
 * Запись идёт только явно (RecordingLlm поверх настоящего адаптера) и только
 * по просьбе Ника: это настоящие вызовы и настоящие деньги.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Llm, LlmRequest, LlmResponse } from '../../ports/llm.js';

export function requestKey(request: LlmRequest): string {
  const significant = {
    agent: request.agent,
    model: request.model,
    system: request.system,
    messages: request.messages.map((m) => (m.role === 'assistant' ? { ...m, providerContent: undefined } : m)),
    tools: request.tools ?? [],
    toolChoice: request.toolChoice ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(significant)).digest('hex').slice(0, 16);
}

type Tape = Record<string, LlmResponse>;

function readTape(file: string): Tape {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Tape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export class ReplayLlm implements Llm {
  private readonly tape: Tape;
  constructor(readonly file: string) {
    this.tape = readTape(file);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const key = requestKey(request);
    const hit = this.tape[key];
    if (!hit) throw new Error(`кассета ${path.basename(this.file)}: нет записи ${key} для ${request.agent}. Промпт поменялся — перезапиши кассету.`);
    return structuredClone(hit);
  }
}

export class RecordingLlm implements Llm {
  private readonly tape: Tape;
  constructor(
    private readonly inner: Llm,
    readonly file: string,
  ) {
    this.tape = readTape(file);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.complete(request);
    this.tape[requestKey(request)] = response;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.tape, null, 2));
    return response;
  }
}
