import TelegramBot from 'node-telegram-bot-api';
import {
  closedTestReply,
  isTelegramAllowed,
  islandNamesMatch,
  parseSlashCommand,
} from './access.js';
import { formatIslandPlotlines, formatIslandStats } from './views.js';

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

function deleteAskText(name) {
  return (
    `Чтобы удалить остров «${name}», напиши его имя точно так. ` +
    'Это необратимо: город, хроника и истории пропадут. /start после этого начнёт новый остров.'
  );
}

function deleteFailText(result) {
  if (result.reason === 'no_island') return 'У тебя ещё нет острова.';
  if (result.reason === 'generating') {
    return 'Остров ещё создаётся — подожди, потом удаляй.';
  }
  if (result.reason === 'conflux') {
    return result.status === 'approaching'
      ? `Остров «${result.name}» уже идёт на стык. Удалить его сейчас нельзя.`
      : `Остров «${result.name}» сейчас в стыке. Удалить его нельзя, пока острова не разойдутся.`;
  }
  if (result.reason === 'name_mismatch') {
    return `Имя не совпало с «${result.name}». Удаление отменено.`;
  }
  return 'Удаление не вышло. Попробуй ещё раз.';
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
  /** @type {Map<string, { name: string }>} */
  const pendingDelete = new Map();

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

  async function handleCommand(userId, chatId, command) {
    if (command.name === 'delete') {
      const preview = await app.deleteOwnDomain(userId, null);
      if (preview.reason === 'need_confirm') {
        if (command.arg) {
          const done = await app.deleteOwnDomain(userId, command.arg);
          pendingDelete.delete(userId);
          if (done.ok) {
            return `Остров «${done.name}» удалён. Напиши /start, чтобы создать новый.`;
          }
          return deleteFailText(done);
        }
        pendingDelete.set(userId, { name: preview.name });
        return deleteAskText(preview.name);
      }
      pendingDelete.delete(userId);
      return deleteFailText(preview);
    }

    pendingDelete.delete(userId);

    if (command.name === 'stats') {
      const domain = await app.getOwnDomain(userId);
      if (!domain) return 'У тебя ещё нет острова.';
      return formatIslandStats(domain, config);
    }

    if (command.name === 'plotlines') {
      const domain = await app.getOwnDomain(userId);
      if (!domain) return 'У тебя ещё нет острова.';
      return formatIslandPlotlines(domain);
    }

    return null;
  }

  bot.on('message', async (msg) => {
    const raw = msg.text?.trim();
    if (!raw) return;

    const userId = String(msg.from.id);
    if (!isTelegramAllowed(config, userId)) {
      await bot.sendMessage(msg.chat.id, closedTestReply(config));
      return;
    }

    await rememberChat(userId, msg.chat.id);

    const command = parseSlashCommand(raw);
    if (command && ['delete', 'stats', 'plotlines'].includes(command.name)) {
      try {
        await bot.sendChatAction(msg.chat.id, 'typing');
        const reply = await handleCommand(userId, msg.chat.id, command);
        if (reply) await sendChunks(bot, msg.chat.id, reply);
      } catch (err) {
        console.error('[telegram] command error:', err);
        await bot.sendMessage(msg.chat.id, 'Произошла ошибка. Попробуй ещё раз чуть позже.');
      }
      return;
    }

    const pending = pendingDelete.get(userId);
    if (pending && !command) {
      pendingDelete.delete(userId);
      try {
        await bot.sendChatAction(msg.chat.id, 'typing');
        if (!islandNamesMatch(pending.name, raw)) {
          await sendChunks(bot, msg.chat.id, deleteFailText({ reason: 'name_mismatch', name: pending.name }));
          return;
        }
        const done = await app.deleteOwnDomain(userId, raw);
        if (done.ok) {
          await sendChunks(bot, msg.chat.id, `Остров «${done.name}» удалён. Напиши /start, чтобы создать новый.`);
        } else {
          await sendChunks(bot, msg.chat.id, deleteFailText(done));
        }
      } catch (err) {
        console.error('[telegram] delete confirm error:', err);
        await bot.sendMessage(msg.chat.id, 'Произошла ошибка. Попробуй ещё раз чуть позже.');
      }
      return;
    }

    const isStart = command?.name === 'start';
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
