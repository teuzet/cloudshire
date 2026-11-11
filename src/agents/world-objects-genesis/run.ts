/**
 * Объекты мира из описания города. Статы города потом собирает ядро (genesisStats).
 */

import type { Impact, ObjectType, Rules, StatMap } from '../../core/rules.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { isZeroProfile } from '../_shared/schemas.js';
import { worldObjectsSchema, type WorldObjectsRaw } from './schema.js';

export interface GenesisObjectDraft {
  type: ObjectType;
  name: string;
  description: string;
  weight: Impact;
  statProfile: StatMap;
}

export interface WorldObjectsInput {
  rules: Rules;
  cityName: string;
  description: string;
}

const prompt = loadPrompt(import.meta.url);

export const worldObjectsGenesis: StructuredAgent<WorldObjectsInput, WorldObjectsRaw, GenesisObjectDraft[]> = {
  name: 'world-objects-genesis',
  tool: 'submit_world_objects',
  description: 'Значимые объекты города.',
  schema: worldObjectsSchema,
  system: ({ rules }) => {
    const g = rules.fronts.genesisObjects;
    const o = rules.fronts.objects;
    return composeSystem(['world'], prompt, `Объектов от ${g.minCount} до ${g.maxCount}. Имя до ${o.nameMax} знаков, описание до ${o.descriptionMax}.`);
  },
  user: ({ cityName, description }) => `Город ${cityName}.\n\n${description}`,
  check: (raw, { rules }) => {
    const g = rules.fronts.genesisObjects;
    const o = rules.fronts.objects;
    if (raw.objects.length < g.minCount || raw.objects.length > g.maxCount) {
      return `объектов ${raw.objects.length}, нужно от ${g.minCount} до ${g.maxCount}`;
    }
    const bad = raw.objects.findIndex((x) => isZeroProfile(x.stat_profile) || x.name.length > o.nameMax || x.description.length > o.descriptionMax);
    return bad >= 0 ? `объект ${bad} «${raw.objects[bad]?.name}»: нулевой профиль или слишком длинный текст` : null;
  },
  finish: (raw) =>
    raw.objects.map((x) => ({ type: x.type, name: x.name, description: x.description, weight: x.weight, statProfile: x.stat_profile })),
};

export async function extractWorldObjects(deps: AgentDeps, input: WorldObjectsInput): Promise<GenesisObjectDraft[]> {
  return (await runStructured(deps, worldObjectsGenesis, input)).value;
}
