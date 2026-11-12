/**
 * Посев историй: в городе должно идти не меньше `seeding.activeStories` историй
 * (стройки игрока и их последствия не в счёт). Не хватает — сажаем новую:
 * заготовку, которая тут ещё не играла, подогнанную под город, или историю по зерну.
 */

import type { City } from '../core/city.js';
import { scheduleJob } from '../core/jobs.js';
import type { Change } from '../core/world/changes.js';
import { activeFronts } from '../core/world/fronts.js';
import { rawToPoints } from '../core/world/numbers.js';
import { mysteryObjectIds } from '../core/lore.js';
import { plantScenario, touchedMysteries, type Scenario } from '../core/world/scenario.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { writeScenario } from '../agents/scenario-writer/run.js';
import { record } from './chronicle.js';
import { namesUsed, newId, returnNames, takeNames, tryAgent, type FlowDeps } from './context.js';
import { refreshFront } from './fronts.js';

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function storyCount(city: City): number {
  return activeFronts(city).filter((f) => f.origin === 'story').length;
}

/** Посадить одну историю: заготовку из deps.scenarios, которая тут ещё не играла, или по зерну. */
export async function plantStory(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage | null> {
  const template = shuffled(deps.scenarios, deps.random.rng).find((s) => !city.scenariosUsed.includes(s.id)) ?? null;
  const names = await takeNames(deps, deps.rules.seeding.namesPerCall);
  const scenario: Scenario | null = await tryAgent(
    deps,
    'scenario-writer',
    () =>
      writeScenario(deps.agents, {
        cityBrief: city.brief,
        objects: city.objects.filter((o) => o.status === 'active'),
        template,
        seed: null,
        names,
        unknowns: city.unknowns,
      }),
    template,
  );
  // История по зерну получает свой id: заготовки он не повторит.
  if (scenario && !template) scenario.id = newId(deps, 'story');
  // Тайны острова закрыты для посадок: это проверяет и агент, но запасная заготовка идёт мимо него.
  if (!scenario || city.scenariosUsed.includes(scenario.id) || touchedMysteries(scenario, mysteryObjectIds(city)).length) {
    await returnNames(deps, names);
    return null;
  }
  const used = namesUsed(names, JSON.stringify(scenario));
  await returnNames(deps, names.filter((n) => !used.includes(n)));

  const { objects, fronts } = plantScenario(deps.rules, city, scenario, { day, newId: (p) => newId(deps, p) });
  for (const front of fronts) refreshFront(deps, city, front, day);
  const gist = [...objects.map((o) => `${o.name}. ${o.description}`), ...(objects.length ? [] : fronts.map((f) => f.description))].join('\n');
  const changes: Change[] = objects.map((o) => ({
    kind: 'object_created',
    objectId: o.id,
    name: o.name,
    type: o.type,
    points: rawToPoints(city, o.statEffect),
    temporary: false,
    hidden: o.hidden,
  }));
  return record(deps, city, { gist: gist || scenario.pitch || scenario.title, changes, source: 'scenario', frontId: fronts[0]?.id ?? null, day, kind: 'beat', officer: null, announce: true });
}

/** Задание seed: досадить историй и поставить следующую проверку. */
export async function seedStories(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  const need = Math.max(0, deps.rules.seeding.activeStories - storyCount(city));
  for (let i = 0; i < need; i++) {
    const msg = await plantStory(deps, city, day);
    if (msg) out.push(msg);
  }
  scheduleJob(city, { id: newId(deps, 'job'), kind: 'seed', dueDay: day + deps.rules.seeding.checkEveryDays });
  return out;
}
