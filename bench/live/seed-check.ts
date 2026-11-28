/**
 * Живая сверка посева из узла: островок с бунтовщиками ушёл, бунтовщики ушли из города вместе с ним.
 * Вторая посадка должна взять в роль узел с прошлым: здесь это ушедшие бунтовщики.
 * Ходит в настоящие модели: запускать только по просьбе Ника.
 *
 *   npx tsx bench/live/seed-check.ts [--repeat N]
 */

import { ManualClock } from '../../src/adapters/clock/manual.js';
import { seededRandom } from '../../src/adapters/random/seeded.js';
import { MemoryStorage } from '../../src/adapters/storage/memory.js';
import { parseAgentSettings } from '../../src/agents/_shared/settings.js';
import type { City } from '../../src/core/city.js';
import { parseRules } from '../../src/core/rules.js';
import { activeFronts, frontGist } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { plantScenario } from '../../src/core/world/scenario.js';
import { nodeObjects } from '../../src/core/world/seamless.js';
import { applyStake } from '../../src/core/world/stake.js';
import { buildLlm, loadDotEnv, loadScenarios, readYaml } from '../../src/clients/app.js';
import { newId, type FlowDeps } from '../../src/flows/context.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { plantStory } from '../../src/flows/seeding.js';
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

async function run(seed: number, names: NamesFile): Promise<boolean> {
  const settings = parseAgentSettings(readYaml('config/agents.yaml'));
  const deps: FlowDeps = {
    rules: parseRules(readYaml('config/game.yaml')),
    agents: { llm: metered(buildLlm(process.env)), settings },
    scenarios: [],
    storage: new MemoryStorage(),
    clock: new ManualClock(Date.UTC(2026, 10, 1)),
    random: seededRandom(seed),
    notifier: { async send() {} },
  };
  const world = await ensureWorld(deps, { names });
  const city: City = blankCity({ worldId: world.id, brief: 'Летающий город рыбаков и кузнецов у кромки неба.' });
  const add = (type: Parameters<typeof createObject>[1]['type'], name: string, description: string, statEffect: Record<string, number> = {}) =>
    city.objects.push(createObject(deps.rules, { id: newId(deps, 'obj'), type, name, description, statEffect, day: 0 }));
  add('structure', 'Причалы у кромки', 'Каменные причалы на краю острова: сюда пристают небесные лодки и прибивает то, что несёт ветер.', { prosperity: 5 });
  add('organization', 'Городская стража', 'Две сотни стражников: караулы у ворот, обходы рынка.', { security: 12 });
  add('community', 'Рыбачья слобода', 'Семьи небесных рыбаков у кромки: сети, лодки, коптильни.', { prosperity: 5 });
  add('organization', 'Кузнечный ряд', 'Кузни и литейные мастерские: куют цепи, якоря, инструмент.', { prosperity: 5, security: 2 });
  const isle = loadScenarios().find((s) => s.id === 'lantern-isle')!;
  plantScenario(deps.rules, city, isle, { day: 0, newId: (p) => newId(deps, p) });
  const tower = city.objects.find((o) => o.name === 'Башня на островке')!;
  const island = city.objects.find((o) => o.name === 'Островок с горящими фонарями')!;
  const rebels = createObject(deps.rules, { id: newId(deps, 'obj'), type: 'community', name: 'Бунтовщики в башне', description: 'Два десятка беглых засели в башне, грабили причалы и звали к себе бедноту.', parentId: tower.id, day: 0 });
  city.objects.push(rebels);
  const cut = activeFronts(city)[0]!;
  // Покровитель велел сбить цепи: островок ушёл, бунтовщики ушли вместе с ним.
  applyStake(deps.rules, city, [{ op: 'delete', target: island.id }], { day: 40, newId: (p) => newId(deps, p), frontId: cut.id });
  rebels.log = [{ day: 40, text: 'Покровитель велел сбить цепи ночью, и островок с бунтовщиками унесло ветром.' }];
  refreshAllFronts(deps, city, 40);
  city.seeded = 1;
  console.log(`\n══ посев ${seed} ══\nузлы: ${nodeObjects(city).map((o) => o.name).join(', ') || '—'}`);
  await plantStory(deps, city, 120, 'trouble');
  const planted = activeFronts(city).filter((f) => f.createdDay === 120);
  for (const f of planted) console.log(`  ${f.form}: ${frontGist(f)} | участники: ${f.refs.map((id) => city.objects.find((o) => o.id === id)?.name ?? id).join(', ')}`);
  console.log(`  ${city.chronicle.at(-1)?.text ?? ''}`.slice(0, 400));
  const back = rebels.status === 'active';
  console.log(`  бунтовщики: ${back ? 'вернулись' : 'не взяты'}`);
  return back;
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const at = args.indexOf('--repeat');
  const repeat = at >= 0 ? Math.max(1, Number(args[at + 1]) || 1) : 1;
  const names = readYaml('config/names.yaml') as NamesFile;
  let bad = 0;
  for (let i = 0; i < repeat; i++) if (!(await run(7 + i, names))) bad++;
  console.log(`\nмимо: ${bad}. Токены: вход ${total.inputTokens} (из кэша ${total.cachedInputTokens}, запись ${total.cacheWriteTokens}), выход ${total.outputTokens}. Цена: $${cost(total).toFixed(4)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
