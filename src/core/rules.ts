/**
 * Игровые числа и справочники. Источник — config/game.yaml, но core не читает файлы:
 * сюда приходит уже распарсенный объект, а parseRules проверяет его целиком.
 * Отсутствие ключа — ошибка с точным путём, а не молчаливый запасной вариант.
 */

import { z } from 'zod';

export const STAT_IDS = ['prosperity', 'security', 'knowledge', 'influence'] as const;
export type StatId = (typeof STAT_IDS)[number];
export type StatMap = Record<StatId, number>;

export const IMPACT_LEVELS = ['NONE', 'MINOR', 'SIGNIFICANT', 'MAJOR', 'DEFINING'] as const;
export type Impact = (typeof IMPACT_LEVELS)[number];

export const DRIFT_BANDS = ['NONE', 'SLOW', 'STEADY', 'FAST'] as const;
export type DriftBand = (typeof DRIFT_BANDS)[number];

export const OBJECT_TYPES = [
  'building',
  'structure',
  'landmark',
  'district',
  'settlement',
  'site',
  'object',
  'resource',
  'organization',
  'community',
  'person',
  'practice',
  'capability',
  'policy',
  'threat',
  'mystery',
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const OFFICES = ['treasurer', 'marshal', 'keeper', 'chancellor'] as const;
export type Office = (typeof OFFICES)[number];

/** Лестница риска: от полностью предсказуемого дела до затеи против здравого смысла. */
export const RISK_STEPS = ['safe', 'normal', 'hard', 'risky', 'impossible'] as const;
export type RiskStep = (typeof RISK_STEPS)[number];

/** Пять механических форм фронта. */
export const FRONT_FORMS = ['deed', 'tension', 'threat', 'clock', 'find'] as const;
export type FrontForm = (typeof FRONT_FORMS)[number];

/** Классы вклада в стат. «Нет вклада» — отсутствие записи. */
export const GRADES = ['small', 'medium', 'large', 'huge'] as const;
export type Grade = (typeof GRADES)[number];

/** Один эффект объекта на стат: класс и знак. Числа из класса делает только core. */
export interface StatGrade {
  stat: StatId;
  direction: 'up' | 'down';
  size: Grade;
}

/** Позиция одного рычага темпа: медлим, обычно, торопимся. */
export type Tempo = -1 | 0 | 1;
export const TEMPO_WORDS = ['careful', 'steady', 'hurry'] as const;
export type TempoWord = (typeof TEMPO_WORDS)[number];
export function tempoOf(word: TempoWord | null | undefined): Tempo | null {
  return word === 'hurry' ? 1 : word === 'careful' ? -1 : word === 'steady' ? 0 : null;
}

/** Характер сановника: его собственный рычаг темпа. */
export const TEMPERS = ['slow', 'even', 'hasty'] as const;
export type Temper = (typeof TEMPERS)[number];

/** Вердикт Судьи соответствия на стратегию или дело. */
export const VERDICTS = ['spot_on', 'fits', 'off'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Отношения дела с объектами города (отпечаток). */
export const RELATIONS = ['occupies', 'linked', 'pressures', 'benefits'] as const;
export type Relation = (typeof RELATIONS)[number];

/** Во что выливается осложнение: какой род события соберёт код. */
export const SHAPES = ['tension', 'threat', 'hindrance', 'accident', 'clock', 'opportunity'] as const;
export type Shape = (typeof SHAPES)[number];

/** Случаи и сила события для веры. */
export const FAITH_CASES = ['harm_willed', 'harm_unguarded', 'harm_averted', 'boon_willed', 'none'] as const;
export type FaithCase = (typeof FAITH_CASES)[number];
export const FAITH_STRENGTHS = ['minor', 'notable', 'grave', 'shock'] as const;
export type FaithStrength = (typeof FAITH_STRENGTHS)[number];

const statId = z.enum(STAT_IDS);
/** Таблица «уровень → значение» с обязательным ключом на каждый уровень. */
function table<K extends string, V extends z.ZodTypeAny>(keys: readonly K[], value: V): z.ZodType<Record<K, z.infer<V>>> {
  return z.object(Object.fromEntries(keys.map((k) => [k, value]))) as unknown as z.ZodType<Record<K, z.infer<V>>>;
}

const byImpact = table(IMPACT_LEVELS, z.number());
const byDrift = table(DRIFT_BANDS, z.number().nonnegative());
const byRiskStep = table(RISK_STEPS, z.number().min(0).max(1));
const byGrade = table(GRADES, z.number().positive());
const byVerdict = table(VERDICTS, z.number().positive());
const byObjectType = table(OBJECT_TYPES, z.number().positive());
const faithRow = table(
  FAITH_CASES.filter((c): c is Exclude<FaithCase, 'none'> => c !== 'none'),
  z.number(),
);

/** Откуда берётся объект в роль записи словаря динамик. */
export const ROLE_SOURCES = [...RELATIONS, 'helper', 'site', 'result', 'nearby', 'same-type', 'struck'] as const;
export type RoleSource = (typeof ROLE_SOURCES)[number];

/** Двигатель истории: почему сюжет идёт вперёд. Мягкая ось режиссёра. */
export const ENGINES = ['refusal', 'feud', 'discovery', 'betrayal', 'dilemma', 'crisis', 'success', 'ideology', 'opportunity'] as const;
export type Engine = (typeof ENGINES)[number];
/** Где живёт причина. Мягкая ось режиссёра. */
export const SOURCES = ['people', 'custom', 'creature', 'ecology', 'matter', 'sky', 'phenomenon'] as const;
export type Source = (typeof SOURCES)[number];

const dynamicDef = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  enabled: z.boolean(),
  class: z.enum(['bound', 'side', 'plus']),
  when: z.array(z.enum(['milestone', 'completion', 'failure'])),
  light: z.enum(SHAPES).nullable(),
  heavy: z.enum(SHAPES).nullable(),
  from: z.array(z.enum(ROLE_SOURCES)).min(1),
  types: z.array(z.enum(OBJECT_TYPES)),
  hits: z.enum(['parent', 'role', 'result']),
  condition: z.string(),
  skeleton: z.string().min(1),
  helps: z.string(),
  needsNew: z.boolean(),
  newHidden: z.boolean(),
  requires: z.enum(['noLead']).nullable(),
  minStep: z.enum(RISK_STEPS),
  /** Оси режиссёра: двигатель, источник причины, сфера города (её сановник). */
  engine: z.enum(ENGINES),
  source: z.enum(SOURCES),
  sphere: statId,
});

const statDef = z.object({
  id: statId,
  name: z.string().min(1),
  about: z.string().default(''),
  covers: z.string().default(''),
  changeWhen: z.string().default(''),
  scale: z.record(z.string(), z.string()).default({}),
});

const officeDef = z.object({
  office: z.enum(OFFICES),
  statId,
  title: z.string().min(1),
  titleGen: z.string().min(1),
  focus: z.string().default(''),
  strategy: z.string().default(''),
});

export const rulesSchema = z.object({
  time: z.object({ realHoursPerYear: z.number().positive() }),
  stats: z.array(statDef).length(STAT_IDS.length),
  statEpithets: z.record(z.string(), z.string()),
  faith: z.object({
    name: z.string(),
    about: z.string(),
    pullPerMonth: z.number().min(0).max(1),
    impulses: table(FAITH_STRENGTHS, faithRow),
  }),
  mana: z.object({
    name: z.string(),
    about: z.string(),
    max: z.number().positive(),
    start: z.number().nonnegative(),
    turnCost: z.number().nonnegative(),
    turnCostWithAction: z.number().nonnegative(),
  }),
  genesis: z.object({
    statBudget: z.number().int().positive(),
    statMin: z.number().int(),
    statMax: z.number().int(),
  }),
  officers: z.array(officeDef).length(OFFICES.length),
  fronts: z.object({
    impact: z.object({ rawBudget: byImpact }),
    work: z.object({
      unitsPerMonth: z.number().positive(),
      fitFloor: z.number().positive(),
      fitSpan: z.number().nonnegative(),
      profileBonus: z.number().nonnegative(),
    }),
    contribution: byGrade,
    basePrice: z.object({ edit: z.number().positive(), fact: z.number().positive(), byType: byObjectType }),
    scale: z
      .array(z.object({ id: z.string().min(1), upTo: z.number().positive().nullable(), milestones: z.number().int().positive() }))
      .min(1),
    occupiedShare: z.number().min(0).max(1),
    verdict: byVerdict,
    tempoStep: z.number().min(0).max(0.3),
    helper: z.object({ unitsPerMonth: z.number().positive(), maxShare: z.number().positive() }),
    hindrance: z.object({ unitsPerMonth: z.number().negative(), removalShare: z.number().positive(), removalMin: z.number().positive() }),
    push: z.object({ share: z.number().positive(), min: z.number().positive() }),
    threat: z.object({ capacityShare: z.number().positive(), capacityMin: z.number().positive() }),
    tension: z.object({
      quenchShare: z.number().positive(),
      quenchMin: z.number().positive(),
      burstMonthsMin: z.number().int().positive(),
      burstMonthsMax: z.number().int().positive(),
    }),
    opportunity: z.object({ capacityShare: z.number().positive(), capacityMin: z.number().positive() }),
    deadlines: z.object({ ownRiskMonths: z.number().positive(), worldMonths: z.number().positive() }),
    risk: z.object({
      chance: byRiskStep,
      heavyShare: byRiskStep,
      /** Недостижимое дело: каждая N-я беда заменяется находкой. */
      plusEvery: z.number().int().positive(),
      accidentLoss: z.number().min(0).max(1),
    }),
    outcome: z.object({ asPlanned: z.number().nonnegative(), twist: z.number().nonnegative() }),
    director: z.object({
      freshWeight: z.number().positive(),
      freshDays: z.number().int().positive(),
      fitterCalls: z.number().int().positive(),
      windowDays: z.number().int().positive(),
      repeatPenalty: z.number().nonnegative(),
      loadPenalty: z.number().nonnegative(),
      mysteryShare: z.number().min(0).max(1),
      mysteryBoost: z.number().min(1),
      calmTroubles: z.number().int().positive(),
      plusBase: z.number().min(0).max(1),
      plusMax: z.number().min(0).max(1),
      engines: z.record(z.enum(ENGINES), z.string().min(1)),
      sources: z.record(z.enum(SOURCES), z.string().min(1)),
    }),
    failure: z.object({ chance: z.number().min(0).max(1), heavyShare: z.number().min(0).max(1) }),
    refresh: z.object({ maxFronts: z.number().int().nonnegative() }),
    unattainableWarnDays: z.number().int().positive(),
    objects: z.object({
      nameMax: z.number().int().positive(),
      descriptionMax: z.number().int().positive(),
    }),
    genesisObjects: z.object({
      minCount: z.number().int().positive(),
      maxCount: z.number().int().positive(),
      profileRange: z.number().positive(),
    }),
    dynamics: z.array(dynamicDef),
  }),
  seeding: z.object({
    activeStories: z.number().int().nonnegative(),
    checkEveryDays: z.number().int().positive(),
    firstStoryDay: z.number().int().nonnegative(),
    dormantDays: z.number().int().positive(),
    namesPerCall: z.number().int().nonnegative(),
    capacity: byImpact,
    driftMonths: byDrift,
  }),
  priest: z.object({ dialogDepth: z.number().int().positive() }),
});

export type Rules = z.infer<typeof rulesSchema>;
export type StatDef = Rules['stats'][number];
export type OfficeDef = Rules['officers'][number];
export type Dynamic = Rules['fronts']['dynamics'][number];

/** Проверить сырой объект правил. Бросает ошибку с путём до первого кривого ключа. */
export function parseRules(raw: unknown): Rules {
  const parsed = rulesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join('.') : '?';
    throw new Error(`правила игры: ${where}: ${issue?.message ?? 'неверно'}`);
  }
  const rules = parsed.data;
  const ids = new Set(rules.stats.map((s) => s.id));
  if (ids.size !== STAT_IDS.length) throw new Error('правила игры: stats: id статов повторяются');
  const offices = new Set(rules.officers.map((o) => o.office));
  if (offices.size !== OFFICES.length) throw new Error('правила игры: officers: должности повторяются');
  const g = rules.genesis;
  if (g.statMin * STAT_IDS.length > g.statBudget || g.statMax * STAT_IDS.length < g.statBudget) {
    throw new Error('правила игры: genesis: бюджет не влезает в коридор statMin..statMax');
  }
  const go = rules.fronts.genesisObjects;
  if (go.minCount > go.maxCount) throw new Error('правила игры: fronts.genesisObjects: minCount > maxCount');
  const f = rules.fronts;
  if (f.scale.at(-1)?.upTo != null) throw new Error('правила игры: fronts.scale: последняя ступень должна быть без верхней границы');
  if (f.scale.slice(0, -1).some((row) => row.upTo == null)) throw new Error('правила игры: fronts.scale: без границы только последняя ступень');
  if (f.tension.burstMonthsMin > f.tension.burstMonthsMax) throw new Error('правила игры: fronts.tension: burstMonthsMin > burstMonthsMax');
  if (f.outcome.asPlanned + f.outcome.twist <= 0) throw new Error('правила игры: fronts.outcome: веса исходов нулевые');
  const dyn = new Set(f.dynamics.map((d) => d.id));
  if (dyn.size !== f.dynamics.length) throw new Error('правила игры: fronts.dynamics: id записей повторяются');
  return rules;
}

export function emptyStatMap(): StatMap {
  return { prosperity: 0, security: 0, knowledge: 0, influence: 0 };
}

export function isImpact(raw: unknown): raw is Impact {
  return typeof raw === 'string' && (IMPACT_LEVELS as readonly string[]).includes(raw);
}

export function impactRank(level: Impact): number {
  return IMPACT_LEVELS.indexOf(level);
}
