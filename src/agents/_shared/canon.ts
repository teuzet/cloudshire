/**
 * Общие тексты для промптов: канон мира и стилевые блоки.
 * Каждый агент сам решает, какие куски ему нужны.
 */

import fs from 'node:fs';

export const CANON_PARTS = [
  'safety',
  'world',
  'patron',
  'priest',
  'time',
  'foreign',
  'style-chronicle',
  'style-names',
  'style-priest-voice',
  'style-event-balance',
  'setting',
  'style-plain',
] as const;
export type CanonPart = (typeof CANON_PARTS)[number];

const cache = new Map<string, string>();

function readOnce(url: URL): string {
  const key = url.href;
  let text = cache.get(key);
  if (text == null) {
    text = fs.readFileSync(url, 'utf8').trim();
    cache.set(key, text);
  }
  return text;
}

export function canon(part: CanonPart): string {
  return readOnce(new URL(`./canon/${part}.md`, import.meta.url));
}

/** Прочитать prompt.md рядом с run.ts агента: `loadPrompt(import.meta.url)`. */
export function loadPrompt(moduleUrl: string, file = 'prompt.md'): string {
  return readOnce(new URL(`./${file}`, moduleUrl));
}

/** Собрать system: куски канона, затем инструкция агента, затем контекст хода. */
export function composeSystem(parts: readonly CanonPart[], instructions: string, ...context: Array<string | null | undefined | false>): string {
  return [...parts.map(canon), instructions, ...context]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n\n');
}
