/**
 * Лестница открытия саспенса — аналог mystery graph, но для нестабильного настоящего.
 * Движок продвигает ровно одну ступень за meaningful beat. Тайну не трогает.
 */

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max).trim() : t;
}

function slugId(raw, fallback, used) {
  let id = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!id) id = fallback;
  let out = id;
  let n = 2;
  while (used.has(out)) {
    out = `${id}_${n}`;
    n += 1;
  }
  used.add(out);
  return out;
}

export function hiddenPremisesBudget(depth = 1) {
  const d = Math.max(1, Math.min(4, Math.round(Number(depth) || 1)));
  if (d <= 1) return { min: 0, max: 1 };
  if (d === 2) return { min: 1, max: 2 };
  if (d === 3) return { min: 2, max: 3 };
  return { min: 2, max: 4 };
}

export function normalizeHiddenPremises(raw, depth = null) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  const max = depth != null ? hiddenPremisesBudget(depth).max : 6;
  for (const item of list) {
    const text = clip(typeof item === 'string' ? item : item?.text || item?.premise || '', 280);
    if (text.length < 8) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeDiscoveryLadder(raw, depth = null) {
  const list = Array.isArray(raw) ? raw : [];
  const used = new Set();
  const out = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const promise = clip(item.promise || item.text || '', 220);
    if (!promise) return;
    const id = slugId(item.id, `rung_${out.length + 1}`, used);
    out.push({
      id,
      promise,
      revealed: item.revealed === true,
      hiddenIndex: Number.isInteger(Number(item.hiddenIndex)) ? Number(item.hiddenIndex) : i,
    });
  });
  if (depth != null) {
    const d = Math.max(1, Math.min(4, Math.round(Number(depth) || 1)));
    return out.slice(0, d);
  }
  return out.slice(0, 4);
}

export function remainingLadderIds(ladder = []) {
  return (ladder || []).filter((r) => r && !r.revealed).map((r) => r.id);
}

export function currentFrontier(ladder = []) {
  return (ladder || []).find((r) => r && !r.revealed) || null;
}

/** Ровно одна ступень. */
export function pickFrontierAdvance(ladder = []) {
  const rung = currentFrontier(ladder);
  if (!rung) return null;
  return { rungId: rung.id, promise: rung.promise, hiddenIndex: rung.hiddenIndex };
}

export function applyLadderReveal(ladder, rungId) {
  if (!Array.isArray(ladder) || !rungId) return false;
  const rung = ladder.find((r) => r && r.id === rungId && !r.revealed);
  if (!rung) return false;
  rung.revealed = true;
  return true;
}

export function ladderFullyRevealed(ladder = []) {
  if (!Array.isArray(ladder) || !ladder.length) return true;
  return ladder.every((r) => r.revealed);
}

export function judgeSuspenseCore(draft, depth) {
  const d = Math.max(1, Math.min(4, Math.round(Number(depth) || 1)));
  const budget = hiddenPremisesBudget(d);
  const offered = normalizeHiddenPremises(draft?.hiddenPremises);
  if (offered.length > budget.max) return 'hidden_over_budget';
  const hidden = offered.slice(0, budget.max);
  if (d <= 1) return null;
  const ladder = normalizeDiscoveryLadder(draft?.discoveryLadder, d);
  if (ladder.length !== d) return 'bad_ladder';
  if (hidden.length < budget.min) return 'thin_hidden';
  const gate = clip(draft?.closureGate, 280);
  if (gate.length < 12) return 'missing_closure';
  const pub = `${draft?.entry || ''} ${draft?.synopsis || ''} ${draft?.closeWhen || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ');
  for (const h of hidden) {
    const needle = h.toLowerCase().replace(/\s+/g, ' ').slice(0, 18);
    if (needle.length >= 12 && pub.includes(needle)) return 'hidden_leak';
  }
  return null;
}

export function formatLadderForPrompt(ladder = []) {
  if (!ladder.length) return '(лестницы нет — короткая история)';
  return ladder
    .map((r, i) => {
      const state = r.revealed ? 'открыто' : i === ladder.findIndex((x) => !x.revealed) ? 'текущий frontier' : 'скрыто';
      return `- ${r.id} [${state}]: ${r.promise}`;
    })
    .join('\n');
}

export function formatHiddenPremisesForPrompt(premises = [], { allowedIndex = null } = {}) {
  if (!premises.length) return '';
  return premises
    .map((text, i) => {
      if (allowedIndex === i) return `- [${i}] МОЖНО РАСКРЫТЬ В ЭТОМ МЕСЯЦЕ: ${text}`;
      return `- [${i}] СКРЫТО, не пиши в хронику: (есть заранее установленный ответ)`;
    })
    .join('\n');
}

const DEEPEN_DYNAMICS = new Set(['deepening', 'drift', 'accumulation']);
const ESCALATE_DYNAMICS = new Set([
  'deadline',
  'spread',
  'cascade',
  'polarization',
  'lock_in',
  'feedback',
  'depletion',
]);

export function autoTickPrefersDeepen(dynamicId, { closureUnlocked = false, unattendedBeats = 0 } = {}) {
  if (closureUnlocked) return false;
  if (unattendedBeats >= 2) return false;
  const id = String(dynamicId || '').toLowerCase();
  if (DEEPEN_DYNAMICS.has(id)) return true;
  if (ESCALATE_DYNAMICS.has(id)) return false;
  return false;
}

export function hiddenIndexForRung(ladder, rungId) {
  const rung = (ladder || []).find((r) => r && r.id === rungId);
  if (!rung) return null;
  const idx = Number(rung.hiddenIndex);
  return Number.isInteger(idx) ? idx : (ladder || []).indexOf(rung);
}
