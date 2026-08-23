export function isTelegramAllowed(config, telegramId) {
  const ids = config?.telegram?.allowIds;
  if (!Array.isArray(ids) || !ids.length) return true;
  return ids.map(String).includes(String(telegramId));
}

export function closedTestReply(config) {
  return (
    config?.telegram?.closedTestReply ||
    'Сейчас идёт закрытый тест. Если тебя ждали — напиши тому, кто пригласил.'
  );
}

export function islandNamesMatch(a, b) {
  const n = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const left = n(a);
  const right = n(b);
  return Boolean(left && left === right);
}

export function parseSlashCommand(raw) {
  const m = String(raw || '')
    .trim()
    .match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: (m[2] || '').trim() };
}

export function islandDeleteCheck({ domain, conflux, confirmName }) {
  if (!domain) return { ok: false, reason: 'no_island' };
  if (conflux) {
    return { ok: false, reason: 'conflux', status: conflux.status, name: domain.name };
  }
  if (confirmName == null || String(confirmName).trim() === '') {
    return { ok: false, reason: 'need_confirm', name: domain.name };
  }
  if (!islandNamesMatch(domain.name, confirmName)) {
    return { ok: false, reason: 'name_mismatch', name: domain.name };
  }
  return { ok: true, name: domain.name };
}
