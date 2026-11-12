import { join } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { fitSchema, type FitRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface FitInput {
  /** Условие в форме вопроса с ответом «да» или «нет». */
  question: string;
  /** Кандидат: «Артель каменщиков: сорок мастеров…» */
  subject: string;
  /** Обстоятельства: дело, его темп, чем оно касается кандидата. */
  context: string;
}

export interface FitRuling {
  fits: boolean;
  reason: string;
}

export const roleFitter: StructuredAgent<FitInput, FitRaw, FitRuling> = {
  name: 'role-fitter',
  tool: 'submit_fit',
  description: 'Ответ «да» или «нет» на один вопрос об одном предмете.',
  schema: fitSchema,
  system: () => composeSystem([], prompt),
  user: ({ question, subject, context }) => join(`Вопрос: «${question}»`, `Предмет: «${subject}»`, `Обстоятельства: «${context}»`),
  finish: (raw) => ({ fits: raw.fits, reason: raw.reason }),
};

export async function fitRole(deps: AgentDeps, input: FitInput): Promise<FitRuling> {
  return (await runStructured(deps, roleFitter, input)).value;
}
