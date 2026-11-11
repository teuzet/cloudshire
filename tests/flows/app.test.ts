import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { FakeLlm } from '../../src/adapters/llm/fake.js';
import { MemoryNotifier } from '../../src/adapters/notifier/memory.js';
import { splitForTelegram } from '../../src/adapters/notifier/telegram.js';
import { buildApp, loadScenarios } from '../../src/clients/app.js';
import { cityStatus } from '../../src/clients/views.js';
import { blankCity, rules } from '../helpers/fixtures.js';

describe('сборка приложения', () => {
  test('конфиги, заготовки и мир собираются с диска', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-app-'));
    const app = await buildApp({ DATA_DIR: dir }, new MemoryNotifier(), { llm: new FakeLlm() });
    const world = await app.deps.storage.getWorld();
    expect(world?.namePool.length).toBeGreaterThan(20);
    expect(app.deps.scenarios.map((s) => s.id)).toContain('lantern-isle');
    expect(app.deps.agents.settings('city-genesis').model).toMatch(/^anthropic:/);
    // Второй запуск мир не пересоздаёт.
    const again = await buildApp({ DATA_DIR: dir }, new MemoryNotifier(), { llm: new FakeLlm() });
    expect((await again.deps.storage.getWorld())?.id).toBe(world?.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('без ключей моделей приложение не стартует', async () => {
    await expect(buildApp({ DATA_DIR: os.tmpdir() }, new MemoryNotifier())).rejects.toThrow(/нет ключей/);
  });

  test('все заготовки в scenarios/ проходят схему', () => {
    expect(loadScenarios().length).toBeGreaterThan(0);
  });
});

describe('вид для игрока', () => {
  test('статус города без чисел мира, кроме маны', () => {
    const text = cityStatus(rules(), blankCity({ mana: { value: 7, day: 0 } }), 40);
    expect(text).toContain('Туманск');
    expect(text).toContain('Вета — свободен');
    expect(text).not.toMatch(/\b50\b/);
  });

  test('длинная весть режется по строкам под лимит Telegram', () => {
    const parts = splitForTelegram(('строка '.repeat(30) + '\n').repeat(40));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
  });
});


