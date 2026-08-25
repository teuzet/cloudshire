/**
 * Короткая память жреца: факты, которые он сам записал
 * («называть только Алаэр», «не будить по мелочам»).
 */

import { newId } from './ids.js';

export function rulerMemoryOf(domain) {
  const list = domain?.state?.rulerMemory;
  return Array.isArray(list) ? list : [];
}

export function formatRulerMemoryForPrompt(domain) {
  const list = rulerMemoryOf(domain);
  if (!list.length) return '';
  return [
    'ТВОЯ ПАМЯТЬ (держись этого, пока не перепишешь):',
    ...list.map((n) => `- [${n.id}] ${n.text}`),
  ].join('\n');
}

export function writeRulerMemory(domain, text, { tick = null } = {}) {
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  if (!Array.isArray(domain.state.rulerMemory)) domain.state.rulerMemory = [];
  const body = String(text || '').trim().replace(/\s+/g, ' ');
  if (body.length < 4) return { ok: false, error: 'too_short' };
  const note = {
    id: newId('mem'),
    text: body.slice(0, 280),
    tick: tick ?? null,
  };
  domain.state.rulerMemory.push(note);
  if (domain.state.rulerMemory.length > 24) {
    domain.state.rulerMemory = domain.state.rulerMemory.slice(-24);
  }
  return { ok: true, note };
}

export function forgetRulerMemory(domain, memoryId) {
  if (!domain.state || typeof domain.state !== 'object') return { ok: false };
  const id = String(memoryId || '').trim();
  const list = rulerMemoryOf(domain);
  const next = list.filter((n) => n.id !== id);
  if (next.length === list.length) return { ok: false, error: 'not_found' };
  domain.state.rulerMemory = next;
  return { ok: true };
}

const ASK_GAP_MONTHS = 3;
const ASK_CHANCE = 0.22;

export function shouldRulerAskPatron(domain, world, rng = Math.random) {
  const tick = Number(world?.tickIndex);
  if (!Number.isFinite(tick)) return false;
  const last = Number(domain?.state?.rulerLastQuestionTick);
  if (Number.isFinite(last) && tick - last < ASK_GAP_MONTHS) return false;
  return rng() < ASK_CHANCE;
}

export function markRulerAsked(domain, world) {
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  domain.state.rulerLastQuestionTick = Number(world?.tickIndex) || 0;
}
