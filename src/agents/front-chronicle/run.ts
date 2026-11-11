/**
 * Хронист: из сухого факта — одна запись хроники.
 */

import type { ChronicleEntry } from '../../core/city.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { chronicleBlock, namesBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { chronicleSchema, type ChronicleRaw } from './schema.js';

export interface FrontChronicleInput {
  cityName: string;
  fact: string;
  /** Что уже записано по этой истории — чтобы не противоречить. */
  history: ChronicleEntry[];
  names: readonly string[];
}

const prompt = loadPrompt(import.meta.url);

export const frontChronicle: StructuredAgent<FrontChronicleInput, ChronicleRaw, string> = {
  name: 'front-chronicle',
  tool: 'submit_chronicle',
  description: 'Текст одной записи хроники.',
  schema: chronicleSchema,
  system: ({ cityName, history, names }) =>
    composeSystem(
      ['world', 'style-chronicle', 'style-names'],
      prompt,
      `Город: ${cityName}`,
      section('Уже записано', chronicleBlock(history)),
      namesBlock(names),
    ),
  user: ({ fact }) => `Факт:\n${fact}`,
  finish: (raw) => raw.text,
};

export async function writeChronicle(deps: AgentDeps, input: FrontChronicleInput): Promise<string> {
  return (await runStructured(deps, frontChronicle, input)).value;
}
