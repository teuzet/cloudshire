/**
 * Случайность в core — всегда аргумент. Никаких Math.random внутри логики:
 * так тест с фиксированным seed воспроизводит мир до бита.
 */

/** Равномерное число в [0, 1). */
export type Rng = () => number;

/** Детерминированный генератор mulberry32. Для тестов и сценариев. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Идентификатор вида `front_k3j9x0a1b2c4`. */
export function makeId(prefix: string, rng: Rng): string {
  let tail = '';
  for (let i = 0; i < 12; i += 1) tail += ALPHABET[Math.floor(rng() * ALPHABET.length)] ?? '0';
  return `${prefix}_${tail}`;
}

export function pickOne<T>(items: readonly T[], rng: Rng): T | undefined {
  if (!items.length) return undefined;
  return items[Math.floor(rng() * items.length)];
}
