import { bullets, section } from '../_shared/format.js';
import { join } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { conditionSchema, type ConditionRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface ConditionInput {
  /** Условие словами покровителя: «если бунтовщики пойдут на склады». */
  condition: string;
  /** Свежие события, которые касаются того, о чём условие: записи хроники. */
  events: string[];
}

export interface ConditionRuling {
  met: boolean;
  reason: string;
}

export const conditionJudge: StructuredAgent<ConditionInput, ConditionRaw, ConditionRuling> = {
  name: 'condition-judge',
  tool: 'submit_condition',
  description: 'Сбылось ли условие поручения: да или нет.',
  schema: conditionSchema,
  system: () => composeSystem([], prompt),
  user: ({ condition, events }) => join(`Условие: «${condition}»`, section('Что случилось', bullets(events))),
  finish: (raw) => ({ met: raw.met, reason: raw.reason }),
};

export async function judgeCondition(deps: AgentDeps, input: ConditionInput): Promise<ConditionRuling> {
  return (await runStructured(deps, conditionJudge, input)).value;
}
