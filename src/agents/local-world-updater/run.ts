/**
 * Судья каскада: одна сущность против одного изменения.
 */

import type { City } from '../../core/city.js';
import { entityById, type CascadeChange, type CascadeEntity, type CascadeVerdict } from '../../core/world/cascade.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { objectLine } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { localUpdateSchema, type LocalUpdateRaw } from './schema.js';

export interface LocalUpdateInput {
  /** Город нужен только чтобы прочитать источник изменения. */
  city: Pick<City, 'objects' | 'fronts'>;
  change: CascadeChange;
  target: CascadeEntity;
}

const KIND = { created: 'появилось', modified: 'изменилось', deleted: 'исчезло', invalid: 'потеряло смысл', resolved: 'завершилось' };

function describe(entity: CascadeEntity | null): string {
  if (!entity) return '(нет)';
  return entity.kind === 'object' ? objectLine(entity.entity) : `история: ${entity.entity.description}`;
}

const prompt = loadPrompt(import.meta.url);

export const localWorldUpdater: StructuredAgent<LocalUpdateInput, LocalUpdateRaw, CascadeVerdict> = {
  name: 'local-world-updater',
  tool: 'submit_local_update',
  description: 'Что стало с сущностью после изменения.',
  schema: localUpdateSchema,
  system: () => composeSystem(['world'], prompt),
  user: ({ city, change, target }) =>
    [`Изменение: ${KIND[change.kind]} — ${describe(entityById(city, change.id))}`, `Сущность: ${describe(target)}`].join('\n\n'),
  check: (raw) => (raw.verdict === 'updated' && !raw.text?.trim() ? 'для updated нужен text' : null),
  finish: (raw) => (raw.verdict === 'updated' ? { verdict: 'updated', text: raw.text?.trim() ?? '' } : { verdict: raw.verdict }),
};

export async function judgeLocalUpdate(deps: AgentDeps, input: LocalUpdateInput): Promise<CascadeVerdict> {
  return (await runStructured(deps, localWorldUpdater, input)).value;
}
