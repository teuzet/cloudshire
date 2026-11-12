import type { Rules, StatGrade } from '../../core/rules.js';
import { TYPE_WORDS, block, gradesLine, join, statDefinitions, type ObjectBrief } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { contributionSchema, type ContributionRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface ContributionInput {
  rules: Rules;
  subject: Omit<ObjectBrief, 'id'>;
  /** Уровни показателей словами. */
  cityStats: string;
  /** Самые весомые объекты города и их вклад классами. */
  keyObjects: Array<{ name: string; type: ObjectBrief['type']; effects: StatGrade[] }>;
  /** Переоценка: прежний вклад и что случилось. */
  before?: { effects: StatGrade[]; event: string } | null;
}

export interface Contribution {
  effects: StatGrade[];
  reason: string;
}

export const contributionAppraiser: StructuredAgent<ContributionInput, ContributionRaw, Contribution> = {
  name: 'contribution-appraiser',
  tool: 'submit_contribution',
  description: 'Влияние одной части города на показатели: показатель, направление, размер.',
  schema: contributionSchema,
  system: ({ rules }) => composeSystem([], prompt, block('Показатели города', statDefinitions(rules))),
  user: ({ subject, cityStats, keyObjects, before }) =>
    join(
      `Предмет: «${subject.name}», ${TYPE_WORDS[subject.type]}. ${subject.description}`,
      before ? `Прежнее влияние: ${gradesLine(before.effects)}.\nСлучилось: ${before.event}` : null,
      block('Показатели города сейчас', cityStats),
      block(
        'Самые весомые части города',
        keyObjects.length ? keyObjects.map((o) => `- ${o.name} (${TYPE_WORDS[o.type]}): ${gradesLine(o.effects)}`).join('\n') : 'нет сведений',
      ),
    ),
  check: (raw) => (new Set(raw.effects.map((e) => e.stat)).size !== raw.effects.length ? 'каждый показатель встречается в effects один раз' : null),
  finish: (raw) => ({ effects: raw.effects, reason: raw.reason }),
};

export async function appraiseContribution(deps: AgentDeps, input: ContributionInput): Promise<Contribution> {
  return (await runStructured(deps, contributionAppraiser, input)).value;
}
