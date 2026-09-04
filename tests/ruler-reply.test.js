import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulerReplyCommitError } from '../src/game/app.js';

test('приказ без действия — ошибка; уточняющий вопрос — можно', () => {
  const ignored = rulerReplyCommitError({
    requestKind: 'order_long',
    commitment: 'none',
    text: 'Будет сделано.',
  });
  assert.equal(ignored?.error, 'order_ignored');

  const asked = rulerReplyCommitError({
    requestKind: 'order_long',
    commitment: 'clarify',
    text: 'Покровитель, это разовое поручение или отныне так всегда? Кого слать?',
  });
  assert.equal(asked, null);

  const leaveIt = rulerReplyCommitError({
    requestKind: 'smalltalk',
    commitment: 'none',
    text: 'Пусть сами справятся с канавой.',
  });
  assert.equal(leaveIt, null);
});

test('уточнение без вопроса или после уже заведённого дела — нельзя', () => {
  const noQ = rulerReplyCommitError({
    requestKind: 'order_long',
    commitment: 'clarify',
    text: 'Подумаю, как исполнить.',
  });
  assert.equal(noQ?.error, 'clarify_no_question');

  const after = rulerReplyCommitError({
    requestKind: 'order_long',
    commitment: 'clarify',
    text: 'Кого слать?',
    okTools: new Set(['declare_process']),
  });
  assert.equal(after?.error, 'clarify_after_act');

  const chat = rulerReplyCommitError({
    requestKind: 'smalltalk',
    commitment: 'clarify',
    text: 'Как дела?',
  });
  assert.equal(chat?.error, 'clarify_not_order');
});

test('невозможный приказ нельзя «уточнить»', () => {
  const err = rulerReplyCommitError({
    requestKind: 'order_impossible',
    commitment: 'clarify',
    text: 'Как именно воскресить?',
  });
  assert.equal(err?.error, 'impossible_not_refused');
});
