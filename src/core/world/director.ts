/**
 * Режиссёр: решает, рождать ли новую беду или историю, и что именно, по характеру
 * происходящего. Моделей здесь нет.
 *
 * Жёсткая ось одна: тайна (заранее посажен скрытый объект или факт). Мягкие оси — двигатель,
 * источник причины и сфера города со своим сановником: режиссёр предпочитает то, чего давно
 * не было, и сановника, у которого меньше дел. Сколько бед уже висит без ответа, решает,
 * родится ли что-то вообще и не пора ли дать удобный случай вместо беды.
 */

import type { City, StoryMark, StoryTags } from '../city.js';
import type { Dynamic, Rules } from '../rules.js';
import { leadOf } from './assignments.js';

const LOG_MAX = 60;

export function dynamicTags(d: Pick<Dynamic, 'engine' | 'source' | 'sphere' | 'newHidden' | 'needsNew'>): StoryTags {
  return { engine: d.engine, source: d.source, sphere: d.sphere, mystery: d.needsNew && d.newHidden };
}

/** Записать рождённое в журнал режиссёра. */
export function markStory(city: City, tags: StoryTags, day: number): void {
  const log = (city.storyLog ??= []);
  log.push({ ...tags, day });
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}

function recent(rules: Rules, city: Pick<City, 'storyLog'>, day: number): Array<{ mark: StoryMark; w: number }> {
  const window = rules.fronts.director.windowDays;
  return (city.storyLog ?? [])
    .filter((m) => day - m.day < window && m.day <= day)
    .map((mark) => ({ mark, w: 1 - (day - mark.day) / window }));
}

/** Беды без ответа: угрозы и напряжения мира, которые никто не ведёт. */
export function unansweredTroubles(city: Pick<City, 'fronts' | 'assignments'>): number {
  return city.fronts.filter(
    (f) => f.status === 'active' && !f.plus && (f.form === 'threat' || f.form === 'tension') && f.origin !== 'player' && !leadOf(city, f.id),
  ).length;
}

/** Сколько дел ведёт сановник сферы. */
function officeLoad(rules: Rules, city: Pick<City, 'fronts' | 'assignments'>, sphere: StoryTags['sphere']): number {
  const office = rules.officers.find((o) => o.statId === sphere)?.office;
  if (!office) return 0;
  const active = new Set(city.fronts.filter((f) => f.status === 'active').map((f) => f.id));
  return city.assignments.filter((a) => a.status === 'active' && a.office === office && active.has(a.frontId)).length;
}

/** Доля тайн среди недавно рождённого. Пустой журнал — тайн нет. */
export function mysteryShare(rules: Rules, city: Pick<City, 'storyLog'>, day: number): number {
  const marks = recent(rules, city, day);
  const total = marks.reduce((acc, m) => acc + m.w, 0);
  return total > 0 ? marks.reduce((acc, m) => acc + (m.mark.mystery ? m.w : 0), 0) / total : 0;
}

/**
 * Насколько режиссёру хочется этой истории сейчас: множитель к весу жребия.
 * Повтор мягкой оси и занятый сановник делят вес, тайна тянется к желаемой доле.
 */
export function varietyWeight(rules: Rules, city: Pick<City, 'storyLog' | 'fronts' | 'assignments'>, tags: StoryTags, day: number): number {
  const d = rules.fronts.director;
  const marks = recent(rules, city, day);
  let weight = 1;
  for (const axis of ['engine', 'source', 'sphere'] as const) {
    const value = tags[axis];
    if (value == null) continue;
    const repeats = marks.reduce((acc, m) => acc + (m.mark[axis] === value ? m.w : 0), 0);
    weight /= 1 + d.repeatPenalty * repeats;
  }
  if (tags.sphere) weight /= 1 + d.loadPenalty * officeLoad(rules, city, tags.sphere);
  if (tags.mystery) weight *= mysteryShare(rules, city, day) < d.mysteryShare ? d.mysteryBoost : 1 / d.mysteryBoost;
  return weight;
}

/** Доля удобных случаев среди выпавшего: растёт с числом бед без ответа. */
export function plusChance(rules: Rules, city: Pick<City, 'fronts' | 'assignments'>): number {
  const d = rules.fronts.director;
  const load = Math.min(1, unansweredTroubles(city) / d.calmTroubles);
  return d.plusBase + (d.plusMax - d.plusBase) * load;
}

/** Можно ли сейчас родить новую беду мира (срыв, посев): пока бед без ответа меньше предела. */
export function roomForTrouble(rules: Rules, city: Pick<City, 'fronts' | 'assignments'>): number {
  return Math.max(0, 1 - unansweredTroubles(city) / rules.fronts.director.calmTroubles);
}

/** Чего давно не было: двигатель и источник с наименьшим недавним весом. Заказ свободным генераторам. */
export function leanOf(rules: Rules, city: Pick<City, 'storyLog' | 'fronts' | 'assignments'>, day: number, rng: () => number): StoryTags {
  const marks = recent(rules, city, day);
  const least = <T extends string>(values: readonly T[], axis: 'engine' | 'source' | 'sphere', extra: (v: T) => number = () => 0): T => {
    const scored = values.map((v) => ({ v, s: marks.reduce((acc, m) => acc + (m.mark[axis] === v ? m.w : 0), 0) + extra(v) + rng() * 0.5 }));
    scored.sort((a, b) => a.s - b.s);
    return (scored[0] as { v: T }).v;
  };
  const d = rules.fronts.director;
  const engines = Object.keys(d.engines) as Array<NonNullable<StoryTags['engine']>>;
  const sources = Object.keys(d.sources) as Array<NonNullable<StoryTags['source']>>;
  const spheres = rules.officers.map((o) => o.statId);
  return {
    engine: least(engines, 'engine'),
    source: least(sources, 'source'),
    sphere: least(spheres, 'sphere', (s) => officeLoad(rules, city, s)),
    mystery: mysteryShare(rules, city, day) < d.mysteryShare,
  };
}
