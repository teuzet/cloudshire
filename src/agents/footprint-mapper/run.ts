import type { Relation } from '../../core/rules.js';
import { block, briefList, join, type ObjectBrief } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { footprintSchema, type FootprintRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface FootprintInput {
  work: string;
  result: string;
  objects: ObjectBrief[];
}

export interface FootprintLink {
  objectId: string;
  relation: Relation;
  reason: string;
}

export const footprintMapper: StructuredAgent<FootprintInput, FootprintRaw, FootprintLink[]> = {
  name: 'footprint-mapper',
  tool: 'submit_footprint',
  description: 'Кого и что в городе затрагивает работа: запись, вид связи, причина.',
  schema: footprintSchema,
  system: () => composeSystem([], prompt),
  user: ({ work, result, objects }) => join(`Работа: «${work}»`, `Ожидаемый результат: ${result}`, block('В городе есть', briefList(objects))),
  check: (raw, input) => {
    const ids = new Set(input.objects.map((o) => o.id));
    const alien = raw.relations.find((r) => !ids.has(r.object_id));
    return alien ? `object_id «${alien.object_id}» нет в списке «В городе есть»; бери id только оттуда` : null;
  },
  finish: (raw) => {
    const seen = new Set<string>();
    const out: FootprintLink[] = [];
    for (const r of raw.relations) {
      const key = `${r.object_id}:${r.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ objectId: r.object_id, relation: r.relation, reason: r.reason });
    }
    return out;
  },
};

export async function mapFootprint(deps: AgentDeps, input: FootprintInput): Promise<FootprintLink[]> {
  return (await runStructured(deps, footprintMapper, input)).value;
}
