import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNeutralPickRequest, pickNeutralThreat } from '../src/game/neutralPick.js';
import { attachThreat, createThreat } from '../src/game/threats.js';

function plot() {
  return {
    id: 'p1',
    title: 'Зов хищника',
    cause: 'зверь на склоне',
    synopsis: 'зверь теснит людей к стене',
    threats: [],
  };
}

const silentLog = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

test('заказ перечисляет плохие концовки и просит самую хорошую из них', () => {
  const p = plot();
  const a = attachThreat(p, createThreat(p, { text: 'квартал хоронит обвал' }));
  const b = attachThreat(p, createThreat(p, { text: 'стадо уводят со склона' }));
  const text = formatNeutralPickRequest({ plot: p, threats: [a, b] });
  assert.match(text, /Зов хищника/);
  assert.match(text, /зверь на склоне/);
  assert.match(text, new RegExp(a.id));
  assert.match(text, /стадо уводят со склона/);
  assert.match(text, /самую хорошую из плохих/);
});

test('чужой id не принимается, остаётся первая концовка', async () => {
  const p = plot();
  const a = attachThreat(p, createThreat(p, { text: 'обвал' }));
  attachThreat(p, createThreat(p, { text: 'увод стада' }));
  const picked = await pickNeutralThreat({
    plot: p,
    log: silentLog,
    runtime: {
      run: async (opts) => {
        await opts.tools[0].handler({ threatId: 'нет-такой' });
      },
    },
  });
  assert.equal(picked.id, a.id);
});

test('одна концовка берётся без агента', async () => {
  const p = plot();
  const only = attachThreat(p, createThreat(p, { text: 'обвал' }));
  let called = false;
  const picked = await pickNeutralThreat({
    plot: p,
    runtime: {
      run: async () => {
        called = true;
      },
    },
  });
  assert.equal(picked.id, only.id);
  assert.equal(called, false);
});
