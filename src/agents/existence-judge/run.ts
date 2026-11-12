/**
 * Привратник канона: есть ли в городе то, что назвал покровитель.
 * Отвечает одним из четырёх: уже есть, можно дописать подробностью, неизвестно (только поиском), нет.
 */

import type { LoreFact, WorldObject } from '../../core/city.js';
import { block, join } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { existenceSchema, type ExistenceRaw, type ExistenceVerdict } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface ExistenceInput {
  /** Предмет, как его назвали: «катакомбы под рынком». */
  thing: string;
  /** Слова, в которых он прозвучал. */
  context: string;
  objects: Array<Pick<WorldObject, 'id' | 'name' | 'description'>>;
  facts: Array<Pick<LoreFact, 'text'>>;
}

export interface ExistenceRuling {
  verdict: ExistenceVerdict;
  objectId: string | null;
  reason: string;
}

export const existenceJudge: StructuredAgent<ExistenceInput, ExistenceRaw, ExistenceRuling> = {
  name: 'existence-judge',
  tool: 'submit_existence',
  description: 'Есть ли этот предмет в городе.',
  schema: existenceSchema,
  system: () => composeSystem([], prompt, canon('setting')),
  user: ({ thing, context, objects, facts }) =>
    join(
      `Предмет: «${thing}»`,
      `Слова: «${context}»`,
      block('Части города', objects.length ? objects.map((o) => `- ${o.id} — ${o.name}: ${o.description}`).join('\n') : 'нет'),
      block('Известные факты', facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : 'нет'),
    ),
  check: (raw, { objects }) => {
    if (raw.verdict === 'exists' && raw.object_id && !objects.some((o) => o.id === raw.object_id)) return `object_id ${raw.object_id} нет среди частей города`;
    return null;
  },
  finish: (raw) => ({ verdict: raw.verdict, objectId: raw.verdict === 'exists' ? raw.object_id : null, reason: raw.reason }),
};

export async function judgeExistence(deps: AgentDeps, input: ExistenceInput): Promise<ExistenceRuling> {
  return (await runStructured(deps, existenceJudge, input)).value;
}
