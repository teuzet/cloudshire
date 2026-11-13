/** Обрезать текст до `max` символов по границе слова, с многоточием, если пришлось резать. */
export function clipWords(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

/**
 * Название «Каждое Слово С Большой» привести к обычной фразе. Трогаем только тот случай,
 * когда с большой буквы идут все слова из трёх и больше: так имена в обычной фразе остаются.
 */
export function plainTitle(title: string): string {
  const words = title.trim().split(/\s+/);
  const capital = (w: string) => /^[A-ZА-ЯЁ]/.test(w.replace(/^[«"(]/, ''));
  if (words.length < 3 || !words.every(capital)) return title.trim();
  return [words[0], ...words.slice(1).map((w) => w.toLowerCase())].join(' ');
}
