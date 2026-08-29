import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createLlmProvider } from '../src/llm/index.js';
import { normalizeUsage } from '../src/llm/usage.js';
import {
  toAnthropicTools,
  toAnthropicToolChoice,
  toAnthropicRequest,
  fromAnthropicMessage,
  AnthropicProvider,
} from '../src/llm/anthropic.js';

test('createLlmProvider знает anthropic/claude', () => {
  const config = {
    llm: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5' } },
  };
  const a = createLlmProvider(config, 'anthropic');
  const b = createLlmProvider(config, 'claude');
  assert.equal(a.name, 'anthropic');
  assert.equal(b.name, 'anthropic');
  assert.equal(a.defaultModel, 'claude-sonnet-5');
});

test('OpenAI tools и tool_choice конвертируются в Anthropic', () => {
  const tools = toAnthropicTools([
    {
      type: 'function',
      function: {
        name: 'submit_mystery_annotation',
        description: 'аннотация',
        parameters: { type: 'object', required: ['annotation'], properties: { annotation: { type: 'string' } } },
      },
    },
  ]);
  assert.equal(tools[0].name, 'submit_mystery_annotation');
  assert.equal(tools[0].input_schema.required[0], 'annotation');
  assert.deepEqual(
    toAnthropicToolChoice({ type: 'function', function: { name: 'submit_mystery_annotation' } }),
    { type: 'tool', name: 'submit_mystery_annotation' },
  );
  assert.deepEqual(toAnthropicToolChoice('required'), { type: 'any' });
});

test('system уходит отдельно, tool-результаты сливаются в user', () => {
  const { system, messages } = toAnthropicRequest([
    { role: 'system', content: 'ты судья' },
    { role: 'user', content: 'пакет' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'submit_mystery_annotation_verdict', arguments: '{"verdict":"PASS"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'user', content: 'повтори tool' },
  ]);
  assert.equal(system, 'ты судья');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content[0].type, 'tool_use');
  assert.equal(messages[1].content[0].input.verdict, 'PASS');
  assert.equal(messages[2].role, 'user');
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.match(messages[2].content[1].text, /повтори/);
});

test('ответ Anthropic становится OpenAI message с tool_calls', () => {
  const message = fromAnthropicMessage({
    content: [
      { type: 'text', text: 'ок' },
      { type: 'tool_use', id: 'tu_1', name: 'submit_mystery_annotation', input: { workingTitle: 'Нити', annotation: 'Раз. Два.' } },
    ],
  });
  assert.equal(message.role, 'assistant');
  assert.equal(message.content, 'ок');
  assert.equal(message.tool_calls[0].function.name, 'submit_mystery_annotation');
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).workingTitle, 'Нити');
});

test('usage Anthropic читает input_tokens и cache_read', () => {
  const u = normalizeUsage({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4 });
  assert.equal(u.prompt_tokens, 10);
  assert.equal(u.completion_tokens, 3);
  assert.equal(u.cached_tokens, 4);
});

test('без ключа Anthropic падает понятной ошибкой', async () => {
  const p = new AnthropicProvider({
    llm: { anthropic: { apiKeyEnv: 'MISSING_ANTHROPIC_TEST_KEY_ZZZ' } },
  });
  await assert.rejects(
    () => p.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    /MISSING_ANTHROPIC_TEST_KEY_ZZZ/,
  );
});

test('mystery annotation: генератор Claude, судья Luna', () => {
  const config = loadConfig();
  assert.equal(config.llm.anthropic.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(config.agents.mysteryAnnotation.provider, 'anthropic');
  assert.equal(config.agents.mysteryAnnotation.model, 'claude-sonnet-4-6');
  assert.equal(config.agents.mysteryAnnotationJudge.provider, 'openai');
  assert.equal(config.agents.mysteryAnnotationJudge.model, 'gpt-5.6-luna');
});
