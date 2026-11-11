import type { WorldObject } from '../../core/city.js';
import type { MutationDraft } from '../../core/world/mutation.js';
import { objectLine } from './format.js';

/** Черновик изменения словами — одинаково для всех судей цепочки воли. */
export function draftText(draft: MutationDraft, objects: WorldObject[]): string {
  if (draft.kind === 'create') return `Появится [${draft.type}] ${draft.name}: ${draft.description}`;
  const target = objects.find((o) => o.id === draft.target);
  const was = target ? objectLine(target) : draft.target;
  return draft.kind === 'modify' ? `Изменится: ${was}\nСтанет: ${draft.description}` : `Исчезнет: ${was}\nКак: ${draft.description}`;
}
