/**
 * Факты мира и канонические неизвестности. Чистые операции над городом.
 */

import type { CanonicalUnknown, City, LoreFact } from './city.js';

export const UNKNOWN_ITEM_MAX = 220;
export const UNKNOWN_MAX_ITEMS = 8;
export const FACT_TEXT_MAX = 400;

/** Незнание — не факт: такие записи потом читаются как правда о мире. */
const IGNORANCE = /не установлен|сведений нет|неизвестн|или исчезновени|возможно,|предположительно/i;

export function isIgnorance(text: string): boolean {
  return IGNORANCE.test(text);
}

export function activeFacts(city: Pick<City, 'facts'>): LoreFact[] {
  return city.facts.filter((f) => f.status === 'active');
}

export function findFact(city: Pick<City, 'facts'>, id: string): LoreFact | null {
  return city.facts.find((f) => f.id === id) ?? null;
}

/**
 * Канонические неизвестности: без маркеров списка, без пустых и повторов, не больше UNKNOWN_MAX_ITEMS.
 * Ссылки на объекты, которых нет среди активных, отбрасываются.
 */
export function normalizeUnknowns(list: ReadonlyArray<{ text: string; objectIds?: readonly string[] }>, objectIds: ReadonlySet<string>): CanonicalUnknown[] {
  const out: CanonicalUnknown[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const text = raw.text.replace(/^\s*[-•*]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, UNKNOWN_ITEM_MAX);
    if (!text || /^(нет|—|-)\.?$/iu.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, objectIds: [...new Set((raw.objectIds ?? []).filter((id) => objectIds.has(id)))] });
    if (out.length >= UNKNOWN_MAX_ITEMS) break;
  }
  return out;
}

/** Объекты, на которых держатся тайны острова: посадки их не трогают. */
export function mysteryObjectIds(city: Pick<City, 'unknowns'>): Set<string> {
  return new Set(city.unknowns.flatMap((u) => u.objectIds));
}

export type LoreResult = { ok: true; fact: LoreFact } | { ok: false; error: 'not_a_fact' | 'too_short' | 'fact_not_found' };

export function newFact(args: { id: string; text: string; day: number; frontId?: string | null; author: LoreFact['author'] }): LoreFact {
  return {
    id: args.id,
    text: args.text.trim().slice(0, FACT_TEXT_MAX),
    day: Math.max(0, Math.round(args.day)),
    frontId: args.frontId ?? null,
    author: args.author,
    status: 'active',
    previousText: null,
    reason: null,
  };
}

export function addFact(city: Pick<City, 'facts'>, args: Parameters<typeof newFact>[0]): LoreResult {
  const text = args.text.trim();
  if (text.length < 3) return { ok: false, error: 'too_short' };
  if (isIgnorance(text)) return { ok: false, error: 'not_a_fact' };
  const fact = newFact({ ...args, text });
  city.facts.push(fact);
  return { ok: true, fact };
}

export function updateFact(city: Pick<City, 'facts'>, id: string, text: string, reason: string | null): LoreResult {
  const fact = findFact(city, id);
  if (!fact || fact.status !== 'active') return { ok: false, error: 'fact_not_found' };
  const body = text.trim();
  if (body.length < 3) return { ok: false, error: 'too_short' };
  if (isIgnorance(body)) return { ok: false, error: 'not_a_fact' };
  fact.previousText = fact.text;
  fact.text = body.slice(0, FACT_TEXT_MAX);
  fact.reason = reason?.trim().slice(0, 300) || null;
  return { ok: true, fact };
}

export function retireFact(city: Pick<City, 'facts'>, id: string, reason: string | null): LoreResult {
  const fact = findFact(city, id);
  if (!fact || fact.status !== 'active') return { ok: false, error: 'fact_not_found' };
  fact.status = 'retired';
  fact.reason = reason?.trim().slice(0, 300) || null;
  return { ok: true, fact };
}
