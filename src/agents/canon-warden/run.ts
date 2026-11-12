import { block, briefList, join, type ObjectBrief } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { canonSchema, type CanonRaw, type CanonVerdict } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface CanonInput {
  goal: string;
  facts: string[];
  objects: ObjectBrief[];
}

export interface CanonRuling {
  verdict: CanonVerdict;
  reason: string;
  /** Цель, с которой дело идёт дальше: исходная или поправленная. */
  goal: string;
  gaps: string[];
}

export const canonWarden: StructuredAgent<CanonInput, CanonRaw, CanonRuling> = {
  name: 'canon-warden',
  tool: 'submit_canon_verdict',
  description: 'Достижима ли цель в этом мире и чего для неё недостаёт.',
  schema: canonSchema,
  system: () => composeSystem([], prompt, canon('setting')),
  user: ({ goal, facts, objects }) =>
    join(
      `Цель: «${goal}»`,
      block('Факты о городе', facts.length ? facts.map((f) => `- ${f}`).join('\n') : 'особых фактов нет'),
      block('В городе есть', briefList(objects)),
    ),
  check: (raw) => (raw.verdict === 'amended' && !raw.amended_goal?.trim() ? 'для amended нужна цель с поправкой в amended_goal' : null),
  finish: (raw, input) => ({
    verdict: raw.verdict,
    reason: raw.reason,
    goal: raw.verdict === 'amended' && raw.amended_goal ? raw.amended_goal.trim() : input.goal,
    gaps: raw.verdict === 'unattainable' ? [] : raw.gaps,
  }),
};

export async function judgeCanon(deps: AgentDeps, input: CanonInput): Promise<CanonRuling> {
  return (await runStructured(deps, canonWarden, input)).value;
}
