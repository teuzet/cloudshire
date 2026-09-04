import TelegramBot from 'node-telegram-bot-api';
import {
  closedTestReply,
  isForceTickCommand,
  isTelegramAllowed,
  isTelegramForceTickAllowed,
  islandNamesMatch,
  parseSlashCommand,
} from './access.js';
import { formatIslandPlotlines, formatIslandStats } from './views.js';
import { miniAppUrl, miniAppMenuText } from './initData.js';

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

function toOnboardingTelegramHtml(text) {
  let s = String(text || '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  s = s.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);)/gi, '&amp;');
  s = s.replace(/</g, (match, offset, whole) => {
    const rest = whole.slice(offset);
    if (/^<\/?(?:b|i|em|strong)>/i.test(rest)) return match;
    return '&lt;';
  });
  return s;
}

async function sendChunks(bot, chatId, text, { html = false } = {}) {
  const opts = html ? { parse_mode: 'HTML' } : undefined;
  for (const chunk of splitTelegramMessage(html ? toOnboardingTelegramHtml(text) : text)) {
    await bot.sendMessage(chatId, chunk, opts);
  }
}

/** @typedef {{ chatId: number|string, messageIds: number[] }} HoldRef */

export function rememberHoldMessage(holds, userId, chatId, messageId) {
  const uid = String(userId || '');
  const id = Number(messageId);
  if (!uid || !Number.isFinite(id)) return;
  const prev = holds.get(uid) || { chatId, messageIds: [] };
  prev.chatId = chatId;
  if (!prev.messageIds.includes(id)) prev.messageIds.push(id);
  holds.set(uid, prev);
}

export async function deleteRememberedHolds(bot, holds, userId) {
  const uid = String(userId || '');
  const prev = holds.get(uid);
  holds.delete(uid);
  if (!prev?.messageIds?.length || typeof bot?.deleteMessage !== 'function') return;
  for (const messageId of prev.messageIds) {
    try {
      await bot.deleteMessage(prev.chatId, messageId);
    } catch (err) {
      console.warn('[telegram] hold delete failed:', err.message);
    }
  }
}

function botCommandList(commands) {
  return (commands || [])
    .map((c) => ({
      command: String(c.command || '')
        .replace(/^\//, '')
        .trim()
        .toLowerCase(),
      description: String(c.description || '').trim().slice(0, 256),
    }))
    .filter((c) => c.command && c.description);
}

function uniqueChatIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const n = Number(raw);
    const id = Number.isFinite(n) && n !== 0 ? n : String(raw || '').trim();
    if (!id || seen.has(String(id))) continue;
    seen.add(String(id));
    out.push(id);
  }
  return out;
}

/**
 * Старые списки могли висеть в scope чата (/forcetick) и перекрывать дефолт.
 * Снимаем их и ставим один и тот же короткий список везде.
 */
async function syncBotMenu(bot, commands, chatIds = []) {
  const list = botCommandList(commands);
  if (!list.length) return;

  const scopes = [
    null,
    { type: 'all_private_chats' },
    { type: 'all_group_chats' },
    { type: 'all_chat_administrators' },
    ...uniqueChatIds(chatIds).map((chat_id) => ({ type: 'chat', chat_id })),
  ];

  for (const scope of scopes) {
    try {
      if (scope) {
        await bot.deleteMyCommands({ scope: JSON.stringify(scope) });
      }
    } catch (err) {
      console.warn('[telegram] deleteMyCommands failed:', err.message);
    }
    try {
      await bot.setMyCommands(list, scope ? { scope } : {});
    } catch (err) {
      console.warn('[telegram] setMyCommands failed:', err.message);
    }
  }
  console.log(`[telegram] menu: ${list.map((c) => `/${c.command}`).join(' ')}`);
}

async function syncMiniAppMenu(bot, config) {
  const url = miniAppUrl(config);
  const text = miniAppMenuText(config).slice(0, 16);
  if (!url) {
    console.log('[telegram] mini-app menu skipped: no TELEGRAM_MINI_APP_URL / RAILWAY_PUBLIC_DOMAIN');
    return;
  }
  try {
    await bot.setChatMenuButton({
      menu_button: { type: 'web_app', text, web_app: { url } },
    });
    console.log(`[telegram] mini-app menu: ${text} → ${url}`);
  } catch (err) {
    console.warn('[telegram] setChatMenuButton failed:', err.message);
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
      ? `Остров «${result.name}» уже идёт на сопряжение. Удалить его сейчас нельзя.`
      : `Остров «${result.name}» сейчас в сопряжении. Удалить его нельзя, пока острова не разойдутся.`;
  }
  if (result.reason === 'name_mismatch') {
    return `Имя не совпало с «${result.name}». Удаление отменено.`;
  }
  return 'Удаление не вышло. Попробуй ещё раз.';
}

/**
 * @param {{ config: object, app: object, storage: object }} opts
 */
export function startTelegramBot({ config, app, storage, runTick }) {
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
  void syncBotMenu(bot, tg.commands, [...(tg.allowIds || []), ...(tg.forceTickIds || [])])
    .then(() => syncMiniAppMenu(bot, config));
  /** @type {Map<string, number|string>} */
  const chatByUser = new Map();
  /** @type {Map<string, { name: string }>} */
  const pendingDelete = new Map();
  /** @type {Map<string, { chatId: number|string, messageId: number }>} */
  const editable = new Map();
  /** @type {Map<string, HoldRef>} */
  const holds = new Map();

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

  app.onOutbound(async ({ userId, message, channel, photoPath, photoBuffer, photoUrl, edit, kind, agent }) => {
    if (channel && channel !== 'telegram') return;
    const chatId = chatByUser.get(String(userId));
    if (!chatId) {
      console.warn(`[telegram] no chatId for ${userId}, drop ${kind || 'message'}`);
      return;
    }
    const html = agent === 'onboarding';
    const htmlOpts = html ? { parse_mode: 'HTML' } : {};
    const outboundText = html ? toOnboardingTelegramHtml(message) : message;
    try {
      if (kind === 'ruler_hold') {
        if (!outboundText) return;
        const sent = await bot.sendMessage(chatId, outboundText, htmlOpts);
        rememberHoldMessage(holds, userId, chatId, sent.message_id);
        return;
      }
      await deleteRememberedHolds(bot, holds, userId);
      if (edit && message) {
        const prev = editable.get(userId);
        if (prev) {
          try {
            await bot.editMessageText(outboundText, {
              chat_id: prev.chatId,
              message_id: prev.messageId,
              ...htmlOpts,
            });
          } catch (err) {
            if (!/message is not modified/i.test(err.message || '')) {
              const sent = await bot.sendMessage(chatId, outboundText, htmlOpts);
              editable.set(userId, { chatId, messageId: sent.message_id });
            }
          }
        } else {
          const sent = await bot.sendMessage(chatId, outboundText, htmlOpts);
          editable.set(userId, { chatId, messageId: sent.message_id });
        }
        if (kind === 'game_start' || kind === 'generating_error' || kind === 'island_reveal') {
          editable.delete(userId);
        }
        return;
      }
      if (kind === 'game_start' || kind === 'generating_error' || kind === 'island_reveal') {
        editable.delete(userId);
      }
      const photo = photoUrl || photoPath || photoBuffer;
      if (photo) {
        if (message) await sendChunks(bot, chatId, message, { html });
        await bot.sendPhoto(chatId, photo);
        return;
      }
      if (message) await sendChunks(bot, chatId, message, { html });
    } catch (err) {
      console.error('[telegram] outbound failed:', err.message);
      if ((photoUrl || photoPath || photoBuffer) && message) {
        try {
          await sendChunks(bot, chatId, message);
        } catch {
          /* already logged */
        }
      }
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

    if (command.name === 'city') {
      const url = miniAppUrl(config);
      if (!url) {
        return 'Информация о городе сейчас недоступна: у бота нет публичного адреса мини-аппки.';
      }
      await bot.sendMessage(chatId, 'Информация о городе — статы, истории, дела и указы.', {
        reply_markup: {
          inline_keyboard: [[{ text: miniAppMenuText(config), web_app: { url } }]],
        },
      });
      return null;
    }

    if (command.name === 'stats') {
      const { domain } = await app.loadOwnBoard(userId);
      if (!domain) return 'У тебя ещё нет острова.';
      return formatIslandStats(domain, config);
    }

    if (command.name === 'plotlines') {
      const { domain } = await app.loadOwnBoard(userId);
      if (!domain) return 'У тебя ещё нет острова.';
      return formatIslandPlotlines(domain);
    }

    if (isForceTickCommand(command)) {
      if (!isTelegramForceTickAllowed(config, userId)) return null;
      if (typeof runTick !== 'function') return 'Форс-тик сейчас недоступен.';
      if (app.isWorldTicking?.()) return 'Месяц уже крутится — подожди.';
      setImmediate(() => {
        Promise.resolve(runTick('telegram-force'))
          .then(() => {
            console.log('[telegram] forcetick done');
          })
          .catch((err) => {
            console.error('[telegram] forcetick failed:', err.message);
            bot.sendMessage(chatId, `Тик не вышел: ${err.message || err}`).catch(() => {});
          });
      });
      return 'Кручу месяц. Письмо придёт само, когда мир сдвинется.';
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
    if (
      command &&
      (['delete', 'stats', 'plotlines', 'city'].includes(command.name) ||
        (isForceTickCommand(command) && isTelegramForceTickAllowed(config, userId)))
    ) {
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
      await deleteRememberedHolds(bot, holds, userId);
      if (result.reply) {
        await sendChunks(bot, msg.chat.id, result.reply, { html: result.agent === 'onboarding' });
      }
    } catch (err) {
      console.error('[telegram] handler error:', err);
      await deleteRememberedHolds(bot, holds, userId);
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
