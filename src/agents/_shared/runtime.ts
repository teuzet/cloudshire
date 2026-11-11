/**
 * Общий рантайм агентов: настройки модели, структурный ответ через один тул
 * и цикл тулов для агентов, которые действуют (жрец).
 *
 * Агент не знает провайдера: он получает порт Llm и имя модели из настроек.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Llm, LlmMessage, LlmRequest, LlmResponse, LlmTool, LlmUsage, ToolCall } from '../../ports/llm.js';

export interface AgentSettings {
  model: string;
  maxOutputTokens?: number;
  effort?: LlmRequest['effort'];
}

export interface AgentEvent {
  agent: string;
  attempt: number;
  request: LlmRequest;
  response: LlmResponse | null;
  error: string | null;
}

export interface AgentDeps {
  llm: Llm;
  /** Настройки модели по имени агента (config/agents.yaml). */
  settings: (agent: string) => AgentSettings;
  /** Наблюдатель: логи, учёт токенов, кассеты. */
  onCall?: (event: AgentEvent) => void;
}

export class AgentError extends Error {
  constructor(
    readonly agent: string,
    message: string,
  ) {
    super(`${agent}: ${message}`);
    this.name = 'AgentError';
  }
}

export function toolFromSchema(name: string, description: string, schema: z.ZodTypeAny): LlmTool {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
  delete json.$schema;
  return { name, description, parameters: json };
}

function zodIssue(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
    .join('; ');
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

export const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

async function call(deps: AgentDeps, request: LlmRequest, attempt: number): Promise<LlmResponse> {
  try {
    const response = await deps.llm.complete(request);
    deps.onCall?.({ agent: request.agent, attempt, request, response, error: null });
    return response;
  } catch (err) {
    deps.onCall?.({ agent: request.agent, attempt, request, response: null, error: String(err) });
    throw err;
  }
}

function assistantTurn(response: LlmResponse): LlmMessage {
  return {
    role: 'assistant',
    content: response.text,
    toolCalls: response.toolCalls,
    ...(response.providerContent ? { providerContent: response.providerContent } : {}),
  };
}

// ───────────────────────────── структурный ответ ─────────────────────────────

/**
 * Агент, чей ответ — один вызов тула с аргументами по схеме.
 * schema проверяет форму, check — смысл (чужие id, пустые поля), finish — переводит в тип ядра.
 */
export interface StructuredAgent<I, R, O> {
  name: string;
  tool: string;
  description: string;
  schema: z.ZodType<R, z.ZodTypeDef, unknown>;
  system: (input: I) => string;
  user: (input: I) => string;
  check?: (raw: R, input: I) => string | null;
  finish: (raw: R, input: I) => O;
}

export interface StructuredResult<O> {
  value: O;
  attempts: number;
  usage: LlmUsage;
}

/**
 * Позвать модель и получить проверенный ответ. Ошибку формы или смысла
 * модель видит как результат тула и пробует снова; после `attempts` — AgentError.
 */
export async function runStructured<I, R, O>(
  deps: AgentDeps,
  agent: StructuredAgent<I, R, O>,
  input: I,
  opts: { attempts?: number; signal?: AbortSignal } = {},
): Promise<StructuredResult<O>> {
  const maxAttempts = opts.attempts ?? 3;
  const settings = deps.settings(agent.name);
  const tool = toolFromSchema(agent.tool, agent.description, agent.schema);
  const system = agent.system(input);
  const messages: LlmMessage[] = [{ role: 'user', content: agent.user(input) }];
  let usage = NO_USAGE;
  let lastError = 'нет ответа';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await call(
      deps,
      {
        agent: agent.name,
        model: settings.model,
        system,
        messages: [...messages],
        tools: [tool],
        toolChoice: { name: agent.tool },
        ...(settings.maxOutputTokens ? { maxOutputTokens: settings.maxOutputTokens } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      attempt,
    );
    usage = addUsage(usage, response.usage);
    if (response.stop !== 'done') {
      lastError = response.stop === 'length' ? 'ответ оборван лимитом' : 'модель отказалась';
      if (response.stop === 'refusal') break;
      continue;
    }

    const toolCall = response.toolCalls.find((c) => c.name === agent.tool);
    if (!toolCall) {
      lastError = 'не вызван тул';
      messages.push(assistantTurn(response));
      for (const other of response.toolCalls) {
        messages.push({ role: 'tool', toolCallId: other.id, content: `Нет такого тула. Вызови ${agent.tool}.` });
      }
      messages.push({ role: 'user', content: `Ответ принимается только через ${agent.tool}. Вызови его сейчас.` });
      continue;
    }

    const problem = parseAndCheck(agent, toolCall, input);
    if (problem.ok) return { value: agent.finish(problem.raw, input), attempts: attempt, usage };
    lastError = problem.error;
    messages.push(assistantTurn(response));
    for (const c of response.toolCalls) {
      messages.push({
        role: 'tool',
        toolCallId: c.id,
        content: c.id === toolCall.id ? `Ошибка: ${problem.error}. Исправь и вызови ${agent.tool} снова.` : 'Пропущено.',
      });
    }
  }
  throw new AgentError(agent.name, lastError);
}

function parseAndCheck<I, R, O>(
  agent: StructuredAgent<I, R, O>,
  toolCall: ToolCall,
  input: I,
): { ok: true; raw: R } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(toolCall.arguments || '{}');
  } catch {
    return { ok: false, error: 'аргументы не JSON' };
  }
  const parsed = agent.schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: zodIssue(parsed.error) };
  const semantic = agent.check?.(parsed.data, input) ?? null;
  if (semantic) return { ok: false, error: semantic };
  return { ok: true, raw: parsed.data };
}

// ───────────────────────────── цикл тулов ─────────────────────────────

export interface LoopTool<C> {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** Выполнить. Ответ уходит модели как результат тула. Ошибка смысла — строка в result, не исключение. */
  run: (args: never, ctx: C) => Promise<unknown> | unknown;
}

export interface ToolLoopResult<F> {
  final: F;
  calls: Array<{ name: string; args: unknown; result: unknown }>;
  steps: number;
  usage: LlmUsage;
}

/**
 * Модель зовёт тулы, пока не вызовет итоговый. Итоговый тул проверяется схемой,
 * остальные выполняются по очереди в том порядке, в каком их вызвала модель.
 */
export async function runToolLoop<C, F>(
  deps: AgentDeps,
  args: {
    agent: string;
    system: string;
    messages: LlmMessage[];
    tools: LoopTool<C>[];
    final: { name: string; description: string; schema: z.ZodType<F, z.ZodTypeDef, unknown> };
    ctx: C;
    maxSteps?: number;
    signal?: AbortSignal;
  },
): Promise<ToolLoopResult<F>> {
  const settings = deps.settings(args.agent);
  const maxSteps = args.maxSteps ?? 6;
  const byName = new Map(args.tools.map((t) => [t.name, t]));
  const llmTools = [
    ...args.tools.map((t) => toolFromSchema(t.name, t.description, t.schema)),
    toolFromSchema(args.final.name, args.final.description, args.final.schema),
  ];
  const messages = [...args.messages];
  const calls: ToolLoopResult<F>['calls'] = [];
  let usage = NO_USAGE;

  for (let step = 1; step <= maxSteps; step++) {
    const lastStep = step === maxSteps;
    const response = await call(
      deps,
      {
        agent: args.agent,
        model: settings.model,
        system: args.system,
        messages: [...messages],
        tools: llmTools,
        toolChoice: lastStep ? { name: args.final.name } : 'required',
        ...(settings.maxOutputTokens ? { maxOutputTokens: settings.maxOutputTokens } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      },
      step,
    );
    usage = addUsage(usage, response.usage);
    if (response.stop === 'refusal') throw new AgentError(args.agent, 'модель отказалась');
    messages.push(assistantTurn(response));

    if (!response.toolCalls.length) {
      const draft = response.text.trim();
      messages.push({
        role: 'user',
        content: draft
          ? `Игрок этот текст не увидит. Вызови ${args.final.name} и передай в нём ту же речь.`
          : `Ход не сдан. Вызови ${args.final.name}.`,
      });
      continue;
    }

    let final: F | null = null;
    for (const tc of response.toolCalls) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(tc.arguments || '{}');
      } catch {
        messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify({ error: 'аргументы не JSON' }) });
        continue;
      }
      if (tc.name === args.final.name) {
        const parsed = args.final.schema.safeParse(parsedArgs);
        if (parsed.success) {
          final = parsed.data;
          messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify({ ok: true }) });
        } else {
          messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify({ error: zodIssue(parsed.error) }) });
        }
        continue;
      }
      const tool = byName.get(tc.name);
      if (!tool) {
        messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify({ error: `нет тула ${tc.name}` }) });
        continue;
      }
      const parsed = tool.schema.safeParse(parsedArgs);
      if (!parsed.success) {
        messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify({ error: zodIssue(parsed.error) }) });
        continue;
      }
      const result = await tool.run(parsed.data as never, args.ctx);
      calls.push({ name: tc.name, args: parsed.data, result });
      messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify(result) });
    }
    if (final != null) return { final, calls, steps: step, usage };
  }
  throw new AgentError(args.agent, `итоговый тул не вызван за ${maxSteps} шагов`);
}
