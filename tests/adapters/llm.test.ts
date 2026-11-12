import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { anthropicToolChoice, toAnthropicMessages } from '../../src/adapters/llm/anthropic.js';
import { RecordingLlm, ReplayLlm, requestKey } from '../../src/adapters/llm/cassette.js';
import { FakeLlm, toolReply } from '../../src/adapters/llm/fake.js';
import { openAiToolChoice, toOpenAiInput } from '../../src/adapters/llm/openai.js';
import { RoutingLlm, splitModel } from '../../src/adapters/llm/router.js';
import type { LlmMessage, LlmRequest } from '../../src/ports/llm.js';

const turn: LlmMessage[] = [
  { role: 'user', content: 'привет' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'add', arguments: '{"n":1}' }] },
  { role: 'tool', toolCallId: 't1', content: '{"ok":true}' },
  { role: 'user', content: 'дальше' },
];

describe('роутер', () => {
  test('снимает префикс провайдера', async () => {
    const fake = new FakeLlm().always('a', toolReply('x', {}));
    const llm = new RoutingLlm({ openai: fake });
    await llm.complete({ agent: 'a', model: 'openai:gpt-x', system: '', messages: [] });
    expect(fake.requests[0]?.model).toBe('gpt-x');
    await expect(llm.complete({ agent: 'a', model: 'mistral:m', system: '', messages: [] })).rejects.toThrow(/не подключён/);
    expect(() => splitModel('gpt-x')).toThrow(/префикс/);
  });
});

describe('перевод сообщений', () => {
  test('OpenAI: вызовы тулов и их результаты — отдельные элементы', () => {
    const out = toOpenAiInput(turn);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: 'user', content: 'привет' });
    expect(out[1]).toEqual({ type: 'function_call', call_id: 't1', name: 'add', arguments: '{"n":1}' });
    expect(out[2]).toEqual({ type: 'function_call_output', call_id: 't1', output: '{"ok":true}' });
  });

  test('OpenAI: свои элементы (с рассуждением) возвращаются как есть', () => {
    const blocks = [{ type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'enc' }, { type: 'function_call', call_id: 't1', name: 'add', arguments: '{}' }];
    const out = toOpenAiInput([{ role: 'user', content: 'u' }, { role: 'assistant', content: '', providerContent: { provider: 'openai', blocks } }]);
    expect(out.slice(1)).toEqual(blocks);
  });

  test('OpenAI: выбор тула', () => {
    expect(openAiToolChoice({ name: 'x' })).toEqual({ type: 'function', name: 'x' });
    expect(openAiToolChoice('required')).toBe('required');
    expect(openAiToolChoice(undefined)).toBeUndefined();
  });

  test('Anthropic: результат тула и следующий текст — один user-ход', () => {
    const out = toAnthropicMessages(turn);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'add', input: { n: 1 } }] });
    expect(out[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }, { type: 'text', text: 'дальше' }] });
  });

  test('Anthropic: свои блоки (с мышлением) возвращаются как есть', () => {
    const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'ок' }];
    const out = toAnthropicMessages([{ role: 'user', content: 'u' }, { role: 'assistant', content: 'ок', providerContent: { provider: 'anthropic', blocks } }]);
    expect(out[1]?.content).toBe(blocks);
  });

  test('Anthropic: принудительный тул только там, где модель его принимает', () => {
    expect(anthropicToolChoice('claude-opus-5-5', { name: 'x' })).toEqual({ type: 'auto' });
    expect(anthropicToolChoice('claude-sonnet-4-6', { name: 'x' })).toEqual({ type: 'tool', name: 'x' });
    expect(anthropicToolChoice('claude-sonnet-4-6', 'required')).toEqual({ type: 'any' });
    expect(anthropicToolChoice('claude-sonnet-4-6', undefined)).toBeUndefined();
  });
});

describe('кассеты', () => {
  test('записанное проигрывается, изменённый промпт — понятная ошибка', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tape-')), 'a.json');
    const req: LlmRequest = { agent: 'a', model: 'm', system: 's', messages: [{ role: 'user', content: 'u' }] };
    const fake = new FakeLlm().always('a', toolReply('x', { n: 1 }));
    const recorded = await new RecordingLlm(fake, file).complete(req);
    const replay = new ReplayLlm(file);
    expect(await replay.complete({ ...req })).toEqual(recorded);
    await expect(replay.complete({ ...req, system: 's2' })).rejects.toThrow(/перезапиши кассету/);
    expect(requestKey(req)).toBe(requestKey(structuredClone(req)));
  });
});
