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

test('submit_reply в одном батче выполняется после других tools и завершает ход', async () => {
  const order = [];
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
      if (calls === 1) {
        return {
          message: {
            content: '',
            tool_calls: [
              { id: '1', function: { name: 'submit_reply', arguments: '{}' } },
              { id: '2', function: { name: 'declare_standing_order', arguments: '{}' } },
            ],
          },
          usage: {},
        };
      }
      return { message: { content: 'лишний ход', tool_calls: [] }, usage: {} };
    },
  });
  await runtime.run({
    agentId: 'ruler',
    userMessages: [{ role: 'user', content: 'патруль' }],
    maxTurns: 4,
    tools: [
      {
        name: 'declare_standing_order',
        handler: async () => {
          order.push('declare');
          return { ok: true };
        },
      },
      {
        name: 'submit_reply',
        handler: async () => {
          order.push('submit');
          return { ok: true };
        },
      },
    ],
  });
  assert.deepEqual(order, ['declare', 'submit']);
  assert.equal(calls, 1);
});

test('успешный forced tool без submit_reply сразу завершает ход', async () => {
  let calls = 0;
  const runtime = new AgentRuntime({
    llm: { defaultProvider: 'openai', openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
    agents: {
      mysteryArchitect: { provider: 'openai', model: 'gpt-4o-mini', instructions: 'тест' },
    },
  });
  runtime.getProvider = () => ({
    defaultModel: 'gpt-4o-mini',
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            content: '',
            tool_calls: [
              { id: '1', function: { name: 'submit_mystery_skeleton', arguments: '{}' } },
            ],
          },
          usage: {},
        };
      }
      return { message: { content: 'лишний ход', tool_calls: [] }, usage: {} };
    },
  });
  const result = await runtime.run({
    agentId: 'mysteryArchitect',
    userMessages: [{ role: 'user', content: 'skeleton' }],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_mystery_skeleton' } },
    tools: [
      {
        name: 'submit_mystery_skeleton',
        handler: async () => ({ ok: true }),
      },
    ],
  });
  assert.equal(calls, 1);
  assert.ok(!result.truncated);
  assert.deepEqual(result.toolTrace.map((t) => t.name), ['submit_mystery_skeleton']);
});
