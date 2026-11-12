import type { FaithCase, FaithStrength } from '../../core/rules.js';
import { block, join } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { faithSchema, type FaithRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface FaithInput {
  event: string;
  /** По чьей воле шло дело: «Дело велел бог и торопил его». */
  will: string;
  /** Похожие события последнего времени: чтобы повторы весили меньше. */
  recent: string[];
}

export interface FaithRuling {
  case: FaithCase;
  strength: FaithStrength;
}

export const faithAppraiser: StructuredAgent<FaithInput, FaithRaw, FaithRuling> = {
  name: 'faith-appraiser',
  tool: 'submit_faith',
  description: 'Как событие отзывается на вере: случай и сила.',
  schema: faithSchema,
  system: () => composeSystem([], prompt),
  user: ({ event, will, recent }) =>
    join(`Событие: «${event}»`, will, block('Похожие события последнего времени', recent.length ? recent.map((r) => `- ${r}`).join('\n') : 'не было')),
  finish: (raw) => ({ case: raw.case, strength: raw.strength }),
};

export async function appraiseFaith(deps: AgentDeps, input: FaithInput): Promise<FaithRuling> {
  return (await runStructured(deps, faithAppraiser, input)).value;
}
