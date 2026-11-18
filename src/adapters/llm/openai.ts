/**
 * Адаптер OpenAI (Responses API). Один запрос — один ответ, без ретраев:
 * повтор решает вызывающий.
 *
 * Responses, а не Chat Completions: у моделей с рассуждением (gpt-5.x) Chat Completions
 * не принимает тулы вместе с рассуждением. Запросы не хранятся на стороне OpenAI (store: false),
 * поэтому элементы ответа, включая зашифрованное рассуждение, лежат в providerContent
 * и в следующем ходе того же агента отдаются назад как есть.
 */

import fs from 'node:fs';
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

/** Примерно 1024 токена русского текста: короче OpenAI не кэширует. */
const MIN_CACHED_CHARS = 3500;

/**
 * Неизменное начало системного промпта агента. Промпт агента — шаблон, в хвост которого
 * подставлены данные мира, поэтому общее начало всех его промптов и есть шаблон. Граница
 * срезается до конца строки, чтобы она стояла на одном и том же месте от вызова к вызову.
 */
export class StablePrefixes {
  private readonly seen = new Map<string, string>();

  /** file — где хранить границы между запусками (плейтест и перезапуски бота), иначе только в памяти. */
  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return;
    try {
      for (const [agent, prefix] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>)) {
        this.seen.set(agent, prefix);
      }
    } catch {
      // Испорченный файл — начинаем с пустого.
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.seen)));
    } catch {
      // Кэш не должен ронять игру.
    }
  }

  /** Сколько первых знаков промпта можно кэшировать (0 — пока нечего). */
  boundary(agent: string, system: string): number {
    const known = this.seen.get(agent);
    if (known == null) {
      this.seen.set(agent, system);
      this.save();
      return 0;
    }
    let i = 0;
    const max = Math.min(known.length, system.length);
    while (i < max && known.charCodeAt(i) === system.charCodeAt(i)) i++;
    const cut = i === system.length ? i : system.lastIndexOf('\n', i - 1) + 1;
    if (cut < known.length) {
      this.seen.set(agent, known.slice(0, cut));
      this.save();
    }
    return cut >= MIN_CACHED_CHARS ? cut : 0;
  }
}

/**
 * Явный кэш OpenAI: системный промпт идёт developer-сообщением, неизменное начало — отдельным
 * блоком с точкой кэша. Так в кэш пишется только шаблон, а хвост с данными мира не пишется
 * (запись стоит 1,25 входа). Многошаговым запросам (тулы, повторы, история) оставлена и неявная точка
 * в конце: следующий шаг того же агента продолжает этот же префикс.
 */
export function explicitCacheInput(system: string, boundary: number, messages: InputItem[]): {
  input: InputItem[];
  mode: 'explicit' | 'implicit';
} {
  const content: OpenAI.Responses.ResponseInputMessageContentList = boundary > 0
    ? [
        { type: 'input_text', text: system.slice(0, boundary), prompt_cache_breakpoint: { mode: 'explicit' } },
        ...(boundary < system.length ? [{ type: 'input_text' as const, text: system.slice(boundary) }] : []),
      ]
    : [{ type: 'input_text', text: system }];
  return {
    input: [{ role: 'developer', content }, ...messages],
    // Пока граница не известна (первый вызов агента), ничего не пишем: запись без чтения дороже.
    mode: boundary > 0 && messages.length > 1 ? 'implicit' : 'explicit',
  };
}

export function openAiToolChoice(choice: LlmRequest['toolChoice']): OpenAI.Responses.ResponseCreateParams['tool_choice'] {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'required') return choice;
  return { type: 'function', name: choice.name };
}

export class OpenAiLlm implements Llm {
  private readonly client: OpenAI;

  private readonly cacheKey: boolean;
  private readonly explicitCache: boolean;
  private readonly prefixes: StablePrefixes;

  constructor(opts: { apiKey: string; timeoutMs?: number; cacheKey?: boolean; explicitCache?: boolean; prefixFile?: string }) {
    this.prefixes = new StablePrefixes(opts.prefixFile);
    this.cacheKey = opts.cacheKey ?? true;
    this.explicitCache = opts.explicitCache ?? true;
    this.client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 0 });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const reasoning = isReasoningModel(request.model);
    const messages = toOpenAiInput(request.messages);
    const cached = this.explicitCache
      ? explicitCacheInput(request.system, this.prefixes.boundary(request.agent, request.system), messages)
      : null;
    const response = await this.client.responses.create(
      {
        model: request.model,
        ...(cached
          ? { input: cached.input, prompt_cache_options: { mode: cached.mode } }
          : { instructions: request.system, input: messages }),
        store: false,
        // Ключ кэша по агенту: запросы одного агента с общим началом промпта попадают в один кэш.
        ...(this.cacheKey ? { prompt_cache_key: request.agent } : {}),
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
        cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
        reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
      model: response.model,
      stop: truncated ? 'length' : refusal ? 'refusal' : 'done',
      providerContent: { provider: PROVIDER, blocks: response.output },
    };
  }
}
