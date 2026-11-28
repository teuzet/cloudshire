/**
 * Посев историй: город досаживается до `seeding.activeStories` историй
 * (стройки игрока и их последствия не в счёт), пока бед без ответа меньше предела режиссёра.
 * Сажаем заготовку, которая тут ещё не играла, по жребию режиссёра (давно не бывшие оси, тайна
 * к желаемой доле, свободный сановник), подогнанную под город, или историю по зерну-заказу.
 */

import { scheduleJob } from '../core/jobs.js';
import type { Change } from '../core/world/changes.js';
import { activeFronts, closeFront, endersOf } from '../core/world/fronts.js';
import { leadOf } from '../core/world/assignments.js';
import { monthsToDays, rawToPoints } from '../core/world/numbers.js';
import { mysteryObjectIds } from '../core/lore.js';
import { nearWords } from '../core/world/links.js';
import type { City, StoryTags, WorldObject } from '../core/city.js';
import { IMPACT_LEVELS, SCALES, type Scale } from '../core/rules.js';
import { leanOf, markStory, roomForTrouble, varietyWeight, wantsChance, wantsTrouble } from '../core/world/director.js';
import { isDeparted, pullOf } from '../core/world/objects.js';
import { bringBack, nodeObjects } from '../core/world/seamless.js';
import { weightedOrder } from '../core/world/dynamics.js';
import { plantScenario, scenarioTags, storyKind, touchedMysteries, type Scenario } from '../core/world/scenario.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { rolesTaken, writeScenario } from '../agents/scenario-writer/run.js';
import { record } from './chronicle.js';
import { namesUsed, newId, returnNames, takeNames, tryAgent, withNamer, type FlowDeps } from './context.js';
import { refreshFront } from './fronts.js';

/** История по зерну: не больше freeMaxFronts фронтов и freeMaxDrifting идущих к сроку. */
export function trimFree(deps: Pick<FlowDeps, 'rules'>, s: Scenario): Scenario {
  const { freeMaxFronts, freeMaxDrifting, freeMaxImpact } = deps.rules.seeding;
  const cap = IMPACT_LEVELS.indexOf(freeMaxImpact);
  let drifting = 0;
  const fronts = s.fronts.filter((f) => {
    if (f.drift === 'NONE') return true;
    drifting += 1;
    return drifting <= freeMaxDrifting;
  }).slice(0, freeMaxFronts);
  const ids = new Set(fronts.map((f) => f.id));
  return {
    ...s,
    fronts: fronts.map((f) => ({
      ...f,
      impact: IMPACT_LEVELS.indexOf(f.impact) > cap ? freeMaxImpact : f.impact,
      closes: f.closes.filter((c) => ids.has(c.target)),
    })),
  };
}

type Kind = 'trouble' | 'chance';

/** История по зерну под заказанный знак: у возможности убираются фронты, идущие к сроку сами. */
function ofKind(s: Scenario, kind: Kind | null): Scenario | null {
  if (kind !== 'chance') return s;
  const fronts = s.fronts.filter((f) => f.drift === 'NONE');
  if (!fronts.length) return null;
  const ids = new Set(fronts.map((f) => f.id));
  return { ...s, fronts: fronts.map((f) => ({ ...f, closes: f.closes.filter((c) => ids.has(c.target)) })) };
}

/** Масштаб истории по зерну: жребий по весам, не выше freeMaxScale. */
function freeScale(deps: FlowDeps): Scale {
  const table = deps.rules.seeding.scale;
  const allowed = SCALES.slice(0, SCALES.indexOf(deps.rules.seeding.freeMaxScale) + 1);
  return weightedOrder(allowed, (s) => table[s].weight, deps.random.rng)[0] ?? 'situation';
}

/**
 * Вокруг чего город живёт сейчас: узлы с прошлым, которые ещё не сыграли снова (их тяга не сходит),
 * потом видимые объекты с самой сильной тягой.
 */
function focusNames(city: City, day: number): string[] {
  const nodes = nodeObjects(city).filter((o) => o.status === 'active');
  const pulled = city.objects
    .filter((o) => o.status === 'active' && !o.hidden && !o.temporary && pullOf(o, day) > 0)
    .sort((a, b) => pullOf(b, day) - pullOf(a, day));
  return [...new Set([...nodes, ...pulled].map((o) => o.name))].slice(0, 4);
}

/** Что с объектом было: последние строки его памяти, чтобы новая история помнила старую. */
function pastWords(o: WorldObject): string {
  return o.log?.length ? `Что с этим было: ${o.log.slice(-2).map((l) => l.text).join(' / ')}` : '';
}

/** Объекты для посевщика: стоящие в городе с окрестностью и ушедшие стороны, которые могут вернуться; у всех память. */
function writerObjects(city: City): WorldObject[] {
  return city.objects
    .filter((o) => o.status === 'active' || isDeparted(o))
    .map((o) => ({
      ...o,
      status: 'active' as const,
      description: [o.description, isDeparted(o) ? `Сейчас их в городе нет: ушли после «${o.out?.cause}».` : nearWords(city, o, true), pastWords(o)].filter(Boolean).join(' '),
    }));
}

/** Зерно для истории без заготовки: то, чего режиссёр давно не видел, и о другом, чем то, что уже идёт. */
function seedWords(deps: FlowDeps, city: City, tags: StoryTags, kind: Kind | null): string {
  const running = activeFronts(city).filter((f) => f.origin === 'story' || f.origin === 'complication').map((f) => f.title);
  const d = deps.rules.fronts.director;
  const sphere = tags.sphere ? d.spheres[tags.sphere] : null;
  return [
    tags.engine ? `История, в которой ${d.engines[tags.engine]}.` : null,
    tags.source ? `Причина: ${d.sources[tags.source]}.` : null,
    sphere ? `Больше всего она касается того, чем город живёт: ${sphere}.` : null,
    kind === 'chance' ? 'Это удача для города: находка, гость, редкий случай или дар, которым можно воспользоваться, пока он рядом. Все фронты без дрейфа (drift NONE), с выигрышем в ставке.' : null,
    tags.mystery ? 'В ней заранее спрятан ключевой объект или факт, который откроется по ходу.' : null,
    running.length ? `В городе уже идёт: ${running.join('; ')}. Эта история о другом: свои люди, своё место и своя причина.` : null,
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
    // Часы истории — её срок, а не отдельная история.
    .filter((f) => f.origin === 'story' && f.form !== 'clock')
    .reduce((acc, f) => acc + (f.form === 'threat' || f.form === 'tension' || leadOf(city, f.id) ? 1 : 0.5), 0);
}

/** Посадить одну историю: заготовку, которая тут ещё не играла, или по зерну. `kind` — заказанный знак, без него любой. */
export async function plantStory(deps: FlowDeps, city: City, day: number, kind: Kind | null = null): Promise<OutboundMessage | null> {
  return withNamer(deps, (d) => plant(d, city, day, kind));
}

async function plant(deps: FlowDeps, city: City, day: number, kind: Kind | null): Promise<OutboundMessage | null> {
  const fresh = deps.scenarios.filter((s) => !city.scenariosUsed.includes(s.id) && (!kind || storyKind(s) === kind));
  const uniform = deps.rules.fronts.director.uniform;
  const template = weightedOrder(fresh, (s) => (uniform ? 1 : varietyWeight(deps.rules, city, scenarioTags(s), day)) * deps.rules.seeding.scale[s.scale ?? 'situation'].weight, deps.random.rng)[0] ?? null;
  const lean = template ? null : leanOf(deps.rules, city, day, deps.random.rng);
  const names = await takeNames(deps, deps.rules.seeding.namesPerCall);
  // Каждая N-я история растёт из узла с прошлым, если такой есть: мир тянется, а не делится на эпизоды.
  const every = deps.rules.seeding.nodeEvery;
  const grow = every > 0 && (city.seeded ?? 0) % every === every - 1 ? nodeObjects(city).slice(0, 6) : [];
  const scenario: Scenario | null = await tryAgent(
    deps,
    'scenario-writer',
    () =>
      writeScenario(deps.agents, {
        cityBrief: city.brief,
        // Сценарист видит окрестность (что где стоит, что чем удержано и что на чём держится) и память объектов.
        objects: writerObjects(city),
        grow: grow.map((o) => ({ id: o.id, name: o.name })),
        template,
        seed: lean ? seedWords(deps, city, lean, kind) : null,
        names,
        unknowns: city.unknowns,
        focus: focusNames(city, day),
      }),
    template,
  );
  // История по зерну получает свой id (заготовки он не повторит), масштаб по жребию и заказанный знак.
  const free = scenario && !template ? ofKind(trimFree(deps, scenario), kind) : null;
  if (free) {
    free.id = newId(deps, 'story');
    free.scale = freeScale(deps);
  }
  const planted = template ? scenario : free;
  // Тайны острова закрыты для посадок: это проверяет и агент, но запасная заготовка идёт мимо него.
  if (!planted || city.scenariosUsed.includes(planted.id) || touchedMysteries(planted, mysteryObjectIds(city)).length) {
    await returnNames(deps, names);
    return null;
  }
  const used = namesUsed(names, JSON.stringify(planted));
  await returnNames(deps, names.filter((n) => !used.includes(n)));

  const tags = scenarioTags(planted);
  markStory(city, lean ? { ...lean, mystery: tags.mystery } : tags, day, { kind: storyKind(planted), scale: planted.scale ?? null });
  // Ушедшая сторона, которую история взяла в роль, возвращается в город.
  const taken = rolesTaken(planted);
  const back = city.objects.filter((o) => taken.has(o.id) && isDeparted(o)).flatMap((o) => bringBack(city, o, day));
  const { objects, fronts } = plantScenario(deps.rules, city, planted, { day, newId: (p) => newId(deps, p), namer: deps.namer ?? null });
  // Сыгранные снова узлы больше не ждут: узлом их сделает новое прошлое.
  for (const o of city.objects) if (taken.has(o.id) && o.status === 'active') o.playedDay = day;
  city.seeded = (city.seeded ?? 0) + 1;
  for (const front of fronts) refreshFront(deps, city, front, day);
  // Скрытое в истории город пока не видел: оно не идёт ни в весть, ни в хронику.
  const seen = objects.filter((o) => !o.hidden);
  const gist = [...seen.map((o) => `${o.name}. ${o.description}`), ...(seen.length ? [] : fronts.map((f) => f.description))].join('\n');
  const changes: Change[] = [...back, ...seen.map((o): Change => ({
    kind: 'object_created',
    objectId: o.id,
    name: o.name,
    type: o.type,
    points: rawToPoints(city, o.statEffect),
    temporary: false,
    hidden: o.hidden,
    story: true,
  }))];
  return record(deps, city, { gist: gist || planted.pitch || planted.title, changes, source: 'scenario', frontId: fronts[0]?.id ?? null, day, kind: 'beat', officer: null, announce: true });
}

/**
 * Нетронутые поиски и дела историй, за которые так никто и не взялся, тихо уходят из дел города.
 * Удобный случай без срока забывается раньше; то, с чем он пришёл, остаётся в городе.
 * Пока срок идёт, решает он; случай, чей срок удержали, ждёт как обычный поиск.
 */
export function fadeDormant(deps: Pick<FlowDeps, 'rules'>, city: City, day: number): void {
  const chanceDays = monthsToDays(deps.rules.seeding.chanceMonths);
  for (const f of activeFronts(city)) {
    if (f.origin !== 'story' || (f.form !== 'find' && f.form !== 'deed') || leadOf(city, f.id)) continue;
    const enders = endersOf(city, f);
    if (enders.some((e) => e.deadlineDay != null)) continue;
    const wait = f.plus && !enders.length ? chanceDays : deps.rules.seeding.dormantDays;
    if (f.progress > 0 || day - f.createdDay < wait) continue;
    closeFront(deps.rules, city, f, 'cancelled', day);
  }
}

/** Задание seed: досадить историй и поставить следующую проверку. */
export async function seedStories(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  fadeDormant(deps, city, day);
  // activeStories — потолок числа историй. За проверку приходит не больше одной беды и одной возможности:
  // беда — пока город получает меньше работы над бедами, чем хочет режиссёр, и у него есть место;
  // возможность — пока их посажено меньше, чем бед. Между посадками не меньше storyGapDays дней.
  const rested = () => {
    const last = Math.max(-Infinity, ...(city.storyLog ?? []).filter((m) => m.kind).map((m) => m.day));
    return day - last >= deps.rules.seeding.storyGapDays;
  };
  const room = () => rested() && storyCount(city) < deps.rules.seeding.activeStories;
  // Возможность — и до беды, и после: при редких посадках (storyGapDays) иначе приходили бы одни беды.
  const chance = async () => {
    if (!room() || !wantsChance(deps.rules, city, day)) return;
    const msg = await plantStory(deps, city, day, 'chance');
    if (msg) out.push(msg);
  };
  await chance();
  if (room() && roomForTrouble(deps.rules, city) > 0 && wantsTrouble(deps.rules, city, day)) {
    const msg = await plantStory(deps, city, day, 'trouble');
    if (msg) out.push(msg);
  }
  await chance();
  scheduleJob(city, { id: newId(deps, 'job'), kind: 'seed', dueDay: day + deps.rules.seeding.checkEveryDays });
  return out;
}
