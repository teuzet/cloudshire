/**
 * Масштаб изменения: уровень и относительный профиль по статам.
 * Effort, бюджет последствий и вклад в статы из этого считает ядро.
 */

import type { WorldObject } from '../../core/city.js';
import type { MutationAssessment, MutationDraft } from '../../core/world/mutation.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { draftText } from '../_shared/mutation-text.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { isZeroProfile } from '../_shared/schemas.js';
import { impactSchema, type ImpactRaw } from './schema.js';

export interface ImpactInput {
  draft: MutationDraft;
  objects: WorldObject[];
}

const prompt = loadPrompt(import.meta.url);

export const impactJudge: StructuredAgent<ImpactInput, ImpactRaw, MutationAssessment> = {
  name: 'impact-judge',
  tool: 'submit_impact',
  description: 'Масштаб изменения.',
  schema: impactSchema,
  system: () => composeSystem(['world'], prompt),
  user: ({ draft, objects }) => draftText(draft, objects),
  check: (raw) => (raw.impact !== 'NONE' && isZeroProfile(raw.stat_profile) ? 'нулевой профиль при ненулевом impact' : null),
  finish: (raw) => ({ impact: raw.impact, statProfile: raw.stat_profile }),
};

export async function judgeImpact(deps: AgentDeps, input: ImpactInput): Promise<MutationAssessment> {
  return (await runStructured(deps, impactJudge, input)).value;
}
