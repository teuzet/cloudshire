import { TYPE_WORDS, join, type ObjectBrief } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { themesSchema, type ThemesRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface ThemesInput {
  subject: Omit<ObjectBrief, 'id'>;
  themes: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

export const themeTagger: StructuredAgent<ThemesInput, ThemesRaw, string[]> = {
  name: 'theme-tagger',
  tool: 'submit_themes',
  description: 'Одна или две темы города для его новой части.',
  schema: themesSchema,
  system: () => composeSystem([], prompt),
  user: ({ subject, themes }) =>
    join(
      `Часть города: «${subject.name}», ${TYPE_WORDS[subject.type]}. ${subject.description}`,
      `Темы города: ${themes.length ? themes.join('; ') : 'тем пока нет, предложи новую'}`,
    ),
  check: (raw, input) => {
    const known = new Set(input.themes.map(norm));
    const alien = raw.existing.find((t) => !known.has(norm(t)));
    if (alien) return `темы «${alien}» нет в списке; в existing бери темы из списка теми же словами, новую давай в fresh`;
    const total = raw.existing.length + (raw.fresh ? 1 : 0);
    if (total < 1 || total > 2) return 'всего нужна одна или две темы';
    return null;
  },
  finish: (raw, input) => {
    const byNorm = new Map(input.themes.map((t) => [norm(t), t]));
    const out = raw.existing.map((t) => byNorm.get(norm(t)) ?? t);
    if (raw.fresh && !byNorm.has(norm(raw.fresh))) out.push(raw.fresh.trim().toLowerCase());
    return [...new Set(out)].slice(0, 2);
  },
};

export async function tagThemes(deps: AgentDeps, input: ThemesInput): Promise<string[]> {
  return (await runStructured(deps, themeTagger, input)).value;
}
