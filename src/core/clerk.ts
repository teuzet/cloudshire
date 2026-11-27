/**
 * Книга клерка: духи городов для трёх набросков и база вопросов для игрока,
 * который не может сформулировать город. Здесь только форма книги и выбор из неё;
 * сама книга лежит рядом с агентом (onboarding-guide/book.yaml).
 */

import { z } from 'zod';
import type { Rng } from './random.js';

export const CLERK_THEMES = ['island', 'economy', 'people', 'threat', 'strange', 'past', 'faith'] as const;
export type ClerkTheme = (typeof CLERK_THEMES)[number];

const spiritSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  name: z.string().min(1),
  /** Пояснение для людей, которые правят книгу. Клерку не подаётся: он видит семью и название. */
  line: z.string().min(1),
});

const questionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['fork', 'open']),
  theme: z.enum(CLERK_THEMES),
  text: z.string().min(1),
});

const bookSchema = z.object({
  /** Сколько набросков города клерк предлагает игроку, который просит выбрать за него. */
  sketches: z.number().int().min(2).max(5),
  /** Сколько вопросов код выдаёт клерку на выбор. */
  shortlist: z.number().int().min(2).max(12),
  /** Сколько вопросов одной темы может попасть в один шорт-лист. */
  perTheme: z.number().int().min(1).max(6),
  spirits: z.array(spiritSchema).min(1),
  questions: z.array(questionSchema).min(1),
});

export type ClerkSpirit = z.infer<typeof spiritSchema>;
export type ClerkQuestion = z.infer<typeof questionSchema>;
export type ClerkBook = z.infer<typeof bookSchema>;

function unique(ids: string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`книга клерка: повтор ${what} «${id}»`);
    seen.add(id);
  }
}

export function parseClerkBook(raw: unknown): ClerkBook {
  const book = bookSchema.parse(raw);
  unique(book.spirits.map((s) => s.id), 'духа');
  unique(book.questions.map((q) => q.id), 'вопроса');
  const families = new Set(book.spirits.map((s) => s.family));
  if (families.size < book.sketches) throw new Error(`книга клерка: семей духов ${families.size}, а набросков нужно ${book.sketches}`);
  return book;
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Духи для набросков: по одному из разных семей. Уже показанные духи не повторяются,
 * пока в семье есть свежие; когда свежих семей не хватает, берём из показанных.
 */
export function drawSpirits(book: ClerkBook, rng: Rng, used: readonly string[] = []): ClerkSpirit[] {
  const seen = new Set(used);
  const byFamily = new Map<string, ClerkSpirit[]>();
  for (const s of book.spirits) byFamily.set(s.family, [...(byFamily.get(s.family) ?? []), s]);
  const fresh: ClerkSpirit[] = [];
  const stale: ClerkSpirit[] = [];
  for (const family of shuffled([...byFamily.keys()], rng)) {
    const all = shuffled(byFamily.get(family) ?? [], rng);
    const unseen = all.find((s) => !seen.has(s.id));
    if (unseen) fresh.push(unseen);
    else if (all[0]) stale.push(all[0]);
  }
  return [...fresh, ...stale].slice(0, book.sketches);
}

/**
 * Вопросы на выбор клерку. Первый вопрос разговора случайный и один. Дальше — шорт-лист
 * ещё не заданных, сначала по темам, которые в разговоре не звучали.
 */
export function shortlistQuestions(book: ClerkBook, rng: Rng, asked: readonly string[] = [], heard: readonly string[] = []): ClerkQuestion[] {
  const done = new Set(asked);
  const pool = shuffled(book.questions.filter((q) => !done.has(q.id)), rng);
  if (!asked.length) return pool.slice(0, 1);
  const quiet = new Set<string>(heard);
  const ordered = [...pool.filter((q) => !quiet.has(q.theme)), ...pool.filter((q) => quiet.has(q.theme))];
  const perTheme = new Map<string, number>();
  const out: ClerkQuestion[] = [];
  for (const q of ordered) {
    const n = perTheme.get(q.theme) ?? 0;
    if (n >= book.perTheme) continue;
    perTheme.set(q.theme, n + 1);
    out.push(q);
    if (out.length >= book.shortlist) break;
  }
  return out;
}
