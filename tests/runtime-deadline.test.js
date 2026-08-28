import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime, deadlineRemainingMs } from '../src/agents/runtime.js';

test('просроченный deadline сразу обрезает ход агента', async () => {
  let calls = 0;
  const runtime = new AgentRuntime({
    llm: { defaultProvider: 'openai', openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
    agents: {
      ruler: { provider: 'openai', model: 'gpt-4o-mini', instructions: 'тест' },
    },
  });
  runtime.getProvider = () => ({
    defaultModel: 'gpt-4o-mini',
    async chat() {
      calls += 1;
      return { message: { content: 'поздно', tool_calls: [] }, usage: {} };
    },
  });
  const result = await runtime.run({
    agentId: 'ruler',
    userMessages: [{ role: 'user', content: 'привет' }],
    maxTurns: 3,
    deadlineAt: Date.now() - 1000,
  });
  assert.equal(calls, 0);
  assert.equal(result.truncated, true);
});

test('deadlineRemainingMs внутри хода считает остаток', async () => {
  const runtime = new AgentRuntime({
    llm: { defaultProvider: 'openai', openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
    agents: {
      ruler: { provider: 'openai', model: 'gpt-4o-mini', instructions: 'тест' },
    },
  });
  let seen = null;
  runtime.getProvider = () => ({
    defaultModel: 'gpt-4o-mini',
    async chat() {
      seen = deadlineRemainingMs();
      return { message: { content: 'ок', tool_calls: [] }, usage: {} };
    },
  });
  await runtime.run({
    agentId: 'ruler',
    userMessages: [{ role: 'user', content: 'привет' }],
    maxTurns: 1,
    deadlineAt: Date.now() + 20_000,
  });
  assert.ok(seen != null && seen > 0 && seen <= 20_000);
});
