import type { ObjectType, Shape } from '../../core/rules.js';
import { block, briefLine, join, typesBlock, type ObjectBrief } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { costumeSchema, type CostumeRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export const SHAPE_WORDS: Record<Shape, string> = {
  tension: 'растущее недовольство',
  threat: 'беда со сроком',
  hindrance: 'помеха в работе',
  accident: 'несчастный случай',
  opportunity: 'удобный случай',
  clock: 'отложенная перемена',
};

export interface CostumeInput {
  /** Скелет записи словаря или свободной динамики. */
  skeleton: string;
  shape: Shape;
  /** Работа или перемена, из-за которой событие возникло. */
  cause: string;
  /** Объект в роли и то, как причина его касается. */
  actor: { object: ObjectBrief; touch: string } | null;
  themes: string[];
  /** Имена для новых людей: «Айра (ж)». */
  names: string[];
  needsNew: boolean;
}

export interface Costume {
  title: string;
  description: string;
  rumor: string;
  outburst: string;
  newObject: { type: ObjectType; name: string; description: string } | null;
}

export const costumer: StructuredAgent<CostumeInput, CostumeRaw, Costume> = {
  name: 'costumer',
  tool: 'submit_costume',
  description: 'Конкретное событие города по общему наброску.',
  schema: costumeSchema,
  system: () => composeSystem([], prompt, canon('setting'), block('Виды частей города (type)', typesBlock())),
  user: ({ skeleton, shape, cause, actor, themes, names, needsNew }) =>
    join(
      `Набросок: ${skeleton}`,
      `Род события: ${SHAPE_WORDS[shape]}`,
      `Причина: ${cause}`,
      actor ? `Участник: ${briefLine(actor.object)}\nКак причина его касается: ${actor.touch}` : 'Участник: само место работ и те, кто на нём трудится',
      themes.length ? `Темы города: ${themes.join('; ')}` : null,
      `Имена для новых людей: ${names.length ? names.join(', ') : 'личных имён не давай, называй людей по ремеслу'}`,
      `Нужен новый участник: ${needsNew ? 'да' : 'нет'}`,
    ),
  check: (raw, input) => (input.needsNew && !raw.new_object ? 'нужен новый участник в поле new_object' : null),
  finish: (raw, input) => ({
    title: raw.title,
    description: raw.description,
    rumor: raw.rumor,
    outburst: raw.outburst,
    newObject: input.needsNew ? raw.new_object : null,
  }),
};

export async function dressEvent(deps: AgentDeps, input: CostumeInput): Promise<Costume> {
  return (await runStructured(deps, costumer, input)).value;
}
