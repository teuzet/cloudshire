/**
 * Имена людей. У каждого одиночного человека в городе есть личное имя из пула мира:
 * объект типа person без него получает имя кодом, роль остаётся в названии («Тэн, старший пороховщик»).
 */

import type { Gender } from './city.js';

/** Кто выдаёт имена: известные имена мира и следующее свободное имя нужного пола. */
export interface Namer {
  known: ReadonlySet<string>;
  take(gender: Gender): string | null;
}

const words = (name: string): string[] => name.split(/[^\p{L}]+/u).filter(Boolean);

/** Есть ли в названии личное имя из пула мира. */
export function hasPersonalName(name: string, known: ReadonlySet<string>): boolean {
  return words(name).some((w) => known.has(w));
}

/** Существительные на -а/-я, которые бывают и о мужчине. */
const EITHER = new Set(['слуга', 'судья', 'старшина', 'глава', 'юноша', 'староста', 'воевода', 'сирота', 'бродяга', 'пьяница', 'умница', 'убийца', 'левша', 'сластёна', 'зануда']);

/** Пол по названию роли: «Старшая наследница» и «Отшельница» — она, «Младший архивариус» — он. */
export function roleGender(role: string): Gender {
  const ws = words(role.toLowerCase());
  const head = ws[0] ?? '';
  if (/(ая|яя)$/u.test(head)) return 'female';
  if (/(ый|ий|ой)$/u.test(head)) return 'male';
  if (/^(дочь|мать|жена|вдова|сестра)$/u.test(head)) return 'female';
  return /[ая]$/u.test(head) && !EITHER.has(head) ? 'female' : 'male';
}

/** Название человека с личным именем. Не человек, уже с именем или имён нет — название как есть. */
export function namePerson(type: string, name: string, namer: Namer | null | undefined): string {
  if (type !== 'person' || !namer || hasPersonalName(name, namer.known)) return name;
  const person = namer.take(roleGender(name));
  if (!person) return name;
  const role = name.trim();
  return `${person}, ${role.charAt(0).toLowerCase()}${role.slice(1)}`;
}
