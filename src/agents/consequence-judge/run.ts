/**
 * Отсев одного кандидата-последствия.
 */

import type { ConsequenceDraft, WorldObject } from '../../core/city.js';
import type { MutationDraft } from '../../core/world/mutation.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { draftText } from '../_shared/mutation-text.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { consequenceVerdictSchema, type ConsequenceVerdictRaw } from './schema.js';

export interface ConsequenceJudgeInput {
  draft: MutationDraft;
  objects: WorldObject[];
  candidate: ConsequenceDraft;
}

const prompt = loadPrompt(import.meta.url);

export const consequenceJudge: StructuredAgent<ConsequenceJudgeInput, ConsequenceVerdictRaw, boolean> = {
  name: 'consequence-judge',
  tool: 'submit_consequence_verdict',
  description: 'Годится ли процесс как отдельное последствие.',
  schema: consequenceVerdictSchema,
  system: () => composeSystem(['world'], prompt),
  user: ({ draft, objects, candidate }) => `${draftText(draft, objects)}\n\nКандидат: ${candidate.description}`,
  finish: (raw) => raw.ok,
};

export async function judgeConsequence(deps: AgentDeps, input: ConsequenceJudgeInput): Promise<boolean> {
  return (await runStructured(deps, consequenceJudge, input)).value;
}
