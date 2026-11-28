/**
 * Преемник на должности жреца или сановника: имя из пула, нрав и строка хроники о том, как он занял место.
 */

import type { Gender, PoolName } from '../../core/city.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { namesBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { successorSchema, type SuccessorRaw } from './schema.js';

export interface SuccessorInput {
  cityName: string;
  brief: string;
  /** Должность словами: «верховный жрец», «казначей». */
  post: string;
  /** Чем ведает должность. */
  focus: string;
  predecessor: { name: string; nature: string };
  /** Что случилось с предшественником. */
  cause: string;
  names: readonly PoolName[];
}

export interface Successor {
  name: string;
  gender: Gender;
  nature: string;
  arrival: string;
}

const prompt = loadPrompt(import.meta.url);

export const successorAgent: StructuredAgent<SuccessorInput, SuccessorRaw, Successor> = {
  name: 'successor',
  tool: 'submit_successor',
  description: 'Преемник на должности: имя из списка, нрав, строка хроники.',
  schema: successorSchema,
  system: ({ names }) => composeSystem(['world', 'style-names'], prompt, namesBlock(names)),
  user: ({ cityName, brief, post, focus, predecessor, cause }) =>
    [
      `Город «${cityName}».`,
      section('О ГОРОДЕ', brief),
      `Должность: ${post}. Ведает: ${focus}.`,
      `Прежде на ней был ${predecessor.name}: ${predecessor.nature}`,
      `Что с ним случилось: ${cause}.`,
      'Вызови submit_successor.',
    ].join('\n\n'),
  check: (raw, { names }) => (names.length && !names.some((n) => n.name === raw.name) ? `имени ${raw.name} нет в списке ИМЕНА` : null),
  finish: (raw, { names }) => ({
    name: raw.name,
    gender: names.find((n) => n.name === raw.name)?.gender ?? 'male',
    nature: raw.nature,
    arrival: raw.arrival,
  }),
};

export async function writeSuccessor(deps: AgentDeps, input: SuccessorInput): Promise<Successor> {
  return (await runStructured(deps, successorAgent, input)).value;
}
