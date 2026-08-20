import TelegramBot from 'node-telegram-bot-api';

const TG_MAX = 4096;

function splitTelegramMessage(text) {
  const s = String(text || '');
  if (!s) return [];
  if (s.length <= TG_MAX) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > TG_MAX) {
    let cut = rest.lastIndexOf('\n', TG_MAX);
    if (cut < Math.floor(TG_MAX * 0.5)) cut = TG_MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendChunks(bot, chatId, text) {
  for (const chunk of splitTelegramMessage(text)) {
    await bot.sendMessage(chatId, chunk);
  }
}

/**
 * @param {{ config: object, app: object, storage: object }} opts
 */
export function startTelegramBot({ config, app, storage }) {
  const tg = config.telegram || {};
  if (!tg.enabled) {
    console.log('[telegram] disabled');
    return { stop() {}, enabled: false };
  }

  const tokenEnv = tg.tokenEnv || 'TELEGRAM_BOT_TOKEN';
  const token = process.env[tokenEnv];
  if (!token) {
    console.warn(`[telegram] ${tokenEnv} missing — bot not started`);
    return { stop() {}, enabled: false };
  }

  const bot = new TelegramBot(token, { polling: true });
  /** @type {Map<string, number|string>} */
  const chatByUser = new Map();

  async function rememberChat(userId, chatId) {
    const uid = String(userId);
    chatByUser.set(uid, chatId);
    try {
      const world = await storage.getWorld();
      let binding = await storage.getUserBinding(uid);
      if (!binding) {
        binding = {
          userId: uid,
          worldId: world.id,
          domainId: null,
          channel: 'telegram',
          telegramChatId: chatId,
          createdAt: new Date().toISOString(),
        };
      } else {
        binding.telegramChatId = chatId;
        binding.channel = binding.channel || 'telegram';
      }
      await storage.saveUserBinding(binding);
    } catch (err) {
      console.error('[telegram] rememberChat failed:', err.message);
    }
  }

  async function loadPersistedChats() {
    if (typeof storage.listUserBindings !== 'function') return;
    try {
      const bindings = await storage.listUserBindings();
      let n = 0;
      for (const b of bindings) {
        if (b?.telegramChatId != null && b.userId) {
          chatByUser.set(String(b.userId), b.telegramChatId);
          n += 1;
        }
      }
      if (n) console.log(`[telegram] restored ${n} chat mapping(s)`);
    } catch (err) {
      console.warn('[telegram] could not load chat mappings:', err.message);
    }
  }

  void loadPersistedChats();

  app.onOutbound(async ({ userId, message, channel }) => {
    if (channel && channel !== 'telegram') return;
    const chatId = chatByUser.get(String(userId));
    if (!chatId) return;
    try {
      await sendChunks(bot, chatId, message);
    } catch (err) {
      console.error('[telegram] outbound failed:', err.message);
    }
  });

  bot.on('message', async (msg) => {
    const raw = msg.text?.trim();
    if (!raw) return;

    const userId = String(msg.from.id);
    await rememberChat(userId, msg.chat.id);

    const isStart = /^\/start(?:@\w+)?(?:\s|$)/i.test(raw);
    const bootstrap = isStart;
    const payload = isStart ? '' : raw;

    try {
      await bot.sendChatAction(msg.chat.id, 'typing');
      const result = await app.handleUserMessage(userId, payload, {
        channel: 'telegram',
        bootstrap,
      });
      if (result.reply) {
        await sendChunks(bot, msg.chat.id, result.reply);
      }
    } catch (err) {
      console.error('[telegram] handler error:', err);
      await bot.sendMessage(msg.chat.id, 'Произошла ошибка. Попробуй ещё раз чуть позже.');
    }
  });

  console.log('[telegram] polling started');
  return {
    enabled: true,
    stop() {
      return bot.stopPolling();
    },
  };
}
