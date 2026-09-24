import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUSH_MAP_LIMIT,
  pushMap,
  rememberPush,
  findPush,
  replyFromTelegram,
  resolveReply,
  formatReplyForPrompt,
} from '../src/game/replyContext.js';

function domain() {
  return { id: 'd1', state: {} };
}

test('пуш запоминается вместе с игровыми ссылками', () => {
  const d = domain();
  const entry = rememberPush(d, {
    messageId: 501,
    chatId: 42,
    chronicleId: 'f7',
    plotId: 'p1',
    kind: 'threatFired',
  });
  assert.equal(entry.messageId, 501);
  assert.equal(findPush(d, 501).plotId, 'p1');
  assert.equal(findPush(d, '501').chronicleId, 'f7', 'id из телеграма приходит строкой');
  assert.equal(findPush(d, 999), null);
});

test('пуш без id сообщения не запоминается', () => {
  const d = domain();
  assert.equal(rememberPush(d, { chronicleId: 'f7' }), null);
  assert.equal(pushMap(d).length, 0);
});

test('повторная запись того же сообщения не плодит дублей', () => {
  const d = domain();
  rememberPush(d, { messageId: 1, plotId: 'p1' });
  rememberPush(d, { messageId: 1, plotId: 'p2' });
  assert.equal(pushMap(d).length, 1);
  assert.equal(findPush(d, 1).plotId, 'p2');
});

test('карта пушей не растёт вечно', () => {
  const d = domain();
  for (let i = 0; i < PUSH_MAP_LIMIT + 10; i += 1) rememberPush(d, { messageId: i, plotId: `p${i}` });
  assert.equal(pushMap(d).length, PUSH_MAP_LIMIT);
  assert.equal(findPush(d, 0), null, 'старое выпало');
  assert.ok(findPush(d, PUSH_MAP_LIMIT + 9), 'свежее на месте');
});

test('реплая нет — и контекста нет', () => {
  assert.equal(replyFromTelegram({ text: 'обычное сообщение' }), null);
  assert.equal(replyFromTelegram(null), null);
});

test('реплай на сообщение жреца распознаётся', () => {
  const reply = replyFromTelegram({
    text: 'укрепите её',
    reply_to_message: { message_id: 501, text: 'Северная опора треснула.', from: { is_bot: true } },
  });
  assert.equal(reply.messageId, 501);
  assert.equal(reply.text, 'Северная опора треснула.');
  assert.equal(reply.fromPriest, true);
});

test('реплай на свои же слова тоже читается, но без игровых ссылок', () => {
  const d = domain();
  rememberPush(d, { messageId: 77, plotId: 'p1' });
  const reply = replyFromTelegram({
    text: 'я про это',
    reply_to_message: { message_id: 77, text: 'пошлите казначея', from: { is_bot: false } },
  });
  const resolved = resolveReply(d, reply);
  assert.equal(resolved.fromPriest, false);
  assert.equal(resolved.plotId, null, 'по сообщению игрока карту пушей не читаем');
  assert.equal(resolved.text, 'пошлите казначея');
});

test('реплай разрешается в игровой объект, а не в текст', () => {
  const d = domain();
  rememberPush(d, { messageId: 501, chronicleId: 'f7', plotId: 'p1', threatId: 't3' });
  const resolved = resolveReply(
    d,
    replyFromTelegram({
      text: 'укрепите её',
      reply_to_message: { message_id: 501, text: 'Северная опора треснула.', from: { is_bot: true } },
    }),
  );
  assert.equal(resolved.plotId, 'p1');
  assert.equal(resolved.threatId, 't3');
  assert.equal(resolved.chronicleId, 'f7');
});

test('выпавшее из окна сообщение оставляет только текст', () => {
  const d = domain();
  const resolved = resolveReply(d, {
    messageId: 4,
    text: 'Северная опора треснула.',
    fromPriest: true,
  });
  assert.equal(resolved.text, 'Северная опора треснула.');
  assert.equal(resolved.plotId, null);
});

test('подпись фотографии тоже годится как цитата', () => {
  const reply = replyFromTelegram({
    text: 'красиво',
    reply_to_message: { message_id: 9, caption: 'Остров с северной стороны', from: { is_bot: true } },
  });
  assert.equal(reply.text, 'Остров с северной стороны');
});

test('блок для промпта отделяет цитату от нынешней реплики', () => {
  const text = formatReplyForPrompt({
    text: 'Северная опора треснула.',
    fromPriest: true,
    plotId: 'p1',
    processId: 'proc2',
  });
  assert.match(text, /Цитата:/);
  assert.match(text, /> Северная опора треснула\./);
  assert.match(text, /бери этот plotId/);
  assert.match(text, /Речь о деле proc2/);
  assert.match(text, /Цитата — не новая просьба/);
});

test('без реплая блок пустой', () => {
  assert.equal(formatReplyForPrompt(null), '');
  assert.equal(formatReplyForPrompt({ text: '' }), '');
});
