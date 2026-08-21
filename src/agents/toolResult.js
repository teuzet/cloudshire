/**
 * Единый отказ tool для LLM-агента: машинный код + понятный текст.
 * @param {string} error короткий код или метка (too_short, process_not_found, …)
 * @param {string} agentMessage что не так и что сделать дальше
 * @param {Record<string, unknown>} [extra]
 */
export function toolFail(error, agentMessage, extra = {}) {
  const code = String(error || 'error');
  const message = String(agentMessage || code);
  return { ok: false, error: code, agentMessage: message, ...extra };
}
