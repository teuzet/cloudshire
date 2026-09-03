/**
 * Город для агентов: компактный cityBrief.
 * Постоянный след города — в брифе (cityGenesisRewrite).
 * Канонические неизвестности — блок «Неизвестно (канон):» в том же тексте.
 * Старые modifiers не отдаём в промпт. Указы живут на plotline.
 */

import { newId } from './ids.js';

export const CITY_MODIFIER_MAX = 400;
export const CITY_BRIEF_MAX = 3500;
export const CANONICAL_UNKNOWNS_HEADING = 'Неизвестно (канон):';
const UNKNOWN_ITEM_MAX = 220;
const UNKNOWN_MAX_ITEMS = 8;
const SECTION_SPLIT_RE = /\n*Неизвестно \(канон\):\s*/u;

export function clipCityText(s, max) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

export function normalizeCanonicalUnknowns(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw || '')
      .replace(/^\s*[-•*]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, UNKNOWN_ITEM_MAX);
    if (!text || /^(нет|—|-)\.?$/iu.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= UNKNOWN_MAX_ITEMS) break;
  }
  return out;
}

export function parseCityBrief(brief) {
  const raw = String(brief || '').trim();
  if (!raw) return { body: '', unknowns: [] };
  const parts = raw.split(SECTION_SPLIT_RE);
  if (parts.length === 1) {
    return { body: clipCityText(raw, CITY_BRIEF_MAX), unknowns: [] };
  }
  const body = clipCityText(parts[0], CITY_BRIEF_MAX);
  const section = String(parts.slice(1).join('\n') || '').trim();
  const fromLines = section
    .split('\n')
    .map((line) => line.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
  return { body, unknowns: normalizeCanonicalUnknowns(fromLines) };
}

export function formatCityBrief({ body = '', unknowns = [] } = {}, max = CITY_BRIEF_MAX) {
  const items = normalizeCanonicalUnknowns(unknowns);
  const tail = items.length
    ? `${CANONICAL_UNKNOWNS_HEADING}\n${items.map((u) => `- ${u}`).join('\n')}`
    : '';
  const budget = tail ? Math.max(240, max - tail.length - 2) : max;
  const clippedBody = clipCityText(body, budget);
  if (!clippedBody) return tail;
  return tail ? `${clippedBody}\n\n${tail}` : clippedBody;
}

export function formatCanonicalUnknownsForPrompt(unknowns = []) {
  const items = normalizeCanonicalUnknowns(unknowns);
  if (!items.length) return 'Канонических неизвестностей нет.';
  return [
    'Канонические неизвестности (установленный пробел мира — не раскрывай и не ставь причину/источник/ответ):',
    ...items.map((u) => `- ${u}`),
    'Соседние бытовые детали той же темы, которых нет в списке, устанавливай. Висящему пункту не противоречь.',
  ].join('\n');
}

export function matchCanonicalUnknown(unknowns, needle) {
  const items = normalizeCanonicalUnknowns(unknowns);
  const n = String(needle || '')
    .replace(/^\s*[-•*]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n || !items.length) return -1;
  const lower = n.toLowerCase();
  const exact = items.findIndex((u) => u.toLowerCase() === lower);
  if (exact >= 0) return exact;
  if (/^\d+$/.test(n)) {
    const idx = Number(n) - 1;
    if (items[idx]) return idx;
  }
  return -1;
}

export function applyCanonicalUnknownReveal(brief, { unknown, revealed } = {}) {
  const parsed = parseCityBrief(brief);
  const idx = matchCanonicalUnknown(parsed.unknowns, unknown);
  if (idx < 0) return { ok: false, error: 'unknown_not_found' };
  const fact = String(revealed || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (fact.length < 12) return { ok: false, error: 'revealed_thin' };
  if (/неизвестн|не установлен|сведений нет|предположительно|возможно,/i.test(fact)) {
    return { ok: false, error: 'still_unknown' };
  }
  const item = parsed.unknowns[idx];
  const remaining = parsed.unknowns.filter((_, i) => i !== idx);
  let body = parsed.body;
  const already = body.toLowerCase().includes(fact.toLowerCase().slice(0, 48));
  if (!already) body = body ? `${body} ${fact}` : fact;
  return {
    ok: true,
    brief: formatCityBrief({ body, unknowns: remaining }),
    unknown: item,
    revealed: fact,
  };
}

export function normalizeCityModifier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clipCityText(raw.text, CITY_MODIFIER_MAX);
  if (!text) return null;
  const sinceTick = Number.isInteger(Number(raw.sinceTick)) ? Number(raw.sinceTick) : null;
  return {
    id: String(raw.id || newId('cmod')),
    text,
    sinceTick,
    sinceLabel: String(raw.sinceLabel || '').trim() || null,
    plotId: raw.plotId ? String(raw.plotId) : null,
    gravity: Number.isFinite(Number(raw.gravity)) ? Math.round(Number(raw.gravity)) : null,
  };
}

export function normalizeCityModifiers(domain) {
  if (!domain || typeof domain !== 'object') return domain;
  const fromField = Array.isArray(domain.modifiers) ? domain.modifiers : [];
  const leftover = (domain.state?.modifiers || []).filter(
    (m) => m && m.kind !== 'order' && String(m.text || '').trim(),
  );
  const merged = [...fromField, ...leftover].map(normalizeCityModifier).filter(Boolean);
  const seen = new Set();
  domain.modifiers = [];
  for (const m of merged) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    domain.modifiers.push(m);
  }
  return domain;
}

export function appendCityModifier(domain, { text, sinceTick = null, sinceLabel = null, plotId = null, gravity = null } = {}) {
  normalizeCityModifiers(domain);
  const mod = normalizeCityModifier({
    id: newId('cmod'),
    text,
    sinceTick,
    sinceLabel,
    plotId,
    gravity,
  });
  if (!mod) return null;
  const dup = domain.modifiers.find((m) => m.text === mod.text);
  if (dup) return dup;
  domain.modifiers.push(mod);
  return mod;
}

export function formatCityModifiersForPrompt(domain) {
  normalizeCityModifiers(domain);
  if (!domain.modifiers.length) return '';
  const lines = domain.modifiers.map((m) => {
    const when = m.sinceLabel || (m.sinceTick != null ? `с тика ${m.sinceTick}` : '');
    return `- ${when ? `[${when}] ` : ''}${m.text}`;
  });
  return `Постоянные изменения города:\n${lines.join('\n')}`;
}

/** То, что видят агенты вместо полного генезиса: только бриф. */
export function formatCityForAgents(domain) {
  const raw = String(domain?.cityBrief || '').trim();
  if (raw) return formatCityBrief(parseCityBrief(raw));
  return String(domain?.description || '').trim() || '(описание пусто)';
}

/** Зерно посева из генезиса: бриф, иначе сжатое описание. Пустая строка, если города ещё нет. */
export function cityGenesisSeedText(domain) {
  const raw = String(domain?.cityBrief || '').trim();
  if (raw) return formatCityBrief(parseCityBrief(raw));
  const desc = String(domain?.description || '').trim();
  return desc ? clipCityText(desc, CITY_BRIEF_MAX) : '';
}
