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
