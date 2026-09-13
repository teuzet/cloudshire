import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulerReplyCommitError } from '../src/game/app.js';
import { submitReplyTool } from '../src/game/rulerTools.js';

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

test('вопрос нельзя закрыть формулой «приказа не было»', () => {
  const dodge = rulerReplyCommitError({
    requestKind: 'question',
    commitment: 'none',
    text: 'Орион, я услышал тебя. Твоё слово принято; нового приказа о восточном дереве ты пока не отдавал.',
  });
  assert.equal(dodge?.error, 'question_unanswered');

  const answered = rulerReplyCommitError({
    requestKind: 'question',
    commitment: 'none',
    text:
      'Орион, этого мы пока не знаем. На восточном дереве кора сочится густой тёмной смолой с резким запахом, ' +
      'а у работавших рядом немеют пальцы и портится зрение.',
  });
  assert.equal(answered, null);
});

test('submit_reply не пропускает слив скрытой причины', async () => {
  const turn = { okTools: new Set() };
  const tool = submitReplyTool(turn, { name: 'Елвор' }, {
    plots: [
      {
        synopsis: 'Из коры течёт густая тёмная смола, у смолокуров немеют пальцы.',
        hiddenAnswer: 'Мелкие паразитические насекомые выходят из-под коры.',
        hiddenPremises: [],
      },
    ],
    userText: 'Что за больное сочение?',
  });
  const leak = await tool.handler({
    text: 'Причину не установили. О насекомых там ничего не знаем.',
    requestKind: 'question',
    commitment: 'none',
  });
  assert.equal(leak.ok, false);
  assert.equal(leak.error, 'hidden_leak');

  const ok = await tool.handler({
    text: 'Это густая тёмная смола из коры. Причину мы пока не установили.',
    requestKind: 'question',
    commitment: 'none',
  });
  assert.equal(ok.ok, true);
});
