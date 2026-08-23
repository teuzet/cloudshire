#!/usr/bin/env node
/**
 * Разослать всем игрокам в Telegram одно сообщение.
 * Берёт MONGODB_URI / MONGODB_DB / TELEGRAM_BOT_TOKEN из окружения.
 *
 *   node utils/announce-pause.mjs            # кому уйдёт (dry run)
 *   node utils/announce-pause.mjs --yes      # отправить
 *   node utils/announce-pause.mjs --only 123 --yes
 */

import { MongoClient } from 'mongodb';

const MESSAGE = `Останавливаю бота.

Спасибо, всем кто принял участие!
Получил много информации, есть много идей о том, как сделать лучше.
Через недельку-другую попробуем устроить новый пробный прогон.

В следующей версии будет улучшенная работа с сюжетными линиями и более яркие стыковки островов.

Если хотите поучаствовать - забегайте в канал t.me/cloudshire, объявление будет там.`;

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? String(args[i + 1] || '').trim() : '';
})();

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || 'cloudshire';
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!uri) {
  console.error('Нет MONGODB_URI.');
  process.exit(1);
}
if (apply && !token) {
  console.error('Нет TELEGRAM_BOT_TOKEN: без токена отправить нельзя.');
  process.exit(1);
}

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body.description || res.statusText || `HTTP ${res.status}`);
  }
}

const client = new MongoClient(uri);
await client.connect();
try {
  const users = await client.db(dbName).collection('users').find({}).toArray();
  const chats = [
    ...new Set(
      users
        .map((u) => (u.telegramChatId != null ? String(u.telegramChatId) : null))
        .filter(Boolean)
        .filter((id) => !only || id === only),
    ),
  ];

  if (!chats.length) {
    console.error(only ? `чат ${only} не найден` : 'нет telegramChatId');
    process.exit(1);
  }

  console.log(`игроков: ${chats.length}`);
  if (!apply) {
    console.log('(dry run: ничего не отправлено, добавь --yes)');
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  for (const chatId of chats) {
    try {
      await sendTelegram(chatId, MESSAGE);
      ok += 1;
      console.log(`отправлено ${chatId}`);
    } catch (err) {
      failed += 1;
      console.error(`ошибка ${chatId}: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  console.log(`готово: ${ok} ок, ${failed} ошибок`);
  if (failed) process.exit(1);
} finally {
  await client.close();
}
