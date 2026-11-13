/**
 * Сценарий — заготовка, которая один раз сажает в город объекты и фронты.
 * Дальше они живут сами; у истории нет собственной механики.
 *
 * Локальные id сценария («tower») при посадке получают глобальные, и все
 * ссылки и цели ставок переписываются на них.
 */

import { clipWords } from '../text.js';
import { z } from 'zod';
import { DRIFT_BANDS, ENGINES, IMPACT_LEVELS, OBJECT_TYPES, SCALES, SOURCES, STAT_IDS, type Rules, type StatMap } from '../rules.js';
import type { City, Front, StakeOp, StoryTags, WorldObject } from '../city.js';
import { createFront } from './fronts.js';
import { magnitude, monthsToDays, rawToPoints, scaleOf, threatCapacity, troubleDays } from './numbers.js';
import { createObject, scalePull, tug } from './objects.js';
import { objectContribution } from './stats.js';

const statPartial = z.object(Object.fromEntries(STAT_IDS.map((id) => [id, z.number().optional()])));

const stakeSchema = z.union([
  z.object({
    create: z.object({
      type: z.enum(OBJECT_TYPES),
      name: z.string(),
      description: z.string().default(''),
      weight: z.enum(IMPACT_LEVELS).optional(),
      statProfile: statPartial.optional(),
      refs: z.array(z.string()).optional(),
    }),
  }),
  z.object({ modify: z.object({ target: z.string(), intent: z.string().optional() }) }),
  z.object({ delete: z.object({ target: z.string() }) }),
  z.object({ stats: statPartial }),
  z.object({ reveal: z.object({ text: z.string() }) }),
  /** Открыть игроку скрытый объект истории. */
  z.object({ uncover: z.object({ target: z.string() }) }),
]);

const scenarioBase = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Короткая подсказка, когда сценарий уместен. Видит только посевщик. */
  pitch: z.string().default(''),
  objects: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum(OBJECT_TYPES),
        name: z.string().min(1),
        description: z.string().default(''),
        refs: z.array(z.string()).default([]),
        /** Вклад объекта в статы: уровень значимости и профиль. Без них объект ничего не даёт. */
        weight: z.enum(IMPACT_LEVELS).optional(),
        statProfile: statPartial.optional(),
        /** Скрыт от игрока, пока его не откроет фронт. */
        hidden: z.boolean().optional(),
      }),
    )
    .default([]),
  fronts: z
    .array(
      z.object({
        id: z.string().min(1),
        /** Короткое имя фронта, как его назовёт город. Без него берётся первая фраза описания. */
        title: z.string().optional(),
        /**
         * Род фронта. Без дрейфа: find (поиск, исход раскрывается работой) или deed (дело с известной целью).
         * С дрейфом: threat (беда случится к сроку) или tension (недовольство прорвётся к сроку).
         * Без поля: find без дрейфа, threat с дрейфом.
         */
        form: z.enum(['find', 'deed', 'threat', 'tension']).optional(),
        description: z.string().min(1),
        impact: z.enum(IMPACT_LEVELS),
        drift: z.enum(DRIFT_BANDS).default('NONE'),
        beatCount: z.number().int().nonnegative().default(0),
        refs: z.array(z.string()).default([]),
        alignment: z.string().default(''),
        stake: stakeSchema.nullable().default(null),
        /**
         * Чем этот фронт по завершении двигает другие фронты истории: доля их ёмкости (1 — до конца).
         * Беду это отводит, поиск или дело доводит до их собственной ставки. Цена входит в ёмкость.
         */
        closes: z.array(z.object({ target: z.string().min(1), share: z.number().min(0.05).max(1) })).default([]),
        events: z.array(z.object({ id: z.string(), description: z.string() })).default([]),
        clues: z.array(z.object({ id: z.string(), fact: z.string(), alignment: z.string().default('') })).default([]),
      }),
    )
    .min(1),
});

type ScenarioBase = z.infer<typeof scenarioBase>;

function checkScenario(s: ScenarioBase, ctx: z.RefinementCtx): void {
  const ids = new Set(s.fronts.map((f) => f.id));
  s.fronts.forEach((f, i) => {
    f.closes.forEach((c, j) => {
      if (!ids.has(c.target) || c.target === f.id) ctx.addIssue({ code: 'custom', path: ['fronts', i, 'closes', j, 'target'], message: 'closes ведёт на другой фронт этой истории' });
    });
    if (f.closes.length && f.drift !== 'NONE') ctx.addIssue({ code: 'custom', path: ['fronts', i, 'closes'], message: 'closes бывает только у фронта без дрейфа: толчок случается при завершении' });
    if (!f.form) return;
    const drifting = f.drift !== 'NONE';
    if (drifting !== (f.form === 'threat' || f.form === 'tension')) {
      ctx.addIssue({ code: 'custom', path: ['fronts', i, 'form'], message: drifting ? 'у фронта с дрейфом род threat или tension' : 'у фронта без дрейфа род find или deed' });
    }
  });
}

/** Оси режиссёра у заготовки: двигатель, источник причины, сфера города. Тайну код выводит сам. */
const axesSchema = z.object({ engine: z.enum(ENGINES), source: z.enum(SOURCES), sphere: z.enum(STAT_IDS) });

/** Файл заготовки: с осями режиссёра и масштабом истории. */
export const scenarioSchema = scenarioBase.extend({ axes: axesSchema.optional(), scale: z.enum(SCALES).optional() }).superRefine(checkScenario);
/** То, что пишет посевщик: оси ему не нужны, их ставит код. */
export const scenarioDraftSchema = scenarioBase.superRefine(checkScenario);

export type Scenario = z.infer<typeof scenarioSchema>;

/** Оси истории для режиссёра. Тайна: скрытый объект, ставка «вскрыть» или «узнать», улики. */
export function scenarioTags(s: Scenario): StoryTags {
  const mystery =
    s.objects.some((o) => o.hidden) || s.fronts.some((f) => f.clues.length > 0 || (f.stake != null && ('uncover' in f.stake || 'reveal' in f.stake)));
  return { engine: s.axes?.engine ?? null, source: s.axes?.source ?? null, sphere: s.axes?.sphere ?? null, mystery };
}

/** Знак истории: беда, если хоть один её фронт идёт к сроку сам; иначе возможность. */
export function storyKind(s: Pick<Scenario, 'fronts'>): 'trouble' | 'chance' {
  return s.fronts.some((f) => f.drift !== 'NONE') ? 'trouble' : 'chance';
}

export function parseScenario(raw: unknown): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`сценарий: ${issue ? issue.path.join('.') : '?'}: ${issue?.message ?? 'неверно'}`);
  }
  return parsed.data;
}

function times(points: Partial<StatMap>, k: number): StatMap {
  const out = { prosperity: 0, security: 0, knowledge: 0, influence: 0 };
  for (const id of STAT_IDS) out[id] = Math.round((Number(points[id]) || 0) * k * 10) / 10;
  return out;
}

/** Ставка заготовки на языке операций новой системы. `k` — множитель чисел от масштаба истории. */
function stakeOps(rules: Rules, city: Pick<City, 'statScale'>, stake: Scenario['fronts'][number]['stake'], ids: Map<string, string>, k = 1): StakeOp[] {
  if (!stake) return [];
  const map = (id: string) => ids.get(id) ?? id;
  if ('create' in stake) {
    const c = stake.create;
    const points = times(rawToPoints(city, objectContribution(rules, c.weight ?? 'NONE', c.statProfile ?? {})), k);
    return [{ op: 'create', object: { type: c.type, name: c.name, description: c.description, points, refs: (c.refs ?? []).map(map) }, result: true }];
  }
  if ('modify' in stake) return [{ op: 'modify', target: map(stake.modify.target), intent: stake.modify.intent ?? '' }];
  if ('delete' in stake) return [{ op: 'delete', target: map(stake.delete.target) }];
  if ('stats' in stake) return [{ op: 'stats', points: k === 1 ? stake.stats : times(stake.stats, k) }];
  if ('uncover' in stake) return [{ op: 'reveal', target: map(stake.uncover.target) }];
  return [{ op: 'fact', text: stake.reveal.text }];
}

/** Ходы ключа из скрытой логики заготовки: по фразе на ход, плюс подходы к уликам. */
function keyMoves(alignment: string, clues: ReadonlyArray<{ alignment: string }>): string[] {
  const lines = alignment
    .split(/(?<=[.!?])\s+|\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3);
  return [...new Set([...lines, ...clues.map((c) => c.alignment.trim()).filter(Boolean)])].slice(0, 8);
}

/**
 * Посадить сценарий в город. `adapted` — правки посевщика под конкретный город
 * (названия и описания), по локальному id; всё остальное берётся из заготовки.
 */
export function plantScenario(
  rules: Rules,
  city: City,
  scenario: Scenario,
  args: {
    day: number;
    newId: (prefix: string) => string;
    adapted?: Record<string, { name?: string; description?: string }>;
  },
): { objects: WorldObject[]; fronts: Front[] } {
  const ids = new Map<string, string>();
  for (const o of scenario.objects) ids.set(o.id, args.newId('obj'));
  for (const f of scenario.fronts) ids.set(f.id, args.newId('front'));
  const map = (id: string) => ids.get(id) ?? id;
  const tweak = args.adapted ?? {};

  const pull = scalePull(rules, scenario.scale, args.day);
  const objects = scenario.objects.map((o) => {
    const obj = createObject(rules, {
      id: map(o.id),
      type: o.type,
      name: tweak[o.id]?.name ?? o.name,
      description: tweak[o.id]?.description ?? o.description,
      refs: o.refs.map(map),
      statEffect: objectContribution(rules, o.weight ?? 'NONE', o.statProfile ?? {}),
      hidden: o.hidden ?? false,
      day: args.day,
    });
    tug(obj, pull);
    return obj;
  });
  type F = Scenario['fronts'][number];
  const drifts = (f: F) => f.drift !== 'NONE';
  // Числа в файле — доли: масштаб истории задаёт, сколько пунктов статов на кону всего.
  // Удар бед и выигрыш считаются отдельно, каждый тянется к бюджету масштаба.
  const statsSize = (f: F) => (f.stake && 'stats' in f.stake ? magnitude(f.stake.stats) : 0);
  const gainSize = (f: F) => {
    if (!f.stake || drifts(f)) return 0;
    if ('create' in f.stake) return magnitude(rawToPoints(city, objectContribution(rules, f.stake.create.weight ?? 'NONE', f.stake.create.statProfile ?? {})));
    return statsSize(f);
  };
  const budget = scenario.scale ? rules.seeding.scale[scenario.scale].budget : null;
  const factor = (sum: number) => (budget && sum > 0 ? budget / sum : 1);
  const kTrouble = factor(scenario.fronts.filter(drifts).reduce((acc, f) => acc + statsSize(f), 0));
  const kGain = factor(scenario.fronts.reduce((acc, f) => acc + gainSize(f), 0));
  const kOf = (f: F) => (drifts(f) ? kTrouble : kGain);
  // Чем беда истории бьёт по городу, в пунктах статов: от этого её ёмкость. Ноль — удар не в числах.
  const hitOf = (f: F): number => {
    if (!f.stake) return 0;
    if ('stats' in f.stake) return Math.round(statsSize(f) * kTrouble * 100) / 100;
    if ('delete' in f.stake) {
      const target = f.stake.delete.target;
      const own = scenario.objects.find((o) => o.id === target);
      const raw = own ? objectContribution(rules, own.weight ?? 'NONE', own.statProfile ?? {}) : city.objects.find((o) => o.id === target)?.statEffect;
      return raw ? magnitude(rawToPoints(city, raw)) : 0;
    }
    return 0;
  };
  // Беда стоит столько, сколько она отнимет. Выигрыш в истории с масштабом стоит долю того, что принесёт.
  // Остальное (узнать, открыть, переменить) стоит по масштабу фронта.
  const ownCapacity = (f: F) => {
    if (drifts(f)) {
      const hit = hitOf(f);
      return hit > 0 ? threatCapacity(rules, hit) : rules.seeding.capacity[f.impact];
    }
    const gain = budget ? gainSize(f) * kGain : 0;
    return gain > 0 ? Math.max(2, Math.round(gain * rules.seeding.gainShare * 100) / 100) : rules.seeding.capacity[f.impact];
  };
  const byId = new Map(scenario.fronts.map((f) => [f.id, f]));
  const pushesOf = (f: F) =>
    // Двигать другой фронт стоит столько же, сколько сделать эту часть его работы самому.
    f.closes.flatMap((c) => {
      const target = byId.get(c.target);
      return target ? [{ op: 'progress' as const, frontId: map(c.target), amount: Math.round(ownCapacity(target) * c.share * 100) / 100 }] : [];
    });
  const capacityOf = (f: F) => Math.max(ownCapacity(f), pushesOf(f).reduce((sum, p) => sum + p.amount, 0));
  // История-возможность живёт окно: не взялись и не довели — она уходит.
  const chance = storyKind(scenario) === 'chance';
  const windowDays = troubleDays(rules, scenario.fronts.reduce((acc, f) => acc + capacityOf(f), 0), rules.seeding.chanceMonths);
  const fronts = scenario.fronts.map((f) => {
    const pushes = pushesOf(f);
    const capacity = capacityOf(f);
    const own = stakeOps(rules, city, f.stake, ids, kOf(f));
    const drifting = drifts(f);
    const driftDays = drifting ? troubleDays(rules, capacity, rules.seeding.driftMonths[f.drift]) : 0;
    const moves = keyMoves(f.alignment, f.clues);
    const description = tweak[f.id]?.description ?? f.description;
    const form = f.form ?? (drifting ? 'threat' : 'find');
    return createFront({
      id: map(f.id),
      form,
      origin: 'story',
      title: clipWords(tweak[f.id]?.name ?? f.title ?? description.split(/[.!?]/)[0] ?? '', 80) || scenario.title,
      description,
      capacity,
      milestones: Math.max(scaleOf(rules, capacity).milestones, Math.min(4, f.beatCount + 1)),
      deadlineDay: drifting ? args.day + driftDays : chance ? args.day + windowDays : null,
      plus: chance,
      scale: scenario.scale ?? null,
      // События истории наступают сами, через равные доли срока.
      pulseDay: drifting && f.events.length ? args.day + Math.max(1, Math.floor(driftDays / (f.events.length + 1))) : null,
      // Толчки другим фронтам случаются при завершении; у фронта с дрейфом их нет (это проверяет схема).
      stake: drifting ? [] : [...own, ...pushes],
      failStake: drifting ? own : [],
      key: moves.length ? { moves, twist: null } : null,
      refs: f.refs.map(map),
      atStake: (drifting && hitOf(f)) || capacity,
      script: {
        events: f.events.map((e) => ({ id: e.id, description: e.description, fired: false })),
        clues: f.clues.map((c) => ({ id: c.id, fact: c.fact, revealed: false })),
      },
      day: args.day,
    });
  });
  city.objects.push(...objects);
  city.fronts.push(...fronts);
  city.scenariosUsed.push(scenario.id);
  return { objects, fronts };
}

/** Объекты тайн острова, которых коснулась история: ссылкой или целью ставки. */
export function touchedMysteries(raw: Scenario, mystery: ReadonlySet<string>): string[] {
  const touched = new Set<string>();
  const see = (id: string | null | undefined) => {
    if (id && mystery.has(id)) touched.add(id);
  };
  for (const o of raw.objects) o.refs.forEach(see);
  for (const f of raw.fronts) {
    f.refs.forEach(see);
    const s = f.stake;
    if (s && 'modify' in s) see(s.modify.target);
    if (s && 'delete' in s) see(s.delete.target);
    if (s && 'uncover' in s) see(s.uncover.target);
    if (s && 'create' in s) (s.create.refs ?? []).forEach(see);
  }
  return [...touched];
}
