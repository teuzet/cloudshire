import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProgressBar } from '../src/game/progressBar.js';

test('полоска генезиса растёт и держит подпись', () => {
  const start = formatProgressBar(0, 5, 'начинаю…');
  const mid = formatProgressBar(2, 5, 'описание города');
  const done = formatProgressBar(5, 5, 'остров готов');
  assert.match(start, /Создаю летающий остров/);
  assert.match(start, /начинаю/);
  assert.ok(start.includes('░'));
  assert.ok(done.includes('▓') && !done.includes('░'));
  assert.ok(mid.split('▓').length > start.split('▓').length);
});
