/**
 * Модель стенда: каждый вызов записывается, ответ берётся с кассеты прошлого
 * прогона или из настоящей модели.
 *
 *   - кассета есть и агент не в списке `live` — ответ с кассеты, бесплатно;
 *   - иначе настоящая модель, если ключи есть; нет ключей — понятная ошибка.
 *
 * Все ответы прогона (и с кассеты, и живые) пишутся в его собственную кассету,
 * так что любой прогон можно повторить.
 */

import { requestKey } from '../../adapters/llm/cassette.js';
import type { Llm, LlmRequest, LlmResponse } from '../../ports/llm.js';

export type CallSource = 'live' | 'cassette';

export interface CallRecord {
  seq: number;
  agent: string;
  /** Номер попытки или шага внутри одного вызова агента (1 — первый). */
  attempt: number;
  key: string;
  source: CallSource;
  request: Omit<LlmRequest, 'signal'>;
  response: LlmResponse | null;
  error: string | null;
  ms: number;
}

export type Tape = Record<string, LlmResponse>;

export class BenchLlm implements Llm {
  readonly calls: CallRecord[] = [];
  readonly tape: Tape = {};

  constructor(
    private readonly opts: {
      /** Кассета прошлого прогона. */
      replay?: Tape;
      /** Настоящая модель; null — без ключей. */
      live: Llm | null;
      /** Агенты, которых всегда зовём вживую, даже если на кассете есть ответ. */
      forceLive?: ReadonlySet<string>;
      /** Часы для замера времени вызова (стенд — клиент, ему можно настоящие). */
      now: () => number;
    },
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const key = requestKey(request);
    const { signal: _signal, ...plain } = request;
    const record: CallRecord = {
      seq: this.calls.length + 1,
      agent: request.agent,
      attempt: 1,
      key,
      source: 'cassette',
      request: structuredClone(plain),
      response: null,
      error: null,
      ms: 0,
    };
    this.calls.push(record);

    const hit = this.opts.forceLive?.has(request.agent) ? undefined : this.opts.replay?.[key];
    const started = this.opts.now();
    try {
      let response: LlmResponse;
      if (hit) {
        response = structuredClone(hit);
      } else {
        record.source = 'live';
        if (!this.opts.live) {
          throw new Error(
            `${request.agent}: на кассете нет ответа, а ключей моделей нет. Задай OPENAI_API_KEY / ANTHROPIC_API_KEY или повтори прогон без правок промптов.`,
          );
        }
        response = await this.opts.live.complete(request);
      }
      record.response = structuredClone(response);
      this.tape[key] = structuredClone(response);
      return response;
    } catch (err) {
      record.error = String(err);
      throw err;
    } finally {
      record.ms = this.opts.now() - started;
    }
  }

  /** Номер попытки приходит из onCall рантайма агентов — сразу после ответа. */
  markAttempt(agent: string, attempt: number): void {
    const last = [...this.calls].reverse().find((c) => c.agent === agent);
    if (last) last.attempt = attempt;
  }
}
