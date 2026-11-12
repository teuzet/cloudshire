import type { ObjectType } from '../../core/rules.js';
import { block, briefList, join, typesBlock, type ObjectBrief } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { stagesSchema, type ResultKind, type StagesRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface StagesInput {
  goal: string;
  gaps: string[];
  objects: ObjectBrief[];
}

export interface PlannedStage {
  title: string;
  work: string;
  result: {
    kind: ResultKind;
    objectId: string | null;
    type: ObjectType | null;
    name: string;
    description: string;
    parentId: string | null;
  };
  site: { name: string; description: string } | null;
  outcomeKnown: boolean;
}

export const stagePlanner: StructuredAgent<StagesInput, StagesRaw, PlannedStage[]> = {
  name: 'stage-planner',
  tool: 'submit_stages',
  description: 'Цепочка этапов работы с результатом каждого.',
  schema: stagesSchema,
  system: () => composeSystem([], prompt, canon('setting'), block('Виды частей города (type)', typesBlock())),
  user: ({ goal, gaps, objects }) =>
    join(
      `Цель: «${goal}»`,
      block('Чего недостаёт', gaps.length ? gaps.map((g) => `- ${g}`).join('\n') : 'всё нужное есть'),
      block('В городе есть', briefList(objects)),
    ),
  check: (raw, input) => {
    const ids = new Set(input.objects.map((o) => o.id));
    for (const [i, s] of raw.stages.entries()) {
      const r = s.result;
      const at = `этап ${i + 1}`;
      if ((r.kind === 'change_object' || r.kind === 'remove_object') && (!r.object_id || !ids.has(r.object_id))) {
        return `${at}: для ${r.kind} нужен object_id из списка «В городе есть»`;
      }
      if (r.kind === 'new_object' && !r.type) return `${at}: для new_object нужен type`;
      if (r.parent_id && !ids.has(r.parent_id)) return `${at}: parent_id берётся из списка «В городе есть» или равен null`;
    }
    return null;
  },
  finish: (raw) =>
    raw.stages.map((s) => ({
      title: s.title,
      work: s.work,
      result: {
        kind: s.result.kind,
        objectId: s.result.kind === 'change_object' || s.result.kind === 'remove_object' ? s.result.object_id : null,
        type: s.result.kind === 'new_object' ? s.result.type : null,
        name: s.result.name,
        description: s.result.description,
        parentId: s.result.parent_id,
      },
      site: s.result.kind === 'fact' ? null : s.site,
      outcomeKnown: s.outcome_known,
    })),
};

export async function planStages(deps: AgentDeps, input: StagesInput): Promise<PlannedStage[]> {
  return (await runStructured(deps, stagePlanner, input)).value;
}
