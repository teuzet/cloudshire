/**
 * Город для агентов: компактный cityBrief + постоянные дописки (modifiers).
 * Указы живут на plotline, не здесь.
 */

import { newId } from './ids.js';

export const CITY_MODIFIER_MAX = 400;
export const CITY_BRIEF_MAX = 1800;

export function clipCityText(s, max) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
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

/** То, что видят агенты вместо полного генезиса: бриф, сразу после него — modifiers. */
export function formatCityForAgents(domain) {
  const brief =
    clipCityText(domain?.cityBrief, CITY_BRIEF_MAX) ||
    String(domain?.description || '').trim() ||
    '(описание пусто)';
  const mods = formatCityModifiersForPrompt(domain);
  return mods ? `${brief}\n\n${mods}` : brief;
}
