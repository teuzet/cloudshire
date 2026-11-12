import { tempoOf, type Tempo } from '../../core/rules.js';
import { block, join } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { willSchema, type DeedKind, type WillLabel, type WillRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface WillInput {
  /** Приказ словами жреца. */
  order: string;
  /** «казначей Ада». */
  officer: string;
  fronts: Array<{ id: string; title: string; description: string; lead: string | null; hindrances: Array<{ name: string; description: string }> }>;
  projects: Array<{ id: string; title: string; next: string }>;
}

export interface Will {
  label: WillLabel;
  frontId: string | null;
  projectId: string | null;
  deedKind: DeedKind | null;
  goal: string;
  manner: string | null;
  projectTempo: Tempo | null;
  workTempo: Tempo | null;
}

const NEEDS_FRONT: readonly WillLabel[] = ['strategy', 'deed', 'tempo', 'cancel'];

function frontLine(f: WillInput['fronts'][number]): string {
  return [
    `- ${f.id} «${f.title}»: ${f.description}`,
    f.lead ? `Ведёт: ${f.lead}.` : 'Ведущего нет.',
    f.hindrances.length ? `Помехи на нём: ${f.hindrances.map((h) => `«${h.name}» — ${h.description}`).join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export const willInterpreter: StructuredAgent<WillInput, WillRaw, Will> = {
  name: 'will-interpreter',
  tool: 'submit_will',
  description: 'Вид приказа и его поля.',
  schema: willSchema,
  system: () => composeSystem([], prompt),
  user: ({ order, officer, fronts, projects }) =>
    join(
      `Приказ: «${order}»`,
      `Сановник: ${officer}`,
      block('Идущие дела', fronts.length ? fronts.map(frontLine).join('\n') : 'идущих дел нет'),
      block('Ждущие замыслы', projects.length ? projects.map((p) => `- ${p.id} «${p.title}», следующий шаг: «${p.next}»`).join('\n') : 'ждущих замыслов нет'),
    ),
  check: (raw, input) => {
    if (NEEDS_FRONT.includes(raw.label)) {
      if (!raw.front_id || !input.fronts.some((f) => f.id === raw.front_id)) {
        return `для ${raw.label} нужен front_id из списка идущих дел; если подходящего дела в списке нет, это project`;
      }
    }
    if (raw.label === 'continue' && (!raw.project_id || !input.projects.some((p) => p.id === raw.project_id))) {
      return 'для continue нужен project_id из списка ждущих замыслов; если подходящего замысла нет, это project';
    }
    if (raw.label === 'deed' && !raw.deed_kind) return 'для deed нужен deed_kind: push, helper или clear';
    return null;
  },
  finish: (raw) => ({
    label: raw.label,
    frontId: NEEDS_FRONT.includes(raw.label) ? raw.front_id : null,
    projectId: raw.label === 'continue' ? raw.project_id : null,
    deedKind: raw.label === 'deed' ? raw.deed_kind : null,
    goal: raw.goal,
    manner: raw.manner?.trim() ? raw.manner.trim() : null,
    projectTempo: tempoOf(raw.project_tempo),
    workTempo: tempoOf(raw.work_tempo),
  }),
};

export async function interpretWill(deps: AgentDeps, input: WillInput): Promise<Will> {
  return (await runStructured(deps, willInterpreter, input)).value;
}
