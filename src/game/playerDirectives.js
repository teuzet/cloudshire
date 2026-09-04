/**
 * Нормализованный слой поверх сырого playerBrief.
 */

export function emptyPlayerDirectives() {
  return {
    required: [],
    preferred: [],
    forbidden: [],
    unresolvedConflicts: [],
  };
}

function clipLine(s, max = 400) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

function asList(raw) {
  if (Array.isArray(raw)) return raw.map((x) => clipLine(x)).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return [clipLine(raw)];
  return [];
}

export function normalizePlayerDirectives(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const conflicts = Array.isArray(src.unresolvedConflicts)
    ? src.unresolvedConflicts
        .map((c) => {
          if (!c || typeof c !== 'object') return null;
          const requested = clipLine(c.requested || c.requestedText);
          const reason = clipLine(c.reason);
          if (!requested && !reason) return null;
          return {
            requested: requested || '—',
            reason: reason || '',
            adaptations: asList(c.adaptations),
            resolved: Boolean(c.resolved),
            id: c.id ? String(c.id) : null,
          };
        })
        .filter(Boolean)
    : [];
  return {
    required: asList(src.required),
    preferred: asList(src.preferred),
    forbidden: asList(src.forbidden),
    unresolvedConflicts: conflicts.filter((c) => !c.resolved),
  };
}

export function mergePlayerDirectives(base, patch = {}) {
  const a = normalizePlayerDirectives(base);
  const b = normalizePlayerDirectives(patch);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  return normalizePlayerDirectives({
    required: uniq([...a.required, ...b.required]),
    preferred: uniq([...a.preferred, ...b.preferred]),
    forbidden: uniq([...a.forbidden, ...b.forbidden]),
    unresolvedConflicts: [...a.unresolvedConflicts, ...b.unresolvedConflicts],
  });
}

const CANON_PREFIXES = {
  cityName: /^имя города\b/i,
  patronName: /^имя покровителя\b/i,
  patronGender: /^пол покровителя\b/i,
};

function replacePrefixed(list, re, line) {
  const filtered = (list || []).filter((x) => !re.test(x));
  return line ? [...filtered, line] : filtered;
}

/** Имя / пол / канон — текущие значения: смена затирает старую строку. */
export function upsertCanonicalDirectives(dirs, { cityName, patronName, patronGender } = {}) {
  const next = normalizePlayerDirectives(dirs);
  if (cityName) {
    next.required = replacePrefixed(next.required, CANON_PREFIXES.cityName, `имя города: ${cityName}`);
  }
  if (patronName) {
    next.required = replacePrefixed(next.required, CANON_PREFIXES.patronName, `имя покровителя: ${patronName}`);
  }
  if (patronGender === 'male' || patronGender === 'female') {
    next.required = replacePrefixed(
      next.required,
      CANON_PREFIXES.patronGender,
      `пол покровителя: ${patronGender === 'female' ? 'женщина' : 'мужчина'}`,
    );
  }
  return next;
}

export function addDirective(dirs, kind, text) {
  const next = normalizePlayerDirectives(dirs);
  const line = clipLine(text);
  if (!line) return next;
  if (kind === 'required' || kind === 'preferred' || kind === 'forbidden') {
    if (!next[kind].includes(line)) next[kind].push(line);
  }
  return next;
}

export function hasUnresolvedConflicts(dirs) {
  return normalizePlayerDirectives(dirs).unresolvedConflicts.length > 0;
}

export function recordCosmologyConflicts(dirs, conflicts = []) {
  const next = normalizePlayerDirectives(dirs);
  for (const c of conflicts) {
    const row = {
      requested: clipLine(c.requested) || '—',
      reason: clipLine(c.reason),
      adaptations: asList(c.adaptations),
      resolved: false,
    };
    const dup = next.unresolvedConflicts.some(
      (x) => x.requested === row.requested && x.reason === row.reason,
    );
    if (!dup) next.unresolvedConflicts.push(row);
  }
  return next;
}

export function resolveCosmologyConflict(dirs, { requested, chosenAdaptation, drop } = {}) {
  const next = normalizePlayerDirectives(dirs);
  const key = clipLine(requested);
  const hit = next.unresolvedConflicts.find((c) => c.requested === key || (!key && c === next.unresolvedConflicts[0]));
  if (!hit) return next;
  next.unresolvedConflicts = next.unresolvedConflicts.filter((c) => c !== hit);
  if (drop) {
    if (hit.requested && hit.requested !== '—') next.forbidden = [...new Set([...next.forbidden, hit.requested])];
    return next;
  }
  const keep = clipLine(chosenAdaptation) || hit.adaptations[0] || '';
  if (keep) next.required = [...new Set([...next.required, keep])];
  return next;
}

export function formatPlayerDirectivesForPrompt(dirs) {
  const d = normalizePlayerDirectives(dirs);
  const lines = ['PLAYER DIRECTIVES:'];
  lines.push(d.required.length ? `REQUIRED:\n${d.required.map((x) => `- ${x}`).join('\n')}` : 'REQUIRED: (нет)');
  lines.push(d.preferred.length ? `PREFERRED:\n${d.preferred.map((x) => `- ${x}`).join('\n')}` : 'PREFERRED: (нет)');
  lines.push(d.forbidden.length ? `FORBIDDEN:\n${d.forbidden.map((x) => `- ${x}`).join('\n')}` : 'FORBIDDEN: (нет)');
  if (d.unresolvedConflicts.length) {
    lines.push('UNRESOLVED CONFLICTS:');
    for (const c of d.unresolvedConflicts) {
      lines.push(`- «${c.requested}»: ${c.reason}`);
      for (const a of c.adaptations) lines.push(`    можно: ${a}`);
    }
  }
  return lines.join('\n');
}
