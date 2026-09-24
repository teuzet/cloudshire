/**
 * Реплаи в Telegram.
 *
 * Игрок отвечает на конкретное сообщение — жрец должен понимать, на какое.
 * Причём разрешать реплай надо не в текст, а в игровой объект: ответил на
 * сообщение про обвал — значит, `plotId` уже известен и угадывать нечего.
 *
 * Поэтому при отправке пуша мы запоминаем соответствие
 * `message_id → { chronicleId, plotId, threatId }`.
 */

/** Держим последние N отправленных сообщений: глубже игрок не отвечает. */
export const PUSH_MAP_LIMIT = 60;

export function pushMap(domain) {
  if (!domain.state) domain.state = {};
  if (!Array.isArray(domain.state.pushMap)) domain.state.pushMap = [];
  return domain.state.pushMap;
}

export function rememberPush(
  domain,
  { messageId, chatId = null, chronicleId = null, plotId = null, threatId = null, processId = null, kind = null, text = null } = {},
) {
  const id = Number(messageId);
  if (!Number.isFinite(id)) return null;
  const map = pushMap(domain);
  const entry = {
    messageId: id,
    chatId: chatId == null ? null : String(chatId),
    chronicleId: chronicleId || null,
    plotId: plotId || null,
    threatId: threatId || null,
    processId: processId || null,
    kind: kind || null,
    text: text ? String(text).slice(0, 1500) : null,
  };
  const existing = map.findIndex((e) => e.messageId === id);
  if (existing >= 0) map.splice(existing, 1);
  map.push(entry);
  if (map.length > PUSH_MAP_LIMIT) map.splice(0, map.length - PUSH_MAP_LIMIT);
  return entry;
}

export function findPush(domain, messageId) {
  const id = Number(messageId);
  if (!Number.isFinite(id)) return null;
  return pushMap(domain).find((e) => e.messageId === id) || null;
}

/**
 * Достать реплай из апдейта Telegram. Ответ на своё же сообщение игнорируем:
 * цитировать себя жрецу нечего.
 */
export function replyFromTelegram(msg) {
  const quoted = msg?.reply_to_message;
  if (!quoted) return null;
  const text = String(quoted.text || quoted.caption || '').trim();
  const fromBot = !!quoted.from?.is_bot;
  if (!text && !fromBot) return null;
  return {
    messageId: Number(quoted.message_id) || null,
    text: text.slice(0, 1500),
    fromPriest: fromBot,
  };
}

/**
 * Свести реплай с запомненным пушем. `text` есть всегда, игровые ссылки —
 * только если сообщение наше и ещё не выпало из окна.
 */
export function resolveReply(domain, reply) {
  if (!reply?.text && !reply?.messageId) return null;
  const push = reply.fromPriest ? findPush(domain, reply.messageId) : null;
  return {
    text: reply.text || push?.text || '',
    fromPriest: !!reply.fromPriest,
    chronicleId: push?.chronicleId || null,
    plotId: push?.plotId || null,
    threatId: push?.threatId || null,
    processId: push?.processId || null,
    kind: push?.kind || null,
  };
}

/**
 * Блок для промпта жреца. Отдельный блок, а не склейка с репликой игрока:
 * иначе модель начнёт отвечать на цитату вместо самого вопроса.
 */
export function formatReplyForPrompt(resolved) {
  if (!resolved?.text && !resolved?.plotId) return '';
  const lines = ['Покровитель отвечает на это сообщение. Цитата:'];
  if (resolved.text) {
    for (const line of String(resolved.text).split('\n')) lines.push(`> ${line}`);
  }
  if (resolved.plotId) lines.push(`Речь об истории ${resolved.plotId}. Ставя дело, бери этот plotId.`);
  if (resolved.processId) lines.push(`Речь о деле ${resolved.processId}.`);
  lines.push('Цитата — не новая просьба. Отвечай на то, что покровитель написал сейчас, держа в уме процитированное.');
  return lines.join('\n');
}
