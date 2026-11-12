import { join } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { beatSchema, type BeatEffect, type BeatRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface BeatInput {
  title: string;
  description: string;
  /** Пройденная доля пути, 0..1. Единица значит, что дело завершено. */
  share: number;
  /** «казначей Ада» или null, если ведущего нет. */
  lead: string | null;
  manner: string | null;
  /** Что получится в конце: чтобы веха вела к результату. */
  result: string | null;
  /** Сведение, которое открывается на этой вехе. */
  reveal: string | null;
  allowed: BeatEffect[];
  /** Прежние записи об этом деле, от старых к новым: новая говорит о следующем шаге. */
  before?: string[];
}

export interface Beat {
  text: string;
  effect: BeatEffect;
}

function shareWords(share: number): string {
  if (share >= 1) return 'путь пройден целиком, дело завершено';
  return `пройдено около ${Math.round(share * 100)}% пути`;
}

export const beatWriter: StructuredAgent<BeatInput, BeatRaw, Beat> = {
  name: 'beat-writer',
  tool: 'submit_beat',
  description: 'Запись о шаге дела и один эффект из разрешённых.',
  schema: beatSchema,
  system: () => composeSystem([], prompt, canon('setting'), canon('style-plain')),
  user: ({ title, description, share, lead, manner, result, reveal, allowed, before }) =>
    join(
      `Дело: «${title}». ${description}`,
      before?.length ? `Уже записано об этом деле:\n${before.map((b) => `- ${b}`).join('\n')}` : null,
      `Пройдено: ${shareWords(share)}`,
      result ? `Что должно получиться: ${result}` : null,
      lead ? `Ведёт: ${lead}${manner ? `. Способ: ${manner}` : ''}` : 'Дело идёт само, без ведущего',
      reveal ? `Открывается сведение: ${reveal}` : null,
      `Разрешённые эффекты: ${allowed.join(', ')}`,
    ),
  check: (raw, input) => (input.allowed.includes(raw.effect) ? null : `effect берётся из разрешённых: ${input.allowed.join(', ')}`),
  finish: (raw) => ({ text: raw.text, effect: raw.effect }),
};

export async function writeBeat(deps: AgentDeps, input: BeatInput): Promise<Beat> {
  return (await runStructured(deps, beatWriter, input)).value;
}
