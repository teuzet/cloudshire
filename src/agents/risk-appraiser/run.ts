import type { Relation, RiskStep } from '../../core/rules.js';
import { block, join } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { riskSchema, type RiskRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface RiskInput {
  work: string;
  touches: Array<{ name: string; relation: Relation; reason: string }>;
}

export interface RiskRuling {
  step: RiskStep;
  reason: string;
}

/** Отношение из отпечатка словами: так его читает и Оценщик риска, и Сочинитель динамики. */
export const RELATION_WORDS: Record<Relation, string> = {
  occupies: 'занято работой',
  linked: 'связано с результатом',
  pressures: 'работа давит',
  benefits: 'результат выгоден',
};

export const riskAppraiser: StructuredAgent<RiskInput, RiskRaw, RiskRuling> = {
  name: 'risk-appraiser',
  tool: 'submit_risk',
  description: 'Ступень риска работы и причина.',
  schema: riskSchema,
  system: () => composeSystem([], prompt, canon('setting')),
  user: ({ work, touches }) =>
    join(
      `Работа: «${work}»`,
      block('Затрагивает', touches.length ? touches.map((t) => `- ${t.name} — ${RELATION_WORDS[t.relation]}: ${t.reason}`).join('\n') : 'никого явно'),
    ),
  finish: (raw) => ({ step: raw.step, reason: raw.reason }),
};

export async function appraiseRisk(deps: AgentDeps, input: RiskInput): Promise<RiskRuling> {
  return (await runStructured(deps, riskAppraiser, input)).value;
}
