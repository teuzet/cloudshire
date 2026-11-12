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
    // Писатели по умолчанию просто повторяют суть: сценарию важна механика, не проза.
    .always('chronicler', (req) => toolReply('submit_chronicle', { text: (lastUser(req).split('Суть события: ')[1] ?? lastUser(req)).split('\n')[0] }))
    .always('herald', (req) => toolReply('submit_news', { text: `Весть: ${lastUser(req).split('Запись летописи:\n')[1] ?? ''}` }));
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

type Effects = Array<{ stat: string; direction: 'up' | 'down'; size: string }>;

/**
 * Спокойные ответы узких агентов системы фронтов: всё возможно, риска нет, вклад по таблице `appraisals`
 * (по названию предмета; чего в таблице нет, то городу ничего не даёт). Тест переопределяет нужных
 * через `script` и `always`.
 */
export function scriptFrontAgents(llm: FakeLlm, appraisals: Record<string, Effects> = {}): FakeLlm {
  const allowed = (req: LlmRequest, line: string) => (new RegExp(`${line}: (.*)`).exec(lastUser(req))?.[1] ?? '').split(', ');
  return llm
    .always('canon-warden', toolReply('submit_canon_verdict', { verdict: 'possible', reason: 'Городу это по силам.' }))
    .always('contribution-appraiser', (req) => {
      const name = /Предмет: «([^»]+)»/.exec(lastUser(req))?.[1] ?? '';
      return toolReply('submit_contribution', { effects: appraisals[name] ?? [], reason: 'По таблице теста.' });
    })
    .always('footprint-mapper', toolReply('submit_footprint', { relations: [] }))
    .always('risk-appraiser', toolReply('submit_risk', { step: 'safe', reason: 'Спокойное дело.' }))
    .always('key-sealer', (req) =>
      toolReply('submit_key', {
        moves: ['Действовать открыто.', 'Договориться с теми, кого это касается.', 'Не жалеть сил на надзор.'],
        twist: lastUser(req).includes('свойство исхода: да') ? 'У результата есть скрытая сторона.' : null,
      }),
    )
    .always('alignment-judge', toolReply('submit_alignment', { verdict: 'fits' }))
    .always('role-fitter', toolReply('submit_fit', { fits: true, reason: 'Подходит.' }))
    .always('beat-writer', (req) =>
      toolReply('submit_beat', {
        text: `Шаг дела «${/Дело: «([^»]+)»/.exec(lastUser(req))?.[1] ?? ''}».`,
        effect: allowed(req, 'Разрешённые эффекты').includes('reveal') ? 'reveal' : 'none',
      }),
    )
    .always('resolver', (req) => {
      const title = /Событие: «([^»]+)»/.exec(lastUser(req))?.[1] ?? '';
      const none = allowed(req, 'Разрешённые последствия').includes('none');
      return toolReply('submit_resolution', { text: `Развязка «${title}».`, effect: none ? 'none' : 'fact', fact: none ? null : `После «${title}» в городе остался след.` });
    })
    .always('faith-appraiser', toolReply('submit_faith', { case: 'none', strength: 'minor' }))
    .always('theme-tagger', toolReply('submit_themes', { existing: [], fresh: 'камень' }))
    .always('description-rewriter', (req) => toolReply('submit_description', { description: `${/Прежнее описание: (.*)/.exec(lastUser(req))?.[1] ?? ''} Теперь иначе.`.slice(0, 560) }));
}

/** Правила для сценарного теста: из словаря динамик остаются только названные записи. */
export function rulesWith(dynamicIds: readonly string[], tweak: (r: ReturnType<typeof rules>) => void = () => {}) {
  const r = structuredClone(rules());
  r.fronts.dynamics = r.fronts.dynamics.filter((d) => dynamicIds.includes(d.id));
  tweak(r);
  return r;
}

export function costume(title: string, extra: Record<string, unknown> = {}) {
  return toolReply('submit_costume', { title, description: `${title}: подробности.`, rumor: `Слух: ${title}.`, outburst: `Прорыв: ${title}.`, ...extra });
}
