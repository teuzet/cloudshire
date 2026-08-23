import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTrailingUnansweredNews,
  shouldAskPatronPresence,
  shouldRunSteward,
  markPatronPresenceAsked,
  clearPatronPresenceAsked,
} from '../src/game/steward.js';

function news(n) {
  return Array.from({ length: n }, () => ({ role: 'assistant', kind: 'tick_news' }));
}

const cfg = { tick: { steward: { loseAfterLetters: 2, afterSilentMonths: 3 } } };

test('молчание считает только письма месяца до ответа игрока', () => {
  assert.equal(countTrailingUnansweredNews(news(2)), 2);
  assert.equal(
    countTrailingUnansweredNews([...news(3), { role: 'user', content: 'я здесь' }, ...news(1)]),
    1,
  );
});

test('стюард молчит первые три письма и включается с четвёртого месяца', () => {
  const domain = (silent) => ({
    characters: [{ dialogHistory: news(silent) }],
  });
  assert.equal(shouldRunSteward(domain(0), cfg).ok, false);
  assert.equal(shouldRunSteward(domain(2), cfg).ok, false);
  assert.equal(shouldRunSteward(domain(3), cfg).ok, true);
  assert.equal(shouldRunSteward(domain(5), cfg).ok, true);
});

test('вопрос «куда делся» один раз после двух писем, даже если окно уже проскочили', () => {
  const fresh = { characters: [{ dialogHistory: news(2) }], state: {} };
  assert.equal(shouldAskPatronPresence(fresh, cfg).ok, true);
  const late = { characters: [{ dialogHistory: news(6) }], state: {} };
  assert.equal(shouldAskPatronPresence(late, cfg).ok, true);
  markPatronPresenceAsked(late);
  assert.equal(shouldAskPatronPresence(late, cfg).ok, false);
  clearPatronPresenceAsked(late);
  assert.equal(shouldAskPatronPresence(late, cfg).ok, true);
});

test('ответ игрока сразу гасит стюарда', () => {
  const domain = {
    characters: [
      {
        dialogHistory: [...news(4), { role: 'user', content: 'слышу' }],
      },
    ],
  };
  assert.equal(shouldRunSteward(domain, cfg).ok, false);
});
