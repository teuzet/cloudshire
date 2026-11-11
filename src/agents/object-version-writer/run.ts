/**
 * Писатель версии объекта для ставки modify.
 */

import type { Rules } from '../../core/rules.js';
import type { WorldObject } from '../../core/city.js';
import type { VersionDraft } from '../../core/world/stake.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, objectLine, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { objectVersionSchema, type ObjectVersionRaw } from './schema.js';

export interface ObjectVersionInput {
  rules: Rules;
  object: WorldObject;
  /** Что случилось с объектом: описание фронта и намерение ставки. */
  change: string;
}

const prompt = loadPrompt(import.meta.url);

export const objectVersionWriter: StructuredAgent<ObjectVersionInput, ObjectVersionRaw, VersionDraft> = {
  name: 'object-version-writer',
  tool: 'submit_object_version',
  description: 'Новая версия объекта.',
  schema: objectVersionSchema,
  system: ({ object, rules }) =>
    composeSystem(
      ['world'],
      prompt,
      `Объект сейчас: ${objectLine(object)}`,
      section('Прежние версии', bullets(object.versions.slice(0, -1).map((v) => v.description))),
      section('Описание объекта не длиннее', `${rules.fronts.objects.descriptionMax} знаков`),
    ),
  user: ({ change }) => `Что изменилось: ${change}`,
  check: (raw, { rules }) =>
    raw.description.length > rules.fronts.objects.descriptionMax
      ? `описание длиннее ${rules.fronts.objects.descriptionMax} знаков`
      : null,
  finish: (raw) => ({ description: raw.description, weight: raw.weight, statProfile: raw.stat_profile }),
};

export async function writeObjectVersion(deps: AgentDeps, input: ObjectVersionInput): Promise<VersionDraft> {
  return (await runStructured(deps, objectVersionWriter, input)).value;
}
