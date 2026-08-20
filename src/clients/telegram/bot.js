import TelegramBot from 'node-telegram-bot-api';

export function startTelegramBot({ config, app }) {
  if (!config.telegram?.enabled) {
    console.log('[telegram] disabled in config');
    return { stop() {} };
  }

  const tokenEnv = config.telegram.tokenEnv || 'TELEGRAM_BOT_TOKEN';
  const token = process.env[tokenEnv];
  if (!token) {
    console.warn(`[telegram] ${tokenEnv} missing — bot not started`);
    return { stop() {} };
  }

  const bot = new TelegramBot(token, { polling: true });
  const chatByUser = new Map();

  app.onOutbound(async ({ userId, message }) => {
    const chatId = chatByUser.get(String(userId));
    if (!chatId) return;
    try {
      await bot.sendMessage(chatId, message);
    } catch (err) {
      console.error('[telegram] outbound failed:', err.message);
    }
  });

  bot.on('message', async (msg) => {
    const text = msg.text?.trim();
    if (!text) return;
    const userId = String(msg.from.id);
    chatByUser.set(userId, msg.chat.id);

    try {
      await bot.sendChatAction(msg.chat.id, 'typing');
      const result = await app.handleUserMessage(userId, text, { channel: 'telegram' });
      if (result.reply) {
        await bot.sendMessage(msg.chat.id, result.reply);
      }
    } catch (err) {
      console.error('[telegram] handler error:', err);
      await bot.sendMessage(msg.chat.id, 'Произошла ошибка. Попробуй ещё раз чуть позже.');
    }
  });

  console.log('[telegram] polling started');
  return {
    stop() {
      return bot.stopPolling();
    },
  };
}
