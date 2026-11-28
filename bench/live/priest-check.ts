/**
 * Живая сверка жреца на приказах с условием: ставит ли он поручение в очередь с условием и тем,
 * за чем следить, и отдаёт ли простой приказ сразу. Инструменты здесь только записывают вызовы:
 * мир не меняется. Ходит в настоящие модели: запускать только по просьбе Ника.
 *
 *   npx tsx bench/live/priest-check.ts [--repeat N]
 */

import { parseAgentSettings } from '../../src/agents/_shared/settings.js';
import type { AgentDeps } from '../../src/agents/_shared/runtime.js';
import { runPriestTurn, type PriestHandlers, type ToolOutcome } from '../../src/agents/priest/run.js';
import { buildLlm, loadDotEnv, readYaml } from '../../src/clients/app.js';
import { parseRules } from '../../src/core/rules.js';
import { createFront } from '../../src/core/world/fronts.js';
import { createObject } from '../../src/core/world/objects.js';
import { recomputeStats } from '../../src/core/world/stats.js';
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

interface PriestCase {
  name: string;
  message: string;
  /** null — поручение отдают сразу, без условия; иначе — какие id должны быть среди отслеживаемых. */
  watch: string[] | null;
}

const CASES: PriestCase[] = [
  { name: 'цепи, если бунт пойдёт на склады', message: 'Если бунтовщики с цепных дворов пойдут на склады, пусть Борислав сбивает цепи на мосту.', watch: ['riot'] },
  { name: 'пристань, когда бунт утихнет', message: 'Когда бунт на цепных дворах утихнет, пусть Ада чинит пристань.', watch: ['riot'] },
  { name: 'ополчение, если придут с моря', message: 'Если с моря придут чужие корабли, пусть Борислав поднимает ополчение.', watch: [] },
  { name: 'цепи сразу', message: 'Пусть Борислав сбивает цепи на мосту, пока бунтовщики не пошли на склады.', watch: null },
];

function town() {
  const rules = parseRules(readYaml('config/game.yaml'));
  const city = blankCity();
  city.objects.push(
    createObject(rules, { id: 'yards', type: 'district', name: 'Цепные дворы', description: 'Кузни и склады цепей у восточного края.', day: 0 }),
    createObject(rules, { id: 'rebels', type: 'community', name: 'Бунтовщики с цепных дворов', description: 'Кузнецы, которым третий месяц не платят.', parentId: 'yards', day: 0 }),
    createObject(rules, { id: 'stores', type: 'building', name: 'Склады у пристани', description: 'Зерно и соль города.', statEffect: { prosperity: 5 }, day: 0 }),
    createObject(rules, { id: 'chains', type: 'structure', name: 'Цепной мост', description: 'Мост на цепях от цепных дворов к пристани.', day: 0 }),
    createObject(rules, { id: 'pier', type: 'structure', name: 'Пристань', description: 'Старая пристань для лодок.', day: 0 }),
  );
  city.fronts.push(
    createFront({ id: 'riot', form: 'threat', origin: 'story', title: 'Бунт на цепных дворах', description: 'Бунтовщики с цепных дворов грозят пойти на склады у пристани.', capacity: 8, deadlineDay: 90, refs: ['rebels', 'stores'], failStake: [{ op: 'stats', points: { prosperity: -3 } }], day: 0 }),
  );
  recomputeStats(city, rules);
  return { rules, city };
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const at = args.indexOf('--repeat');
  const repeat = at >= 0 ? Math.max(1, Number(args[at + 1]) || 1) : 1;
  const settings = parseAgentSettings(readYaml('config/agents.yaml'));
  const deps: AgentDeps = { llm: metered(buildLlm(process.env)), settings };
  let bad = 0;
  for (const c of CASES) {
    for (let i = 0; i < repeat; i++) {
      const { rules, city } = town();
      const calls: string[] = [];
      let queued: { condition?: string; watch?: string[]; office: string | null; task: string } | null = null;
      const ok = (say: string): Promise<ToolOutcome> => Promise.resolve({ ok: true, say });
      const handlers: PriestHandlers = {
        assignOfficer: (a) => (calls.push(`assign ${a.office}: ${a.task}`), ok('Дело начато.')),
        orderChange: (a) => (calls.push(`change ${a.office}: ${a.intent}`), ok('Дело начато.')),
        withdraw: (a) => (calls.push(`withdraw ${a.office}`), ok('Снят.')),
        writeNote: (a) => (calls.push(`note ${a.text}`), ok('Запомнил.')),
        queueOrder: (a) => {
          queued = a;
          calls.push(`queue ${a.office ?? 'любой'}: ${a.task}${a.condition ? ` | когда: ${a.condition} | следить: ${(a.watch ?? []).join(', ') || '—'}` : ''}`);
          return ok(a.condition ? `Поручение ждёт условия «${a.condition}».` : 'Поручение в очереди.');
        },
        unqueue: () => ok('Убрано.'),
        setStandingOrder: (a) => (calls.push(`standing ${a.mode}`), ok('Наказ принят.')),
        consultLoremaster: () => ok('Лормастер молчит.'),
        checkExistence: (a) => (calls.push(`exists ${a.thing}`), ok(`Это есть в городе: ${a.thing}.`)),
      };
      const turn = await runPriestTurn(deps, { rules, city, day: 0, message: c.message, quote: null }, handlers);
      const q = queued as { condition?: string; watch?: string[] } | null;
      const good =
        c.watch === null
          ? !q?.condition && calls.some((l) => l.startsWith('assign') || l.startsWith('change'))
          : Boolean(q?.condition) && c.watch.every((id) => (q?.watch ?? []).includes(id)) && (c.watch.length > 0 || !(q?.watch ?? []).length);
      if (!good) bad++;
      console.log(`${good ? '✓' : '✗'} ${c.name}\n    ${calls.join('\n    ') || 'без вызовов'}\n    речь: ${turn.reply.slice(0, 220)}`);
    }
  }
  console.log(`\nмимо: ${bad}. Токены: вход ${total.inputTokens} (из кэша ${total.cachedInputTokens}, запись ${total.cacheWriteTokens}), выход ${total.outputTokens}. Цена: $${cost(total).toFixed(4)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
