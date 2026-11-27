/**
 * Живая сверка приказа целиком, без жреца: заготовка сажается на маленький город, приказ идёт
 * через всю цепочку узких агентов. Ходит в настоящие модели: запускать только по просьбе Ника.
 *
 *   npx tsx bench/live/order-check.ts [имя случая ...]
 *
 * Печатает, что услышит жрец, какое дело получилось (цена, влияния, ставка), предупреждения
 * потока и расход.
 */

import { ManualClock } from '../../src/adapters/clock/manual.js';
import { seededRandom } from '../../src/adapters/random/seeded.js';
import { MemoryStorage } from '../../src/adapters/storage/memory.js';
import { parseAgentSettings } from '../../src/agents/_shared/settings.js';
import type { AgentEvent } from '../../src/agents/_shared/runtime.js';
import type { City, Front } from '../../src/core/city.js';
import { parseRules, type Office } from '../../src/core/rules.js';
import { activeFronts, frontGist } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { plantScenario } from '../../src/core/world/scenario.js';
import { buildLlm, loadDotEnv, loadScenarios, readYaml } from '../../src/clients/app.js';
import { newId, type FlowDeps } from '../../src/flows/context.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { playerWill } from '../../src/flows/will.js';
import { ensureWorld, type NamesFile } from '../../src/flows/world.js';
import type { Llm, LlmUsage } from '../../src/ports/llm.js';
import { blankCity } from '../../tests/helpers/fixtures.js';

const PRICE = { input: 0.2, cached: 0.02, output: 1.2, write: 0.25 };
const total: Required<LlmUsage> = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function metered(inner: Llm): Llm {
  return {
    async complete(request) {
      const response = await inner.complete(request);
      for (const k of Object.keys(total) as Array<keyof LlmUsage>) total[k] += response.usage[k] ?? 0;
      return response;
    },
  };
}

function cost(u: Required<LlmUsage>): number {
  const plain = Math.max(0, u.inputTokens - u.cachedInputTokens - u.cacheWriteTokens);
  return (plain * PRICE.input + u.cachedInputTokens * PRICE.cached + u.cacheWriteTokens * PRICE.write + u.outputTokens * PRICE.output) / 1e6;
}

interface OrderCase {
  name: string;
  scenario: string;
  office: Office;
  /** Приказы по очереди. */
  orders: string[];
  /** Что дописать в город после посадки: объекты, которых нет в заготовке. */
  setup?: (deps: FlowDeps, city: City) => void;
}

const named = (city: City, name: string) => city.objects.find((o) => o.name === name);

export const ORDERS: OrderCase[] = [
  { name: 'цепи', scenario: 'lantern-isle', office: 'marshal', orders: ['Прикуй прибившийся островок цепями к причалам, чтобы его не унесло.'] },
  { name: 'ночная стража', scenario: 'arsonist', office: 'marshal', orders: ['Учреди ночную стражу с баграми и вёдрами, пусть обходит кварталы до рассвета.'] },
  { name: 'клятва наследников', scenario: 'house-feud', office: 'chancellor', orders: ['Сведи обоих наследников знатного дома в храме и возьми с них клятву мира до жатвы.'] },
  {
    name: 'сбить цепи',
    scenario: 'lantern-isle',
    office: 'marshal',
    orders: ['Сбейте цепи, которыми островок прикован к причалам.'],
    setup: (deps, city) => {
      const tower = named(city, 'Башня на островке')!;
      const isle = named(city, 'Островок с горящими фонарями')!;
      const clock = city.fronts.find((f) => f.form === 'clock')!;
      city.objects.push(createObject(deps.rules, { id: newId(deps, 'obj'), type: 'community', name: 'Бунтовщики в башне', description: 'Два десятка беглых засели в башне, грабят причалы и зовут к себе бедноту.', parentId: tower.id, day: 0 }));
      const chains = createObject(deps.rules, { id: newId(deps, 'obj'), type: 'object', name: 'Причальные цепи', description: 'Толстые цепи держат островок у причалов.', parentId: isle.id, day: 0 });
      chains.holds = [{ frontId: clock.id, effect: 'stop', day: 0 }];
      city.objects.push(chains);
    },
  },
  {
    name: 'сбить цепи ночью',
    scenario: 'lantern-isle',
    office: 'marshal',
    orders: ['Сбейте цепи островка ночью, с лодок, пока бунтовщики из башни ушли в набег.'],
    setup: (deps, city) => ORDERS.find((c) => c.name === 'сбить цепи')!.setup!(deps, city),
  },
  {
    name: 'вывезти книги',
    scenario: 'lantern-isle',
    office: 'keeper',
    orders: ['Перевезите книги из башни в городскую библиотеку, пока островок не ушёл.'],
    setup: (deps, city) => {
      const tower = named(city, 'Башня на островке')!;
      city.objects.push(
        createObject(deps.rules, { id: newId(deps, 'obj'), type: 'resource', name: 'Книги башни', description: 'Полки старых книг на нижнем ярусе башни: травники, звёздные таблицы, записи о составах.', parentId: tower.id, statEffect: { knowledge: 6 }, day: 0 }),
        createObject(deps.rules, { id: newId(deps, 'obj'), type: 'building', name: 'Городская библиотека', description: 'Каменная библиотека у храма.', statEffect: { knowledge: 5 }, day: 0 }),
      );
    },
  },
  {
    name: 'стенки от огня',
    scenario: 'arsonist',
    office: 'marshal',
    orders: ['Поставьте вокруг городского амбара и храма глиняные стенки от огня.'],
  },
];

/** Маленький обжитой город, чтобы агентам было на что опереться. */
function town(deps: FlowDeps): City {
  const city = blankCity();
  const add = (type: Parameters<typeof createObject>[1]['type'], name: string, description: string, statEffect: Record<string, number> = {}) =>
    city.objects.push(createObject(deps.rules, { id: newId(deps, 'obj'), type, name, description, statEffect, day: 0 }));
  add('structure', 'Причалы у кромки', 'Каменные причалы на краю острова: сюда пристают небесные лодки и прибивает то, что несёт ветер.', { prosperity: 5 });
  add('building', 'Храм покровителя', 'Белый храм на холме, где верховный жрец слушает волю покровителя.', { influence: 5 });
  add('organization', 'Городская стража', 'Две сотни стражников: караулы у ворот, обходы рынка.', { security: 12 });
  add('community', 'Рыбачья слобода', 'Семьи небесных рыбаков у кромки: сети, лодки, коптильни.', { prosperity: 5 });
  add('organization', 'Кузнечный ряд', 'Кузни и литейные мастерские: куют цепи, якоря, инструмент.', { prosperity: 5, security: 2 });
  add('district', 'Торговый квартал', 'Лавки, склады и амбары у главной площади.', { prosperity: 12 });
  return city;
}

function frontWords(city: City, f: Front): string {
  const holders = city.objects.filter((o) => o.status === 'active' && o.holds?.some((h) => h.frontId === f.id)).map((o) => o.name);
  return `  ${f.id} [${f.form}${f.plus ? ', случай' : ''}] ёмкость ${f.capacity}, срок ${f.deadlineDay ?? '—'}${f.livesOn ? `, живёт на ${city.objects.find((o) => o.id === f.livesOn)?.name}` : ''}${holders.length ? `, держит: ${holders.join(', ')}` : ''}: ${frontGist(f)}`;
}

async function runCase(c: OrderCase, base: Pick<FlowDeps, 'rules' | 'agents' | 'scenarios'>, names: NamesFile): Promise<void> {
  const warns: string[] = [];
  const deps: FlowDeps = {
    ...base,
    storage: new MemoryStorage(),
    clock: new ManualClock(Date.UTC(2026, 10, 1)),
    random: seededRandom(7),
    notifier: { async send() {} },
    log: { warn: (event, data) => warns.push(`${event} ${JSON.stringify(data)}`) },
  };
  await ensureWorld(deps, { names });
  const city = town(deps);
  const scenario = base.scenarios.find((s) => s.id === c.scenario);
  if (!scenario) throw new Error(`нет заготовки ${c.scenario}`);
  plantScenario(deps.rules, city, scenario, { day: 0, newId: (p) => newId(deps, p) });
  c.setup?.(deps, city);
  refreshAllFronts(deps, city, 0);

  console.log(`\n══ ${c.name} (${c.scenario}) ══`);
  console.log('До приказа:');
  for (const f of activeFronts(city)) console.log(frontWords(city, f));
  for (const order of c.orders) {
    const before = new Set(city.fronts.map((f) => f.id));
    const out = await playerWill(deps, city, c.office, order, 0);
    console.log(`\nПриказ: ${order}`);
    console.log(`Жрецу: ${out.say}`);
    for (const f of city.fronts.filter((x) => !before.has(x.id))) {
      console.log(frontWords(city, f));
      console.log(`    влияния: ${JSON.stringify(f.links ?? [])}`);
      console.log(`    ставка: ${JSON.stringify(f.stake)}`);
      console.log(`    риск: ${f.risk}, отпечаток: ${f.footprint.map((x) => `${city.objects.find((o) => o.id === x.objectId)?.name} (${x.relation})`).join(', ')}`);
      if (f.resist?.length) console.log(`    против: ${f.resist.map((r) => `${city.objects.find((o) => o.id === r.objectId)?.name}${r.answered ? ' (способ снимает)' : ''}`).join(', ')}`);
    }
  }
  if (warns.length) console.log(`Предупреждения:\n  ${warns.join('\n  ')}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const pick = process.argv.slice(2);
  const settings = parseAgentSettings(readYaml('config/agents.yaml'));
  const calls: string[] = [];
  const base = {
    rules: parseRules(readYaml('config/game.yaml')),
    agents: { llm: metered(buildLlm(process.env)), settings, onCall: (e: AgentEvent) => void calls.push(e.agent) },
    scenarios: loadScenarios(),
  };
  const names = readYaml('config/names.yaml') as NamesFile;
  for (const c of ORDERS) if (!pick.length || pick.includes(c.name)) await runCase(c, base, names);
  console.log(`\nВызовы: ${calls.length}. Токены: вход ${total.inputTokens} (из кэша ${total.cachedInputTokens}, запись ${total.cacheWriteTokens}), выход ${total.outputTokens}. Цена: $${cost(total).toFixed(4)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
