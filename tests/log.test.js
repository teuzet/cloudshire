import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/log.js';

test('truncate режет строки по переданному max, в том числе внутри объекта', () => {
  const long = 'а'.repeat(240);
  assert.equal(truncate(long, 200), `${'а'.repeat(200)}…[+40]`);
  const sliced = truncate({ chronicle: long }, 500);
  assert.equal(sliced.chronicle, long);
  const tight = truncate({ chronicle: long }, 80);
  assert.equal(tight.chronicle, `${'а'.repeat(80)}…[+160]`);
});
