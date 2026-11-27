/**
 * Вести в Telegram. ownerId игрока — его user id; в личке chat id тот же.
 */

import type TelegramBot from 'node-telegram-bot-api';
import type { Notifier, OutboundMessage } from '../../ports/notifier.js';

const TG_MAX = 4000;

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function splitForTelegram(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > TG_MAX) {
    let cut = rest.lastIndexOf('\n', TG_MAX);
    if (cut < TG_MAX / 2) cut = rest.lastIndexOf(' ', TG_MAX);
    if (cut < TG_MAX / 2) cut = TG_MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendText(bot: TelegramBot, chatId: string | number, text: string, html = false): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    await bot.sendMessage(chatId, chunk, html ? { parse_mode: 'HTML' } : {});
  }
}

export class TelegramNotifier implements Notifier {
  constructor(private readonly bot: TelegramBot) {}

  async send(message: OutboundMessage): Promise<void> {
    // Сообщения системы идут курсивом, речь жреца — обычным текстом.
    if (message.kind === 'system') {
      for (const chunk of splitForTelegram(message.text)) await this.bot.sendMessage(message.ownerId, `<i>${escapeHtml(chunk)}</i>`, { parse_mode: 'HTML' });
      return;
    }
    await sendText(this.bot, message.ownerId, message.text);
  }
}
