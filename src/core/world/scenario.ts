/**
 * Сценарий — заготовка, которая один раз сажает в город объекты и фронты.
 * Дальше они живут сами; у истории нет собственной механики.
 *
 * Локальные id сценария («tower») при посадке получают глобальные, и все
 * ссылки и цели ставок переписываются на них.
 *
 * Заготовка пишется на том же языке, что приказ и осложнение: фронт может жить на объекте
 * (`livesOn`), объект может держать фронт (`holds`), а срок истории — отдельный фронт-часы
 * (`window`): работой его не снять, можно удержать вещью или убрать то, на чём он живёт.
 */

import { clipWords } from '../text.js';
import { z } from 'zod';
import { DRIFT_BANDS, emptyStatMap, ENGINES, IMPACT_LEVELS, OBJECT_TYPES, SCALES, SOURCES, STAT_IDS, type Rules, type StatMap } from '../rules.js';
import type { City, Front, HoldSpec, StakeOp, StoryTags, WorldObject } from '../city.js';
import { createFront, findFront } from './fronts.js';
import { applyHold } from './hold.js';
import { magnitude, monthsToDays, rawToPoints, scaleOf, threatCapacity, troubleDays } from './numbers.js';
import { createObject, scalePull, tug } from './objects.js';
import { objectContribution } from './stats.js';

const statPartial = z.object(Object.fromEntries(STAT_IDS.map((id) => [id, z.number().optional()])));

/** Якорь в заготовке: какой фронт объект держит, пока цел, и как. Исход якорем заготовка не меняет. */
const holdSchema = z.object({ front: z.string().min(1), effect: z.enum(['stop', 'slow', 'hurry', 'riskier', 'safer']), word: z.boolean().optional() });

const stakeSchema = z.union([
  z.object({
    create: z.object({
      type: z.enum(OBJECT_TYPES),
      name: z.string(),
      description: z.string().default(''),
      weight: z.enum(IMPACT_LEVELS).optional(),
      statProfile: statPartial.optional(),
      refs: z.array(z.string()).optional(),
      /** Что готовое будет держать, пока цело: взятый случай так закрепляют за городом. */
      holds: z.array(holdSchema).optional(),
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
        /** Фронты истории, которые объект держит с самого начала, пока цел. */
        holds: z.array(holdSchema).optional(),
        /** Объект, внутри которого или на котором этот находится: уйдёт тот, уйдёт и этот. */
        inside: z.string().optional(),
      }),
    )
    .default([]),
  /**
   * Срок истории-возможности: что закроет окно. Сажается отдельным фронтом-часами, который живёт
   * на объекте `livesOn`; когда время выйдет, этот объект уйдёт навсегда со всем вложенным, а фронты,
   * которые на нём жили, кончатся. Без окна возможность ждёт, пока о ней помнят.
   */
  window: z
    .object({
      id: z.string().min(1).default('window'),
      title: z.string().optional(),
      description: z.string().min(1),
      livesOn: z.string().min(1),
    })
    .optional(),
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
        /** Носитель: объект, без которого фронту не на чем держаться. Исчез объект — фронт кончился без ставки. */
        livesOn: z.string().optional(),
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
  const held = new Set([...ids, ...(s.window ? [s.window.id] : [])]);
  if (s.window && (ids.has(s.window.id) || s.objects.some((o) => o.id === s.window?.id))) {
    ctx.addIssue({ code: 'custom', path: ['window', 'id'], message: 'id окна занят объектом или фронтом истории' });
  }
  s.objects.forEach((o, i) => {
    if (o.inside === o.id) ctx.addIssue({ code: 'custom', path: ['objects', i, 'inside'], message: 'inside ведёт на другой объект' });
    (o.holds ?? []).forEach((h, j) => {
      if (!held.has(h.front)) ctx.addIssue({ code: 'custom', path: ['objects', i, 'holds', j, 'front'], message: 'holds ведёт на фронт или окно этой истории' });
    });
  });
  s.fronts.forEach((f, i) => {
    const made = f.stake && 'create' in f.stake ? (f.stake.create.holds ?? []) : [];
    made.forEach((h, j) => {
      if (!held.has(h.front) || h.front === f.id) ctx.addIssue({ code: 'custom', path: ['fronts', i, 'stake', 'create', 'holds', j, 'front'], message: 'holds ведёт на другой фронт или окно этой истории' });
    });
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
/**
 * Черновик писателя по заготовке: дрейф, род и толчки код всё равно берёт из заготовки,
 * поэтому их сверка идёт после слияния (scenarioDraftSchema по итогу), а не по черновику.
 */
export const scenarioLooseDraftSchema = scenarioBase;

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
    const holds = holdSpecs(c.holds, map);
    return [{ op: 'create', object: { type: c.type, name: c.name, description: c.description, points, refs: (c.refs ?? []).map(map), ...(holds.length ? { holds } : {}) }, result: true }];
  }
  if ('modify' in stake) return [{ op: 'modify', target: map(stake.modify.target), intent: stake.modify.intent ?? '' }];
  if ('delete' in stake) return [{ op: 'delete', target: map(stake.delete.target) }];
  if ('stats' in stake) return [{ op: 'stats', points: k === 1 ? stake.stats : times(stake.stats, k) }];
  if ('uncover' in stake) return [{ op: 'reveal', target: map(stake.uncover.target) }];
  return [{ op: 'fact', text: stake.reveal.text }];
}

function holdSpecs(holds: ReadonlyArray<z.infer<typeof holdSchema>> | undefined, map: (id: string) => string): HoldSpec[] {
  return (holds ?? []).map((h) => ({ frontId: map(h.front), effect: h.effect, ...(h.word ? { word: true } : {}) }));
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
  // Окно есть только у возможности: у беды время задают её собственные фронты, идущие к сроку.
  const win = storyKind(scenario) === 'chance' ? (scenario.window ?? null) : null;
  if (win) ids.set(win.id, args.newId('front'));
  const map = (id: string) => ids.get(id) ?? id;
  const tweak = args.adapted ?? {};

  const pull = scalePull(rules, scenario.scale, args.day);
  // Объект истории приходит без вклада: город его ещё не освоил, ценность он получит ставкой.
  // Вклад с посадки есть только у того, что беда истории может отнять: иначе ей нечего терять.
  const atRisk = new Set(
    scenario.fronts.flatMap((f) => (f.drift !== 'NONE' && f.stake && 'delete' in f.stake ? [f.stake.delete.target] : [])),
  );
  const objects = scenario.objects.map((o) => {
    const obj = createObject(rules, {
      id: map(o.id),
      type: o.type,
      name: tweak[o.id]?.name ?? o.name,
      description: tweak[o.id]?.description ?? o.description,
      refs: o.refs.map(map),
      parentId: o.inside ? map(o.inside) : null,
      statEffect: atRisk.has(o.id) ? objectContribution(rules, o.weight ?? 'NONE', o.statProfile ?? {}) : emptyStatMap(),
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
  // История-возможность живёт окно, если миру есть чем его закрыть: срок идёт у отдельного фронта-часов.
  const chance = storyKind(scenario) === 'chance';
  const windowDays = troubleDays(rules, scenario.fronts.reduce((acc, f) => acc + capacityOf(f), 0), rules.seeding.chanceMonths);
  const carrier = (f: F) => (f.livesOn ? map(f.livesOn) : chance && win ? map(win.livesOn) : null);
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
      deadlineDay: drifting ? args.day + driftDays : null,
      plus: chance,
      livesOn: carrier(f),
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
  if (win) {
    const description = tweak[win.id]?.description ?? win.description;
    const on = map(win.livesOn);
    fronts.push(
      createFront({
        id: map(win.id),
        form: 'clock',
        origin: 'story',
        title: clipWords(tweak[win.id]?.name ?? win.title ?? description.split(/[.!?]/)[0] ?? '', 80) || scenario.title,
        description,
        capacity: 0,
        deadlineDay: args.day + windowDays,
        scale: scenario.scale ?? null,
        livesOn: on,
        refs: [on],
        // Время вышло: носитель уходит навсегда и уносит всё, что на нём было и жило.
        stake: [{ op: 'retire', target: on, forever: true }],
        day: args.day,
      }),
    );
  }
  city.objects.push(...objects);
  city.fronts.push(...fronts);
  // Объекты истории, которые с порога что-то держат.
  for (const o of scenario.objects) {
    const obj = objects.find((x) => x.id === map(o.id));
    for (const spec of holdSpecs(o.holds, map)) {
      const front = findFront(city, spec.frontId);
      if (obj && front) applyHold(rules, city, front, obj, spec, args.day);
    }
  }
  city.scenariosUsed.push(scenario.id);
  return { objects, fronts };
}

/** Объекты тайн острова, которых коснулась история: ссылкой или целью ставки. */
export function touchedMysteries(raw: Scenario, mystery: ReadonlySet<string>): string[] {
  const touched = new Set<string>();
  const see = (id: string | null | undefined) => {
    if (id && mystery.has(id)) touched.add(id);
  };
  for (const o of raw.objects) {
    o.refs.forEach(see);
    see(o.inside);
  }
  see(raw.window?.livesOn);
  for (const f of raw.fronts) {
    f.refs.forEach(see);
    see(f.livesOn);
    const s = f.stake;
    if (s && 'modify' in s) see(s.modify.target);
    if (s && 'delete' in s) see(s.delete.target);
    if (s && 'uncover' in s) see(s.uncover.target);
    if (s && 'create' in s) (s.create.refs ?? []).forEach(see);
  }
  return [...touched];
}
