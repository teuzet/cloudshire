/**
 * Черновик изменения мира из свободной воли покровителя.
 */

import type { Rules } from '../../core/rules.js';
import type { WorldObject } from '../../core/city.js';
import type { MutationDraft } from '../../core/world/mutation.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { objectsBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { mutationSchema, type MutationRaw } from './schema.js';

export interface MutationInput {
  rules: Rules;
  intent: string;
  objects: WorldObject[];
}

const prompt = loadPrompt(import.meta.url);

export const mutationDrafter: StructuredAgent<MutationInput, MutationRaw, MutationDraft> = {
  name: 'mutation-drafter',
  tool: 'submit_mutation',
  description: 'Одно изменение мира.',
  schema: mutationSchema,
  system: ({ objects }) => composeSystem(['world'], prompt, section('Объекты города', objectsBlock(objects))),
  user: ({ intent }) => `Воля покровителя: ${intent}`,
  check: (raw, { rules, objects }) => {
    if (raw.description.length > rules.fronts.objects.descriptionMax) return `description длиннее ${rules.fronts.objects.descriptionMax}`;
    if (raw.kind === 'create') {
      if (!raw.type) return 'для create нужен type';
      if (!raw.name?.trim()) return 'для create нужен name';
      if (raw.name.length > rules.fronts.objects.nameMax) return `name длиннее ${rules.fronts.objects.nameMax}`;
      return null;
    }
    const target = objects.find((o) => o.id === raw.target && o.status === 'active');
    if (!target) return `нет объекта ${raw.target ?? '(пусто)'}`;
    if (raw.kind === 'delete' && target.protected) return `объект ${target.id} нельзя удалить`;
    return null;
  },
  finish: (raw) =>
    raw.kind === 'create'
      ? { kind: 'create', type: raw.type ?? 'structure', name: raw.name?.trim() ?? '', description: raw.description }
      : { kind: raw.kind, target: raw.target ?? '', description: raw.description },
};

export async function draftMutation(deps: AgentDeps, input: MutationInput): Promise<MutationDraft> {
  return (await runStructured(deps, mutationDrafter, input)).value;
}
