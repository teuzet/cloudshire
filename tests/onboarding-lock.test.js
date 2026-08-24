import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameApp } from '../src/game/app.js';
import { ONBOARDING_BUSY_REPLY } from '../src/game/onboarding.js';

function delayedRuntime(ms, text = 'Привет. Можем пойти быстрым путём или ты опишешь город сам.') {
  return {
    async run() {
      await new Promise((r) => setTimeout(r, ms));
      return { text, toolTrace: [], truncated: false };
    },
  };
}

function memoryStorage() {
  const users = new Map();
  return {
    driver: 'memory',
    async getWorld() {
      return { id: 'world_test', tickIndex: 0, gameDate: { label: 'Год 1, месяц 1' } };
    },
    async getDomainForUser() {
      return null;
    },
    async getUserBinding(id) {
      return users.get(String(id)) || null;
    },
    async saveUserBinding(b) {
      users.set(String(b.userId), { ...b, onboarding: { ...b.onboarding } });
      return b;
    },
    async listDomains() {
      return [];
    },
    async listConfluxes() {
      return [];
    },
  };
}

const miniConfig = {
  genesis: { tagGroups: [] },
  tick: { intervalHours: 2 },
  telegram: { enabled: false },
};

test('параллельный ход того же игрока не затирает онбординг и отвечает busy', async () => {
  const storage = memoryStorage();
  const app = new GameApp({
    config: miniConfig,
    storage,
    runtime: delayedRuntime(80),
  });
  const first = app.handleUserMessage('352066190', 'привет', { channel: 'telegram' });
  await new Promise((r) => setTimeout(r, 10));
  const second = await app.handleUserMessage('352066190', 'ещё одно', { channel: 'telegram' });
  assert.equal(second.busy, true);
  assert.equal(second.reply, ONBOARDING_BUSY_REPLY);
  const done = await first;
  assert.equal(done.busy, undefined);
  assert.ok(done.reply.includes('быстр') || done.reply.length > 10);
  const binding = await storage.getUserBinding('352066190');
  const userTurns = (binding.onboarding.messages || []).filter((m) => m.role === 'user');
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0].content, 'привет');
});

test('после окончания хода следующий проходит нормально', async () => {
  const app = new GameApp({
    config: miniConfig,
    storage: memoryStorage(),
    runtime: delayedRuntime(5, 'Город ещё не предлагал.'),
  });
  const a = await app.handleUserMessage('1', 'раз', { channel: 'telegram' });
  const b = await app.handleUserMessage('1', 'два', { channel: 'telegram' });
  assert.equal(a.busy, undefined);
  assert.equal(b.busy, undefined);
  assert.equal(b.agent, 'onboarding');
});
