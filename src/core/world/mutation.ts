/**
 * Свободная воля игрока становится фронтом. Что именно меняется, решают агенты;
 * сколько это стоит и сколько побочных фронтов разрешено — код.
 */

import type { Impact, ObjectType, Rules, StatMap } from '../rules.js';
import type { City, ConsequenceDraft, Front, Stake } from '../city.js';
import { createFront } from './fronts.js';
import { consequenceBudget, impactEffort } from './scales.js';
import { objectContribution } from './stats.js';

export type MutationDraft =
  | { kind: 'create'; type: ObjectType; name: string; description: string }
  | { kind: 'modify'; target: string; description: string }
  | { kind: 'delete'; target: string; description: string };

export interface MutationAssessment {
  impact: Impact;
  statProfile: Partial<StatMap>;
}

/** Сколько кандидатов-последствий просить у генератора: бюджет плюс запас на отсев. */
export function consequenceAsk(rules: Rules, impact: Impact): { budget: number; ask: number } {
  const budget = consequenceBudget(rules, impact);
  return { budget, ask: budget > 0 ? budget + rules.fronts.consequences.overdraft : 0 };
}

function stakeOf(rules: Rules, draft: MutationDraft, assessment: MutationAssessment): Stake {
  const weight = assessment.impact === 'NONE' ? 'MINOR' : assessment.impact;
  const effect = objectContribution(rules, weight, assessment.statProfile);
  if (draft.kind === 'delete') return { delete: { target: draft.target } };
  if (draft.kind === 'modify') {
    return { modify: { target: draft.target, proposed: { description: draft.description, statEffect: effect } } };
  }
  return { create: { type: draft.type, name: draft.name, description: draft.description, statEffect: effect } };
}

/**
 * Фронт игрока. Дрейфа нет: сам по себе проект не движется.
 * Порогов столько, сколько принято последствий: каждое открывается на своём пороге.
 */
export function buildMutationFront(
  rules: Rules,
  args: {
    id: string;
    intent: string;
    draft: MutationDraft;
    assessment: MutationAssessment;
    consequences: ConsequenceDraft[];
    alignment: string;
    day: number;
  },
): Front {
  return createFront(rules, {
    id: args.id,
    description: args.draft.description || args.intent,
    stake: stakeOf(rules, args.draft, args.assessment),
    effort: impactEffort(rules, args.assessment.impact),
    driftBand: 'NONE',
    beatCount: args.consequences.length,
    alignment: args.alignment,
    refs: args.draft.kind === 'create' ? [] : [args.draft.target],
    pendingConsequences: args.consequences,
    day: args.day,
  });
}

/** На пороге родителя открыть следующее последствие отдельным фронтом. */
export function releaseNextConsequence(rules: Rules, city: City, parent: Front, args: { id: string; day: number }): Front | null {
  const next = parent.pendingConsequences.shift();
  if (!next) return null;
  const side = createFront(rules, {
    id: args.id,
    description: next.description,
    stake: next.stake,
    effort: impactEffort(rules, next.impact),
    driftBand: next.drift,
    beatCount: 0,
    refs: [parent.id],
    day: args.day,
  });
  city.fronts.push(side);
  return side;
}
