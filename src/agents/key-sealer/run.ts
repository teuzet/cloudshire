import { block, join } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { keySchema, type KeyRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

/** Род ситуации словами для промпта. Поток переводит в него форму фронта. */
export type SituationKind = 'work' | 'tension' | 'threat' | 'chance' | 'search';

const KIND_WORDS: Record<SituationKind, string> = {
  work: 'работа',
  tension: 'растущее недовольство',
  threat: 'беда со сроком',
  chance: 'удобный случай',
  search: 'поиск',
};

export interface KeyInput {
  title: string;
  description: string;
  kind: SituationKind;
  /** Участники: «Артель каменщиков — занята работой: строит башню». */
  roles: string[];
  /** Что в таких ситуациях обычно помогает (из записи словаря). */
  hint?: string | null;
  /** Нужен ли подвох исхода. */
  twistNeeded?: boolean;
}

export interface SealedKey {
  moves: string[];
  twist: string | null;
}

export const keySealer: StructuredAgent<KeyInput, KeyRaw, SealedKey> = {
  name: 'key-sealer',
  tool: 'submit_key',
  description: 'Разумные способы действия в ситуации и, если просят, скрытое свойство исхода.',
  schema: keySchema,
  system: () => composeSystem([], prompt, canon('setting')),
  user: ({ title, description, kind, roles, hint, twistNeeded }) =>
    join(
      `Ситуация: «${title}». ${description}`,
      `Род ситуации: ${KIND_WORDS[kind]}`,
      block('Участники', roles.length ? roles.map((r) => `- ${r}`).join('\n') : 'особых участников нет'),
      hint ? `Обычно помогает: ${hint}` : null,
      `Нужно скрытое свойство исхода: ${twistNeeded ? 'да' : 'нет'}`,
    ),
  check: (raw, input) => (input.twistNeeded && !raw.twist?.trim() ? 'нужно скрытое свойство исхода в поле twist' : null),
  finish: (raw, input) => ({
    moves: [...new Set(raw.moves.map((m) => m.trim()))],
    twist: input.twistNeeded && raw.twist?.trim() ? raw.twist.trim() : null,
  }),
};

export async function sealKey(deps: AgentDeps, input: KeyInput): Promise<SealedKey> {
  return (await runStructured(deps, keySealer, input)).value;
}
