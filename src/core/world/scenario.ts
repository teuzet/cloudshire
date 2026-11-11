/**
 * Сценарий — заготовка, которая один раз сажает в город объекты и фронты.
 * Дальше они живут сами; у истории нет собственной механики.
 *
 * Локальные id сценария («tower») при посадке получают глобальные, и все
 * ссылки и цели ставок переписываются на них.
 */

import { z } from 'zod';
import { DRIFT_BANDS, IMPACT_LEVELS, OBJECT_TYPES, STAT_IDS, type Rules } from '../rules.js';
import type { City, Front, Stake, WorldObject } from '../city.js';
import { createFront } from './fronts.js';
import { createObject } from './objects.js';
import { impactEffort } from './scales.js';

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

function remapStake(stake: Scenario['fronts'][number]['stake'], ids: Map<string, string>): Stake | null {
  if (!stake) return null;
  const map = (id: string) => ids.get(id) ?? id;
  if ('create' in stake) return { create: { ...stake.create, refs: (stake.create.refs ?? []).map(map) } };
  if ('modify' in stake) return { modify: { ...stake.modify, target: map(stake.modify.target) } };
  if ('delete' in stake) return { delete: { target: map(stake.delete.target) } };
  return stake;
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
  const fronts = scenario.fronts.map((f) =>
    createFront(rules, {
      id: map(f.id),
      description: tweak[f.id]?.description ?? f.description,
      stake: remapStake(f.stake, ids),
      effort: impactEffort(rules, f.impact),
      driftBand: f.drift,
      beatCount: f.beatCount,
      events: f.events,
      clues: f.clues,
      alignment: f.alignment,
      refs: f.refs.map(map),
      day: args.day,
    }),
  );
  city.objects.push(...objects);
  city.fronts.push(...fronts);
  city.scenariosUsed.push(scenario.id);
  return { objects, fronts };
}
