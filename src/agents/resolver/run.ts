import type { ObjectType } from '../../core/rules.js';
import { block, briefList, join, typesBlock, type ObjectBrief } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { resolutionSchema, type ResolutionEffect, type ResolutionRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export type Ending = 'averted' | 'struck' | 'collapsed';

const ENDING_WORDS: Record<Ending, string> = {
  averted: 'беду отвели вовремя',
  struck: 'беда случилась',
  collapsed: 'затея рухнула',
};

export interface ResolutionInput {
  title: string;
  description: string;
  ending: Ending;
  /** Что именно случилось по ставке, словами кода: «дело откатилось на шаг назад». */
  consequence: string | null;
  participants: ObjectBrief[];
  /** Временные участники, которых можно оставить городу. */
  keepable: string[];
  lead: string | null;
  manner: string | null;
  allowed: ResolutionEffect[];
  /** Прежние записи об этом событии: развязка говорит о новом. */
  before?: string[];
}

export type Resolution =
  | { text: string; effect: 'none' }
  | { text: string; effect: 'fact'; fact: string }
  | { text: string; effect: 'link'; a: string; b: string }
  | { text: string; effect: 'keep'; objectId: string }
  | { text: string; effect: 'gone'; objectId: string }
  | { text: string; effect: 'trace'; trace: { type: ObjectType; name: string; description: string } };

export const resolver: StructuredAgent<ResolutionInput, ResolutionRaw, Resolution> = {
  name: 'resolver',
  tool: 'submit_resolution',
  description: 'Чем закончилось событие и одно последствие из разрешённых.',
  schema: resolutionSchema,
  system: () => composeSystem([], prompt, canon('setting'), canon('style-plain'), block('Виды частей города (type)', typesBlock())),
  user: ({ title, description, ending, consequence, participants, keepable, lead, manner, allowed, before }) =>
    join(
      `Событие: «${title}». ${description}`,
      before?.length ? `Уже записано об этом событии:\n${before.map((b) => `- ${b}`).join('\n')}` : null,
      `Исход: ${ENDING_WORDS[ending]}${consequence ? `. ${consequence}` : ''}`,
      block('Участники', briefList(participants, 'особых участников нет')),
      keepable.length ? `Временные участники: ${keepable.join(', ')}` : null,
      lead ? `Действовал: ${lead}${manner ? `. Способ: ${manner}` : ''}` : 'Никто из сановников этим не занимался',
      `Разрешённые последствия: ${allowed.join(', ')}`,
    ),
  check: (raw, input) => {
    if (!input.allowed.includes(raw.effect)) return `effect берётся из разрешённых: ${input.allowed.join(', ')}`;
    const ids = new Set(input.participants.map((p) => p.id));
    if (raw.effect === 'fact' && !raw.fact?.trim()) return 'для fact нужен текст факта в поле fact';
    if (raw.effect === 'link' && (raw.object_ids.length !== 2 || raw.object_ids.some((id) => !ids.has(id)) || raw.object_ids[0] === raw.object_ids[1])) {
      return 'для link нужны два разных id участников в object_ids';
    }
    if (raw.effect === 'keep' && (raw.object_ids.length !== 1 || !input.keepable.includes(raw.object_ids[0] ?? ''))) {
      return 'для keep нужен один id из списка временных участников в object_ids';
    }
    if (raw.effect === 'gone' && (raw.object_ids.length !== 1 || !ids.has(raw.object_ids[0] ?? ''))) return 'для gone нужен один id участника в object_ids';
    if (raw.effect === 'trace' && !raw.trace) return 'для trace нужно описание следа в поле trace';
    return null;
  },
  finish: (raw) => {
    const text = raw.text;
    if (raw.effect === 'fact' && raw.fact) return { text, effect: 'fact', fact: raw.fact.trim() };
    if (raw.effect === 'link') return { text, effect: 'link', a: raw.object_ids[0] as string, b: raw.object_ids[1] as string };
    if (raw.effect === 'keep') return { text, effect: 'keep', objectId: raw.object_ids[0] as string };
    if (raw.effect === 'gone') return { text, effect: 'gone', objectId: raw.object_ids[0] as string };
    if (raw.effect === 'trace' && raw.trace) return { text, effect: 'trace', trace: raw.trace };
    return { text, effect: 'none' };
  },
};

export async function resolveEvent(deps: AgentDeps, input: ResolutionInput): Promise<Resolution> {
  return (await runStructured(deps, resolver, input)).value;
}
