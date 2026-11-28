import { describe, expect, test } from 'vitest';
import { clerkBook } from '../../src/agents/onboarding-guide/book.js';
import { drawSpirits, parseClerkBook, shortlistQuestions } from '../../src/core/clerk.js';
import { seededRng } from '../../src/core/random.js';

describe('книга клерка', () => {
  const book = clerkBook();

  test('книга с диска читается: духов хватает на наброски из разных семей', () => {
    expect(book.spirits.length).toBeGreaterThanOrEqual(30);
    expect(book.questions.length).toBeGreaterThanOrEqual(30);
    expect(new Set(book.spirits.map((s) => s.family)).size).toBeGreaterThanOrEqual(book.sketches);
  });

  test('наброски: по одному духу из разных семей, показанные не повторяются', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rng = seededRng(seed);
      const first = drawSpirits(book, rng);
      expect(first).toHaveLength(book.sketches);
      expect(new Set(first.map((s) => s.family)).size).toBe(book.sketches);
      const second = drawSpirits(book, rng, first.map((s) => s.id));
      expect(second.some((s) => first.includes(s))).toBe(false);
    }
  });

  test('вопросы: первый один и случайный, дальше шорт-лист незаданных с упором на неуслышанные темы', () => {
    const rng = seededRng(3);
    const first = shortlistQuestions(book, rng);
    expect(first).toHaveLength(1);
    const asked = [first[0]!.id];
    const heard = ['island', 'economy', 'people'];
    const list = shortlistQuestions(book, rng, asked, heard);
    expect(list).toHaveLength(book.shortlist);
    expect(list.some((q) => asked.includes(q.id))).toBe(false);
    expect(list.every((q) => !heard.includes(q.theme))).toBe(true);
    const counts = new Map<string, number>();
    for (const q of list) counts.set(q.theme, (counts.get(q.theme) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(book.perTheme);
  });

  test('повтор номера и нехватка семей — ошибка разбора', () => {
    const spirit = { id: 's1', family: 'a', name: 'А', line: 'а' };
    const question = { id: 'q1', kind: 'open', theme: 'people', text: '?' };
    expect(() => parseClerkBook({ sketches: 2, shortlist: 2, perTheme: 1, spirits: [spirit, spirit], questions: [question] })).toThrow(/повтор/);
    expect(() => parseClerkBook({ sketches: 2, shortlist: 2, perTheme: 1, spirits: [spirit], questions: [question] })).toThrow(/семей/);
  });
});
