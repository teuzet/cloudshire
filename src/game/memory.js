/**
 * Долгая память без раздувания промптов:
 * - сырая хроника в lore не трогается;
 * - в LLM: rolling digest старых месяцев + хвост recent;
 * - плотлайны — короткие rolling summary (режиссёр переписывает).
 */

import { chronicleEntries, loreToPromptText } from './models.js';

export function memoryConfig(config) {
  const m = config?.tick?.memory || {};
  return {
    chronicleRecent: m.chronicleRecent ?? 15,
    chronicleDigestMaxLines: m.chronicleDigestMaxLines ?? 20,
    dialogPromptMessages: m.dialogPromptMessages ?? 16,
    compressTickNewsOlderThan: m.compressTickNewsOlderThan ?? 2,
  };
}

function oneLine(text, max = 110) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Пересобрать chronicleDigest из записей старше хвоста recent.
 * Оригиналы в lore остаются.
 */
export function refreshChronicleDigest(domain, config = null) {
  if (!domain || typeof domain !== 'object') return domain;
  const { chronicleRecent, chronicleDigestMaxLines } = memoryConfig(config);
  const chron = chronicleEntries(domain.lore || []);
  if (chron.length <= chronicleRecent) {
    domain.chronicleDigest = domain.chronicleDigest || '';
    return domain;
  }
  const older = chron.slice(0, -chronicleRecent);
  const lines = older.map((e) => {
    const label = e.gameDateLabel || `тик ${e.tick ?? '?'}`;
    return `${label}: ${oneLine(e.text, 100)}`;
  });
  domain.chronicleDigest = lines.slice(-chronicleDigestMaxLines).join('\n');
  const lastOlder = older[older.length - 1];
  domain.chronicleDigestThroughTick =
    lastOlder?.tick != null ? Number(lastOlder.tick) : null;
  return domain;
}

/** Контекст хроники для резолвера / лормастера / режиссёра. */
export function formatChroniclePromptBlock(domain, config = null) {
  const { chronicleRecent } = memoryConfig(config);
  refreshChronicleDigest(domain, config);
  const chron = chronicleEntries(domain.lore || []);
  const recent = chron.slice(-chronicleRecent);
  const digest = String(domain.chronicleDigest || '').trim();
  const parts = [];
  if (digest) {
    parts.push('СВОДКА СТАРОЙ ХРОНИКИ (сжато; полные записи хранятся в лоре):');
    parts.push(digest);
  }
  parts.push(
    recent.length
      ? `НЕДАВНЯЯ ХРОНИКА (последние ${recent.length}):\n${loreToPromptText(recent)}`
      : 'НЕДАВНЯЯ ХРОНИКА: (пусто)',
  );
  return parts.join('\n\n');
}

/**
 * Хроника для лормастера: часть фактов выводится только из истории событий,
 * поэтому дайджеста мало. Отдаём всё, что влезает в бюджет символов:
 * свежие записи подробно, старые сжато, важные (critical/major) не выбрасываем.
 */
export function formatFullChronicleForPrompt(
  domain,
  { maxChars = 14000, recentFull = 25, perEntryFull = 220, perEntryOld = 110 } = {},
) {
  const chron = chronicleEntries(domain.lore || []);
  if (!chron.length) return '(хроника пуста)';

  const line = (e, max) => {
    const label = e.gameDateLabel || `тик ${e.tick ?? '?'}`;
    const imp = e.importance && e.importance !== 'minor' ? ` {${e.importance}}` : '';
    return `${label}${imp}: ${oneLine(e.text, max)}`;
  };

  const recent = chron.slice(-recentFull);
  const older = chron.slice(0, Math.max(0, chron.length - recentFull));
  const recentLines = recent.map((e) => line(e, perEntryFull));
  let budget = maxChars - recentLines.reduce((a, s) => a + s.length + 1, 0);

  // Сначала важное (оно держит канон), потом мелочи — и то и другое от новых к старым.
  const kept = new Map();
  const take = (entries, max) => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      const idx = older.indexOf(e);
      if (kept.has(idx)) continue;
      const text = line(e, max);
      if (text.length + 1 > budget) continue;
      kept.set(idx, text);
      budget -= text.length + 1;
    }
  };

  const important = older.filter(
    (e) => e.importance === 'critical' || e.importance === 'major',
  );
  take(important, perEntryOld + 60);
  take(older, perEntryOld);

  const olderLines = [...kept.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text);
  const dropped = older.length - olderLines.length;

  const head =
    `ХРОНИКА (${chron.length} записей` +
    (dropped ? `, ${dropped} мелких старых опущено` : ' — целиком') +
    ', от старых к новым):';
  return [head, ...olderLines, ...recentLines].join('\n');
}

/** Только устойчивые fact-записи (не chronicle, не снятые) — для лормастера. */
export function formatFactsForPrompt(lore = [], { limit = 40 } = {}) {
  const facts = (lore || []).filter((f) => {
    const tags = f.tags || [];
    if (f.retiredAt) return false;
    return tags.includes('fact') && !tags.includes('chronicle');
  });
  const slice = facts.slice(-limit);
  if (!slice.length) return '(устойчивых фактов пока мало — смотри описание и хронику)';
  return loreToPromptText(slice);
}

/**
 * История для промпта правителя: старые tick_news сжимаем, оригинал в dialogHistory целый.
 */
export function dialogHistoryForPrompt(dialogHistory = [], config = null) {
  const { dialogPromptMessages, compressTickNewsOlderThan } = memoryConfig(config);
  const slice = (dialogHistory || []).slice(-dialogPromptMessages);
  return slice.map((m, idx) => {
    const ageFromEnd = slice.length - 1 - idx;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content = String(m.content || '');
    if (m.kind === 'tick_news' && ageFromEnd >= compressTickNewsOlderThan) {
      content = `[письмо о месяце, сжато] ${oneLine(content, 180)}`;
    }
    return { role, content };
  });
}
