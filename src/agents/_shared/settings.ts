/**
 * Разбор config/agents.yaml. Файл читает клиент; сюда приходит уже объект.
 */

import { z } from 'zod';
import type { AgentSettings } from './runtime.js';

const entry = z.object({
  model: z.string().min(3).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});

const fileSchema = z.object({
  default: entry.extend({ model: z.string().min(3) }),
  agents: z.record(z.string(), entry).default({}),
});

export function parseAgentSettings(raw: unknown): (agent: string) => AgentSettings {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`настройки агентов: ${issue ? issue.path.join('.') : '?'}: ${issue?.message ?? 'неверно'}`);
  }
  const { default: base, agents } = parsed.data;
  return (agent) => {
    const own = agents[agent] ?? {};
    return {
      model: own.model ?? base.model,
      ...((own.maxOutputTokens ?? base.maxOutputTokens) ? { maxOutputTokens: own.maxOutputTokens ?? base.maxOutputTokens } : {}),
      ...((own.effort ?? base.effort) ? { effort: own.effort ?? base.effort } : {}),
    };
  };
}

/** Для тестов: одна модель на всех. */
export function fixedSettings(model = 'fake:model'): (agent: string) => AgentSettings {
  return () => ({ model });
}
