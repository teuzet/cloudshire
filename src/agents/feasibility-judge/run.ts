/**
 * Можно ли вообще начинать изменение.
 */

import type { WorldObject } from '../../core/city.js';
import type { MutationDraft } from '../../core/world/mutation.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { objectsBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { feasibilitySchema, type FeasibilityRaw } from './schema.js';
import { draftText } from '../_shared/mutation-text.js';

export type Feasibility =
  | { verdict: 'FEASIBLE' }
  | { verdict: 'LOCKED'; missing: string }
  | { verdict: 'IMPOSSIBLE'; reason: string };

export interface FeasibilityInput {
  draft: MutationDraft;
  objects: WorldObject[];
}

const prompt = loadPrompt(import.meta.url);

export const feasibilityJudge: StructuredAgent<FeasibilityInput, FeasibilityRaw, Feasibility> = {
  name: 'feasibility-judge',
  tool: 'submit_feasibility',
  description: 'Можно ли начать изменение.',
  schema: feasibilitySchema,
  system: ({ objects }) => composeSystem(['world'], prompt, section('Объекты города', objectsBlock(objects))),
  user: ({ draft, objects }) => draftText(draft, objects),
  check: (raw) => {
    if (raw.verdict === 'LOCKED' && !raw.missing?.trim()) return 'для LOCKED нужен missing';
    if (raw.verdict === 'IMPOSSIBLE' && !raw.reason?.trim()) return 'для IMPOSSIBLE нужен reason';
    return null;
  },
  finish: (raw) =>
    raw.verdict === 'LOCKED'
      ? { verdict: 'LOCKED', missing: raw.missing?.trim() ?? '' }
      : raw.verdict === 'IMPOSSIBLE'
        ? { verdict: 'IMPOSSIBLE', reason: raw.reason?.trim() ?? '' }
        : { verdict: 'FEASIBLE' },
};

export async function judgeFeasibility(deps: AgentDeps, input: FeasibilityInput): Promise<Feasibility> {
  return (await runStructured(deps, feasibilityJudge, input)).value;
}
