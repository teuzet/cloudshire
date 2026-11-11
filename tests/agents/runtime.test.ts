import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { FakeLlm, textReply, toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings, parseAgentSettings } from '../../src/agents/_shared/settings.js';
import { AgentError, runStructured, runToolLoop, type StructuredAgent } from '../../src/agents/_shared/runtime.js';

const echo: StructuredAgent<{ allowed: string[] }, { pick: string }, string> = {
  name: 'echo',
  tool: 'submit_pick',
  description: 'pick',
  schema: z.object({ pick: z.string() }),
  system: () => 'sys',
  user: () => 'user',
  check: (raw, input) => (input.allowed.includes(raw.pick) ? null : `нет ${raw.pick}`),
  finish: (raw) => raw.pick.toUpperCase(),
};

const deps = (llm: FakeLlm) => ({ llm, settings: fixedSettings('fake:m') });

describe('структурный ответ', () => {
  test('с первого раза', async () => {
    const llm = new FakeLlm().script('echo', toolReply('submit_pick', { pick: 'a' }));
    const r = await runStructured(deps(llm), echo, { allowed: ['a'] });
    expect(r.value).toBe('A');
    expect(r.attempts).toBe(1);
    expect(llm.requests[0]?.toolChoice).toEqual({ name: 'submit_pick' });
    expect(llm.requests[0]?.tools?.[0]?.parameters).toMatchObject({ type: 'object', properties: { pick: { type: 'string' } } });
  });

  test('ошибка смысла уходит модели результатом тула, и она исправляется', async () => {
    const llm = new FakeLlm().script('echo', toolReply('submit_pick', { pick: 'x' }), toolReply('submit_pick', { pick: 'a' }));
    const r = await runStructured(deps(llm), echo, { allowed: ['a'] });
    expect(r.attempts).toBe(2);
    const second = llm.requests[1]!;
    const last = second.messages[second.messages.length - 1];
    expect(last).toMatchObject({ role: 'tool', content: expect.stringContaining('нет x') });
  });

  test('ошибка формы тоже', async () => {
    const llm = new FakeLlm().script('echo', toolReply('submit_pick', { pick: 5 }), toolReply('submit_pick', { pick: 'a' }));
    expect((await runStructured(deps(llm), echo, { allowed: ['a'] })).value).toBe('A');
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('pick');
  });

  test('модель ответила текстом — просим тул', async () => {
    const llm = new FakeLlm().script('echo', textReply('думаю'), toolReply('submit_pick', { pick: 'a' }));
    await runStructured(deps(llm), echo, { allowed: ['a'] });
    expect(llm.requests[1]?.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('submit_pick') });
  });

  test('после всех попыток — AgentError', async () => {
    const llm = new FakeLlm().always('echo', toolReply('submit_pick', { pick: 'x' }));
    await expect(runStructured(deps(llm), echo, { allowed: ['a'] }, { attempts: 2 })).rejects.toBeInstanceOf(AgentError);
    expect(llm.requests).toHaveLength(2);
  });

  test('отказ модели не повторяется', async () => {
    const llm = new FakeLlm().always('echo', { stop: 'refusal' });
    await expect(runStructured(deps(llm), echo, { allowed: ['a'] })).rejects.toThrow(/отказалась/);
    expect(llm.requests).toHaveLength(1);
  });
});

describe('цикл тулов', () => {
  const tools = [
    { name: 'add', description: 'add', schema: z.object({ n: z.number() }), run: (a: never, ctx: { sum: number }) => { ctx.sum += (a as { n: number }).n; return { ok: true }; } },
  ];
  const final = { name: 'submit_reply', description: 'reply', schema: z.object({ text: z.string() }) };

  test('тулы выполняются, итоговый сдаёт ход', async () => {
    const llm = new FakeLlm().script('p', toolsReply(['add', { n: 2 }], ['add', { n: 3 }]), toolReply('submit_reply', { text: 'готово' }));
    const ctx = { sum: 0 };
    const r = await runToolLoop(deps(llm), { agent: 'p', system: 's', messages: [{ role: 'user', content: 'u' }], tools, final, ctx });
    expect(ctx.sum).toBe(5);
    expect(r.final.text).toBe('готово');
    expect(r.calls).toHaveLength(2);
    expect(r.steps).toBe(2);
  });

  test('дело и речь в одном ответе', async () => {
    const llm = new FakeLlm().script('p', toolsReply(['add', { n: 1 }], ['submit_reply', { text: 'ок' }]));
    const ctx = { sum: 0 };
    const r = await runToolLoop(deps(llm), { agent: 'p', system: 's', messages: [{ role: 'user', content: 'u' }], tools, final, ctx });
    expect(ctx.sum).toBe(1);
    expect(r.steps).toBe(1);
  });

  test('на последнем шаге модель обязана сдать речь', async () => {
    const llm = new FakeLlm().always('p', toolReply('add', { n: 1 }));
    await expect(
      runToolLoop(deps(llm), { agent: 'p', system: 's', messages: [{ role: 'user', content: 'u' }], tools, final, ctx: { sum: 0 }, maxSteps: 3 }),
    ).rejects.toBeInstanceOf(AgentError);
    expect(llm.requests.map((r) => r.toolChoice)).toEqual(['required', 'required', { name: 'submit_reply' }]);
  });

  test('неизвестный тул и кривые аргументы — ошибкой в результат, без падения', async () => {
    const llm = new FakeLlm().script('p', toolsReply(['nope', {}], ['add', { n: 'x' }]), toolReply('submit_reply', { text: 'ок' }));
    const ctx = { sum: 0 };
    await runToolLoop(deps(llm), { agent: 'p', system: 's', messages: [{ role: 'user', content: 'u' }], tools, final, ctx });
    expect(ctx.sum).toBe(0);
    const results = llm.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
    expect(results.join()).toMatch(/нет тула nope/);
  });
});

describe('настройки агентов', () => {
  test('своя строка перекрывает default', () => {
    const settings = parseAgentSettings({ default: { model: 'openai:a', maxOutputTokens: 100 }, agents: { x: { model: 'anthropic:b' } } });
    expect(settings('x')).toEqual({ model: 'anthropic:b', maxOutputTokens: 100 });
    expect(settings('y')).toEqual({ model: 'openai:a', maxOutputTokens: 100 });
  });

  test('без default — ошибка', () => {
    expect(() => parseAgentSettings({ agents: {} })).toThrow(/default/);
  });
});
