/**
 * Telegram-бот. Тонкий: сообщение → поток → ответ. Вести шлёт TelegramNotifier,
 * дни городов двигает таймер runDueCities.
 *
 *   TELEGRAM_BOT_TOKEN   — токен бота (обязателен)
 *   TELEGRAM_ALLOW_IDS   — через запятую: кому можно играть (пусто — всем)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY, MONGODB_URI или DATA_DIR — см. clients/app.ts
 */

import TelegramBot from 'node-telegram-bot-api';
import { sendText, TelegramNotifier } from '../../adapters/notifier/telegram.js';
import { onboardingMessage, resetPlayer, runGenesis } from '../../flows/onboarding.js';
import { patronMessage } from '../../flows/priest-turn.js';
import { runDueCities } from '../../flows/scheduler.js';
import { requireWorld, today } from '../../flows/context.js';
import { buildApp } from '../app.js';
import { cityStatus } from '../views.js';

const TICK_MS = 20_000;

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('нет TELEGRAM_BOT_TOKEN');
  const allow = new Set((process.env.TELEGRAM_ALLOW_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  const bot = new TelegramBot(token, { polling: true });
  const app = await buildApp(process.env, new TelegramNotifier(bot));
  const { deps, locks } = app;
  const busy = new Set<string>();

  async function startGenesis(ownerId: string, chatId: number): Promise<void> {
    await bot.sendChatAction(chatId, 'typing');
    const city = await runGenesis(deps, ownerId);
    if (city) await sendText(bot, chatId, '<i>Город поднялся. Отвечай жрецу прямо здесь.</i>', true);
  }

  async function handle(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const ownerId = String(msg.from?.id ?? '');
    const text = (msg.text ?? '').trim();
    if (!ownerId || msg.chat.type !== 'private') return;
    if (allow.size && !allow.has(ownerId)) return void (await bot.sendMessage(chatId, 'Игра пока закрыта.'));

    if (text === '/reset') return void (await bot.sendMessage(chatId, 'Город и вся его память исчезнут. Если точно — напиши /reset да'));
    if (text === '/reset да') {
      await resetPlayer(deps, ownerId);
      await bot.sendMessage(chatId, 'Всё стёрто.');
      const r = await onboardingMessage(deps, { ownerId, text: '' });
      if (r.kind === 'reply') await sendText(bot, chatId, r.text, true);
      return;
    }
    if (text === '/city') {
      const city = await deps.storage.getCityByOwner(ownerId);
      const world = await requireWorld(deps);
      return void (await bot.sendMessage(chatId, city ? cityStatus(deps.rules, city, today(deps, world)) : 'Города ещё нет.'));
    }

    await bot.sendChatAction(chatId, 'typing');
    if (await deps.storage.getCityByOwner(ownerId)) {
      const quote = msg.reply_to_message?.text ?? null;
      const r = await patronMessage(deps, locks, { ownerId, text, quote });
      if (r.kind !== 'no_city') await sendText(bot, chatId, r.text);
      return;
    }
    const r = await onboardingMessage(deps, { ownerId, text: text === '/start' ? '' : text });
    if (r.kind === 'reply' || r.kind === 'busy') await sendText(bot, chatId, r.text, r.kind === 'reply');
    if (r.kind === 'reply' && r.ready) await startGenesis(ownerId, chatId);
  }

  bot.on('message', (msg) => {
    const key = String(msg.from?.id ?? '');
    if (busy.has(key)) return void bot.sendMessage(msg.chat.id, 'Жрец ещё отвечает на прошлое слово.');
    busy.add(key);
    handle(msg)
      .catch((err) => console.error('[telegram]', err))
      .finally(() => busy.delete(key));
  });

  let ticking = false;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    runDueCities(deps, locks)
      .catch((err) => console.error('[tick]', err))
      .finally(() => (ticking = false));
  }, TICK_MS);

  const stop = async () => {
    await bot.stopPolling();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log('cloudshire: бот запущен');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
