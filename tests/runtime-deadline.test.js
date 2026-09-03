import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime, deadlineRemainingMs, toolEndsAgentRun } from '../src/agents/runtime.js';

test('сдачу хода определяют итоговые tools, а не toolChoice', () => {
  assert.equal(toolEndsAgentRun({ name: 'submit_answers' }), true);
  assert.equal(toolEndsAgentRun({ name: 'emit_freeform_candidates' }), true);
  assert.equal(toolEndsAgentRun({ name: 'submit_reply' }), true);
  assert.equal(toolEndsAgentRun({ name: 'read_lore' }), false);
  assert.equal(toolEndsAgentRun({ name: 'read_lore' }, { soleTool: true }), true);
  assert.equal(toolEndsAgentRun({ name: 'submit_answers', terminal: false }), false);
  assert.equal(toolEndsAgentRun({ name: 'talk_to_ruler', terminal: true }), true);
});

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

test('успешный submit_* завершает ход — потому что это сдача, а не потому что toolChoice', async () => {
  let calls = 0;
  const runtime = new AgentRuntime({
    llm: { defaultProvider: 'openai', openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
    agents: {
      mysteryStart: { provider: 'openai', model: 'gpt-4o-mini', instructions: 'тест' },
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
    agentId: 'mysteryStart',
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

function stubRuntime(agentId, chat) {
  const runtime = new AgentRuntime({
    llm: { defaultProvider: 'openai', openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
    agents: {
      [agentId]: { provider: 'openai', model: 'gpt-4o-mini', instructions: 'тест' },
    },
  });
  runtime.getProvider = () => ({
    defaultModel: 'gpt-4o-mini',
    chat,
  });
  return runtime;
}

test('toolChoice на подготовительном tool не заканчивает ход — ждём сдачу', async () => {
  let calls = 0;
  const runtime = stubRuntime('loremaster', async () => {
    calls += 1;
    if (calls === 1) {
      return {
        message: {
          content: '',
          tool_calls: [{ id: '1', function: { name: 'read_lore', arguments: '{}' } }],
        },
        usage: {},
      };
    }
    if (calls === 2) {
      return {
        message: {
          content: '',
          tool_calls: [
            { id: '2', function: { name: 'submit_answers', arguments: '{"answers":[]}' } },
          ],
        },
        usage: {},
      };
    }
    return { message: { content: 'лишний ход', tool_calls: [] }, usage: {} };
  });
  const result = await runtime.run({
    agentId: 'loremaster',
    userMessages: [{ role: 'user', content: 'как ведут учёт?' }],
    maxTurns: 4,
    toolChoice: { type: 'function', function: { name: 'read_lore' } },
    tools: [
      { name: 'read_lore', handler: async () => ({ ok: true }) },
      { name: 'add_fact', handler: async () => ({ ok: true }) },
      { name: 'submit_answers', handler: async () => ({ ok: true }) },
    ],
  });
  assert.equal(calls, 2);
  assert.ok(!result.truncated);
  assert.deepEqual(result.toolTrace.map((t) => t.name), ['read_lore', 'submit_answers']);
});

test('после чтения лора голый текст не считается сдачей — агента nudжат к итоговому tool', async () => {
  let calls = 0;
  const runtime = stubRuntime('loremaster', async () => {
    calls += 1;
    if (calls === 1) {
      return {
        message: {
          content: '',
          tool_calls: [{ id: '1', function: { name: 'read_lore', arguments: '{}' } }],
        },
        usage: {},
      };
    }
    if (calls === 2) {
      return { message: { content: 'учёт на табличках', tool_calls: [] }, usage: {} };
    }
    return {
      message: {
        content: '',
        tool_calls: [
          { id: '3', function: { name: 'submit_answers', arguments: '{}' } },
        ],
      },
      usage: {},
    };
  });
  const result = await runtime.run({
    agentId: 'loremaster',
    userMessages: [{ role: 'user', content: 'как ведут учёт?' }],
    maxTurns: 4,
    toolChoice: { type: 'function', function: { name: 'read_lore' } },
    tools: [
      { name: 'read_lore', handler: async () => ({ ok: true }) },
      { name: 'submit_answers', handler: async () => ({ ok: true }) },
    ],
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.toolTrace.map((t) => t.name), ['read_lore', 'submit_answers']);
});

test('add_fact в одном батче с submit_answers выполняется раньше сдачи', async () => {
  const order = [];
  const runtime = stubRuntime('loremaster', async () => ({
    message: {
      content: '',
      tool_calls: [
        { id: '1', function: { name: 'submit_answers', arguments: '{}' } },
        { id: '2', function: { name: 'add_fact', arguments: '{}' } },
      ],
    },
    usage: {},
  }));
  await runtime.run({
    agentId: 'loremaster',
    userMessages: [{ role: 'user', content: 'факт' }],
    maxTurns: 3,
    tools: [
      {
        name: 'add_fact',
        handler: async () => {
          order.push('add');
          return { ok: true };
        },
      },
      {
        name: 'submit_answers',
        handler: async () => {
          order.push('submit');
          return { ok: true };
        },
      },
    ],
  });
  assert.deepEqual(order, ['add', 'submit']);
});

test('единственный tool агента сдаёт ход, даже без префикса submit_', async () => {
  let calls = 0;
  const runtime = stubRuntime('freeformUrgency', async () => {
    calls += 1;
    if (calls === 1) {
      return {
        message: {
          content: '',
          tool_calls: [{ id: '1', function: { name: 'set_freeform_urgency', arguments: '{}' } }],
        },
        usage: {},
      };
    }
    return { message: { content: 'лишний', tool_calls: [] }, usage: {} };
  });
  const result = await runtime.run({
    agentId: 'freeformUrgency',
    userMessages: [{ role: 'user', content: 'темп' }],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'set_freeform_urgency' } },
    tools: [{ name: 'set_freeform_urgency', handler: async () => ({ ok: true }) }],
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.toolTrace.map((t) => t.name), ['set_freeform_urgency']);
});

test('принуждение talk_to_ruler не мешает force_tick на следующем ходе', async () => {
  let calls = 0;
  const runtime = stubRuntime('player', async () => {
    calls += 1;
    if (calls === 1) {
      return {
        message: {
          content: '',
          tool_calls: [{ id: '1', function: { name: 'talk_to_ruler', arguments: '{}' } }],
        },
        usage: {},
      };
    }
    if (calls === 2) {
      return {
        message: {
          content: '',
          tool_calls: [{ id: '2', function: { name: 'force_tick', arguments: '{}' } }],
        },
        usage: {},
      };
    }
    return { message: { content: 'готово', tool_calls: [] }, usage: {} };
  });
  const result = await runtime.run({
    agentId: 'player',
    userMessages: [{ role: 'user', content: 'ходи' }],
    maxTurns: 6,
    toolChoice: { type: 'function', function: { name: 'talk_to_ruler' } },
    tools: [
      { name: 'talk_to_ruler', handler: async () => ({ ok: true }) },
      { name: 'force_tick', handler: async () => ({ ok: true }) },
    ],
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.toolTrace.map((t) => t.name), ['talk_to_ruler', 'force_tick']);
});
