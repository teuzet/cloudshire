import { join } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { descriptionSchema, type DescriptionRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface RewriteInput {
  name: string;
  description: string;
  /** Что изменилось: событие или намерение ставки. */
  change: string;
}

export const descriptionRewriter: StructuredAgent<RewriteInput, DescriptionRaw, string> = {
  name: 'description-rewriter',
  tool: 'submit_description',
  description: 'Обновлённое краткое описание.',
  schema: descriptionSchema,
  system: () => composeSystem([], prompt),
  user: ({ name, description, change }) => join(`Название: «${name}»`, `Прежнее описание: ${description || 'описания не было'}`, `Что изменилось: ${change}`),
  finish: (raw) => raw.description,
};

export async function rewriteDescription(deps: AgentDeps, input: RewriteInput): Promise<string> {
  return (await runStructured(deps, descriptionRewriter, input)).value;
}
