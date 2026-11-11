/**
 * Кандидаты последствий для крупного изменения. Сколько просить — решает ядро (consequenceAsk).
 */

import type { ConsequenceDraft, WorldObject } from '../../core/city.js';
import type { MutationDraft } from '../../core/world/mutation.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { draftText } from '../_shared/mutation-text.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { consequencesSchema, type ConsequencesRaw } from './schema.js';

export interface ConsequencesInput {
  draft: MutationDraft;
  objects: WorldObject[];
  count: number;
}

const prompt = loadPrompt(import.meta.url);

export const consequencesGenerator: StructuredAgent<ConsequencesInput, ConsequencesRaw, ConsequenceDraft[]> = {
  name: 'consequences-generator',
  tool: 'submit_consequences',
  description: 'Кандидаты процессов-последствий.',
  schema: consequencesSchema,
  system: () => composeSystem(['world', 'style-event-balance'], prompt),
  user: ({ draft, objects, count }) => `${draftText(draft, objects)}\n\nНужно кандидатов: ${count}`,
  check: (raw, { count }) => (raw.items.length < count ? `нужно ${count} кандидатов, пришло ${raw.items.length}` : null),
  finish: (raw, { count }) =>
    raw.items.slice(0, count).map((i) => ({ description: i.description, impact: i.impact, drift: i.drift, stake: null })),
};

export async function generateConsequences(deps: AgentDeps, input: ConsequencesInput): Promise<ConsequenceDraft[]> {
  if (input.count <= 0) return [];
  return (await runStructured(deps, consequencesGenerator, input)).value;
}
