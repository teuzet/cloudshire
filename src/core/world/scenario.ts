/**
 * Сценарий — заготовка, которая один раз сажает в город объекты и фронты.
 * Дальше они живут сами; у истории нет собственной механики.
 *
 * Локальные id сценария («tower») при посадке получают глобальные, и все
 * ссылки и цели ставок переписываются на них.
 */

import { z } from 'zod';
import { DRIFT_BANDS, IMPACT_LEVELS, OBJECT_TYPES, STAT_IDS, type Rules } from '../rules.js';
import type { City, Front, StakeOp, WorldObject } from '../city.js';
import { createFront } from './fronts.js';
import { monthsToDays, rawToPoints, scaleOf } from './numbers.js';
import { createObject } from './objects.js';
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
]);

export const scenarioSchema = z.object({
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
      }),
    )
    .default([]),
  fronts: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        impact: z.enum(IMPACT_LEVELS),
        drift: z.enum(DRIFT_BANDS).default('NONE'),
        beatCount: z.number().int().nonnegative().default(0),
        refs: z.array(z.string()).default([]),
        alignment: z.string().default(''),
        stake: stakeSchema.nullable().default(null),
        events: z.array(z.object({ id: z.string(), description: z.string() })).default([]),
        clues: z.array(z.object({ id: z.string(), fact: z.string(), alignment: z.string().default('') })).default([]),
      }),
    )
    .min(1),
});

export type Scenario = z.infer<typeof scenarioSchema>;

export function parseScenario(raw: unknown): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`сценарий: ${issue ? issue.path.join('.') : '?'}: ${issue?.message ?? 'неверно'}`);
  }
  return parsed.data;
}

/** Ставка заготовки на языке операций новой системы. */
function stakeOps(rules: Rules, city: Pick<City, 'statScale'>, stake: Scenario['fronts'][number]['stake'], ids: Map<string, string>): StakeOp[] {
  if (!stake) return [];
  const map = (id: string) => ids.get(id) ?? id;
  if ('create' in stake) {
    const c = stake.create;
    const points = rawToPoints(city, objectContribution(rules, c.weight ?? 'NONE', c.statProfile ?? {}));
    return [{ op: 'create', object: { type: c.type, name: c.name, description: c.description, points, refs: (c.refs ?? []).map(map) }, result: true }];
  }
  if ('modify' in stake) return [{ op: 'modify', target: map(stake.modify.target), intent: stake.modify.intent ?? '' }];
  if ('delete' in stake) return [{ op: 'delete', target: map(stake.delete.target) }];
  if ('stats' in stake) return [{ op: 'stats', points: stake.stats }];
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

  const objects = scenario.objects.map((o) =>
    createObject(rules, {
      id: map(o.id),
      type: o.type,
      name: tweak[o.id]?.name ?? o.name,
      description: tweak[o.id]?.description ?? o.description,
      refs: o.refs.map(map),
      day: args.day,
    }),
  );
  // История ложится на новую модель: без дрейфа это поиск (работа доводит до ставки),
  // с дрейфом — угроза со сроком (ставка сработает, если не успеть).
  const fronts = scenario.fronts.map((f) => {
    const capacity = rules.seeding.capacity[f.impact];
    const ops = stakeOps(rules, city, f.stake, ids);
    const drifting = f.drift !== 'NONE';
    const driftDays = monthsToDays(rules.seeding.driftMonths[f.drift]);
    const moves = keyMoves(f.alignment, f.clues);
    const description = tweak[f.id]?.description ?? f.description;
    return createFront({
      id: map(f.id),
      form: drifting ? 'threat' : 'find',
      origin: 'story',
      title: description.split(/[.!?]/)[0]?.trim().slice(0, 80) || scenario.title,
      description,
      capacity,
      milestones: Math.max(scaleOf(rules, capacity).milestones, Math.min(4, f.beatCount + 1)),
      deadlineDay: drifting ? args.day + driftDays : null,
      // События истории наступают сами, через равные доли срока.
      pulseDay: drifting && f.events.length ? args.day + Math.max(1, Math.floor(driftDays / (f.events.length + 1))) : null,
      stake: drifting ? [] : ops,
      failStake: drifting ? ops : [],
      key: moves.length ? { moves, twist: null } : null,
      refs: f.refs.map(map),
      atStake: capacity,
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
    if (s && 'create' in s) (s.create.refs ?? []).forEach(see);
  }
  return [...touched];
}
