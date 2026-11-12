import type { Relation } from '../../core/rules.js';
import { block, join } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { dynamicSchema, type DynamicRaw, FREE_SHAPES } from './schema.js';

const prompt = loadPrompt(import.meta.url);

const TOUCH: Record<Relation, string> = {
  occupies: 'занято работой',
  linked: 'связано с результатом',
  pressures: 'работа давит',
  benefits: 'результат выгоден',
};

export interface DynamicInput {
  work: string;
  /** Пройденная доля пути, 0..1. */
  share: number;
  touches: Array<{ id: string; name: string; relation: Relation; reason: string }>;
  /** Осложнения, которые уже идут вокруг этой работы: новое должно быть о другом. */
  running?: string[];
}

export interface FreeDynamic {
  shape: (typeof FREE_SHAPES)[number];
  /** По чему бьёт: по самому делу или по объекту. */
  target: 'deed' | 'object';
  objectId: string | null;
  skeleton: string;
  helps: string;
}

function shareWords(share: number): string {
  if (share >= 1) return 'работа завершена';
  if (share >= 0.66) return 'пройдено больше половины';
  if (share >= 0.33) return 'пройдена примерно треть';
  return 'работа в начале';
}

export const dynamicsComposer: StructuredAgent<DynamicInput, DynamicRaw, FreeDynamic> = {
  name: 'dynamics-composer',
  tool: 'submit_dynamic',
  description: 'Одно осложнение работы в общих чертах.',
  schema: dynamicSchema,
  system: () => composeSystem([], prompt, canon('setting')),
  user: ({ work, share, touches, running }) =>
    join(
      `Работа: «${work}»`,
      `Пройдено: ${shareWords(share)}`,
      block('Затрагивает', touches.length ? touches.map((t) => `- ${t.id} — ${t.name}: ${TOUCH[t.relation]}; ${t.reason}`).join('\n') : 'никого явно'),
      running?.length ? block('Уже идут', running.map((r) => `- ${r}`).join('\n')) : '',
    ),
  check: (raw, input) => {
    const ids = new Set(input.touches.map((t) => t.id));
    if (raw.object_id && !ids.has(raw.object_id)) return 'object_id берётся из списка затронутых или равен null';
    if (raw.target === 'object' && !raw.object_id) return 'для target object нужен object_id из списка затронутых';
    return null;
  },
  finish: (raw) => ({ shape: raw.shape, target: raw.target, objectId: raw.object_id, skeleton: raw.skeleton, helps: raw.helps }),
};

export async function composeDynamic(deps: AgentDeps, input: DynamicInput): Promise<FreeDynamic> {
  return (await runStructured(deps, dynamicsComposer, input)).value;
}
