import { block, join } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { chronicleSchema, type ChronicleRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface ChronicleInput {
  /** Суть события: слова Агента битов, Развязчика или кода. */
  gist: string;
  /** Перемены списком, уже словами: «Появилось: Башня с баллистой (большое сооружение)…» */
  changes: string[];
}

export const chronicler: StructuredAgent<ChronicleInput, ChronicleRaw, string> = {
  name: 'chronicler',
  tool: 'submit_chronicle',
  description: 'Запись летописи об одном событии и его переменах.',
  schema: chronicleSchema,
  system: () => composeSystem([], prompt, canon('setting'), canon('style-plain')),
  user: ({ gist, changes }) => join(`Суть события: ${gist}`, block('Перемены', changes.map((c) => `- ${c}`).join('\n'))),
  finish: (raw) => raw.text,
};

export async function writeChronicleEntry(deps: AgentDeps, input: ChronicleInput): Promise<string> {
  return (await runStructured(deps, chronicler, input)).value;
}
