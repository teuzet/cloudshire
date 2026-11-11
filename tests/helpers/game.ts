/**
 * Стенд для сценарных тестов потоков: память вместо базы, ручные часы,
 * сид-рандом, fake-модель и почтовый ящик вместо Telegram.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ManualClock } from '../../src/adapters/clock/manual.js';
import { FakeLlm, toolReply } from '../../src/adapters/llm/fake.js';
import { seededRandom } from '../../src/adapters/random/seeded.js';
import { MemoryStorage } from '../../src/adapters/storage/memory.js';
import { fixedSettings } from '../../src/agents/_shared/settings.js';
import { msPerGameDay } from '../../src/core/time.js';
import { parseScenario } from '../../src/core/world/scenario.js';
import { CityLocks } from '../../src/flows/city-lock.js';
import type { FlowDeps } from '../../src/flows/context.js';
import { ensureWorld } from '../../src/flows/world.js';
import type { LlmRequest } from '../../src/ports/llm.js';
import type { Notifier, OutboundMessage } from '../../src/ports/notifier.js';
import { rules } from './fixtures.js';

const root = path.resolve(import.meta.dirname, '../..');

export class Inbox implements Notifier {
  readonly sent: OutboundMessage[] = [];
  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}

export function lanternIsle() {
  return parseScenario(yaml.load(fs.readFileSync(path.join(root, 'scenarios/lantern-isle.yaml'), 'utf8')));
}

/** Последнее user-сообщение запроса — чтобы fake-агенты отвечали «по делу». */
export function lastUser(req: LlmRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === 'user') return m.content;
  }
  return '';
}

export async function stand(seed = 7) {
  const r = rules();
  const llm = new FakeLlm()
    // Писатели по умолчанию просто повторяют факт: сценарию важна механика, не проза.
    .always('front-chronicle', (req) => toolReply('submit_chronicle', { text: lastUser(req).replace(/^Факт:\n/, '') }))
    .always('herald', (req) => toolReply('submit_news', { text: `Весть: ${lastUser(req).split('Запись летописи:\n')[1] ?? ''}` }))
    .always('local-world-updater', toolReply('submit_local_update', { verdict: 'unchanged' }));
  const clock = new ManualClock(Date.UTC(2026, 10, 1));
  const inbox = new Inbox();
  const deps: FlowDeps = {
    rules: r,
    agents: { llm, settings: fixedSettings() },
    storage: new MemoryStorage(),
    clock,
    random: seededRandom(seed),
    notifier: inbox,
    scenarios: [lanternIsle()],
  };
  const names = { female: ['Айра', 'Вена', 'Ирма', 'Лира', 'Мэа'], male: ['Орм', 'Кайр', 'Тэн', 'Вэс', 'Дар'] };
  await ensureWorld(deps, { names });
  const passDays = (days: number) => clock.advance(Math.round(days * msPerGameDay(r)));
  return { r, llm, clock, inbox, deps, names, locks: new CityLocks(), passDays };
}
