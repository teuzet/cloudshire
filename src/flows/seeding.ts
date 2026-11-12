/**
 * Посев историй: город досаживается до `seeding.activeStories` историй
 * (стройки игрока и их последствия не в счёт), пока бед без ответа меньше предела режиссёра.
 * Сажаем заготовку, которая тут ещё не играла, по жребию режиссёра (давно не бывшие оси, тайна
 * к желаемой доле, свободный сановник), подогнанную под город, или историю по зерну-заказу.
 */

import { scheduleJob } from '../core/jobs.js';
import type { Change } from '../core/world/changes.js';
import { activeFronts } from '../core/world/fronts.js';
import { leadOf } from '../core/world/assignments.js';
import { rawToPoints } from '../core/world/numbers.js';
import { mysteryObjectIds } from '../core/lore.js';
import type { City, StoryTags } from '../core/city.js';
import { leanOf, markStory, roomForTrouble, varietyWeight } from '../core/world/director.js';
import { weightedOrder } from '../core/world/dynamics.js';
import { plantScenario, scenarioTags, touchedMysteries, type Scenario } from '../core/world/scenario.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { writeScenario } from '../agents/scenario-writer/run.js';
import { record } from './chronicle.js';
import { namesUsed, newId, returnNames, takeNames, tryAgent, type FlowDeps } from './context.js';
import { refreshFront } from './fronts.js';

/** Зерно для истории без заготовки: то, чего режиссёр давно не видел. */
function seedWords(deps: FlowDeps, tags: StoryTags): string {
  const d = deps.rules.fronts.director;
  const sphere = tags.sphere ? deps.rules.stats.find((s) => s.id === tags.sphere)?.name : null;
  return [
    tags.engine ? `История, в которой ${d.engines[tags.engine]}.` : null,
    tags.source ? `Причина: ${d.sources[tags.source]}.` : null,
    sphere ? `Больше всего она касается того, что в городе зовут «${sphere}».` : null,
    tags.mystery ? 'В ней заранее спрятан ключевой объект или факт, который откроется по ходу.' : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Сколько историй живо: фронт истории, который идёт сам (угроза, напряжение) или кем-то ведётся,
 * считается целым; поиск и дело, за которые никто не взялся, — половиной. Так ждущие игрока
 * истории не глушат посев, но и не копятся без меры.
 */
export function storyCount(city: City): number {
  return activeFronts(city)
    .filter((f) => f.origin === 'story')
    .reduce((acc, f) => acc + (f.form === 'threat' || f.form === 'tension' || leadOf(city, f.id) ? 1 : 0.5), 0);
}

/** Посадить одну историю: заготовку из deps.scenarios, которая тут ещё не играла, или по зерну. */
export async function plantStory(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage | null> {
  const fresh = deps.scenarios.filter((s) => !city.scenariosUsed.includes(s.id));
  const template = weightedOrder(fresh, (s) => varietyWeight(deps.rules, city, scenarioTags(s), day), deps.random.rng)[0] ?? null;
  const lean = template ? null : leanOf(deps.rules, city, day, deps.random.rng);
  const names = await takeNames(deps, deps.rules.seeding.namesPerCall);
  const scenario: Scenario | null = await tryAgent(
    deps,
    'scenario-writer',
    () =>
      writeScenario(deps.agents, {
        cityBrief: city.brief,
        objects: city.objects.filter((o) => o.status === 'active'),
        template,
        seed: lean ? seedWords(deps, lean) : null,
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

  const tags = scenarioTags(scenario);
  markStory(city, lean ? { ...lean, mystery: tags.mystery } : tags, day);
  const { objects, fronts } = plantScenario(deps.rules, city, scenario, { day, newId: (p) => newId(deps, p) });
  for (const front of fronts) refreshFront(deps, city, front, day);
  // Скрытое в истории город пока не видел: оно не идёт ни в весть, ни в хронику.
  const seen = objects.filter((o) => !o.hidden);
  const gist = [...seen.map((o) => `${o.name}. ${o.description}`), ...(seen.length ? [] : fronts.map((f) => f.description))].join('\n');
  const changes: Change[] = seen.map((o) => ({
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
  const room = roomForTrouble(deps.rules, city) > 0;
  const need = room ? Math.max(0, Math.floor(deps.rules.seeding.activeStories - storyCount(city))) : 0;
  for (let i = 0; i < need; i++) {
    const msg = await plantStory(deps, city, day);
    if (msg) out.push(msg);
  }
  scheduleJob(city, { id: newId(deps, 'job'), kind: 'seed', dueDay: day + deps.rules.seeding.checkEveryDays });
  return out;
}
