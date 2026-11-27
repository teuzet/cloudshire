/**
 * Объекты мира из портрета города, в два шага: список со связями и пометками, затем описания и вклад.
 * Добор: те же два шага для деталей питча, которых не нашёл сверщик. Статы города собирает ядро.
 */

import type { Arc } from '../../core/city.js';
import type { Impact, ObjectType, Rules, StatMap } from '../../core/rules.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { isZeroProfile } from '../_shared/schemas.js';
import { objectDetailsSchema, objectListSchema, type ObjectDetailsRaw, type ObjectListRaw } from './schema.js';

export interface ObjectPlan {
  name: string;
  type: ObjectType;
  links: string[];
  parent: string | null;
  hidden: boolean;
  arc: Arc | null;
}

export interface GenesisObjectDraft extends ObjectPlan {
  description: string;
  weight: Impact;
  statProfile: StatMap;
}

export interface ObjectListInput {
  rules: Rules;
  cityName: string;
  portrait: string;
  hidden: string;
  /** Добор: детали питча, которым нужен объект. Пусто — полный список. */
  mustCover?: readonly string[];
  /** Добор: объекты, которые уже есть; на них можно ссылаться. */
  existing?: readonly string[];
  /** Жрец и сановники: их заводят отдельно, объектов с их именами нет. */
  people?: readonly string[];
}

export interface ObjectDetailsInput {
  rules: Rules;
  cityName: string;
  portrait: string;
  hidden: string;
  plan: readonly ObjectPlan[];
}

const prompt = loadPrompt(import.meta.url);
const TOPUP_MAX = 10;

function system(rules: Rules): string {
  const g = rules.fronts.genesisObjects;
  const o = rules.fronts.objects;
  return composeSystem(['world'], prompt, `Объектов в полном списке от ${g.minCount} до ${g.maxCount}. Имя до ${o.nameMax} знаков, описание до ${o.descriptionMax}.`);
}

function cityText(cityName: string, portrait: string, hidden: string, people?: readonly string[]): string {
  return [
    `Город «${cityName}».`,
    people?.length ? `Верховный жрец и сановники (их заводят отдельно): ${people.join(', ')}.` : '',
    section('ПОРТРЕТ', portrait),
    section('СКРЫТОЕ', hidden),
  ]
    .filter(Boolean)
    .join('\n\n');
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Почему список не годится, или null. Экспорт для тестов. */
export function listProblem(raw: ObjectListRaw, input: Pick<ObjectListInput, 'rules' | 'mustCover' | 'existing' | 'people'>): string | null {
  const g = input.rules.fronts.genesisObjects;
  const topup = Boolean(input.mustCover?.length);
  const n = raw.objects.length;
  if (topup ? n < 1 || n > TOPUP_MAX : n < g.minCount || n > g.maxCount) {
    if (topup) return `новых объектов ${n}, нужно от 1 до ${TOPUP_MAX}`;
    return n > g.maxCount
      ? `объектов ${n}, нужно до ${g.maxCount}: объедини или убери самые мелкие, остальное оставь как есть`
      : `объектов ${n}, нужно от ${g.minCount}`;
  }
  const names = raw.objects.map((o) => norm(o.name));
  const dup = names.filter((x, i) => names.indexOf(x) !== i);
  if (dup.length) return `имена повторяются: ${[...new Set(dup)].join(', ')}`;
  const existing = new Set((input.existing ?? []).map(norm));
  const clash = names.filter((x) => existing.has(x));
  if (clash.length) return `такие объекты уже есть: ${clash.join(', ')}`;
  const people = (input.people ?? []).map(norm);
  const persons = raw.objects.filter((o) => people.some((p) => norm(o.name).split(/\s+/).includes(p))).map((o) => o.name);
  if (persons.length) return `верховного жреца и сановников заводят отдельно, уберите из списка: ${persons.join(', ')}`;
  const long = raw.objects.filter((o) => o.name.length > input.rules.fronts.objects.nameMax).map((o) => o.name);
  if (long.length) return `слишком длинные имена: ${long.join(', ')}`;
  // Связи к объектам, которых нет в списке, код просто отбрасывает: на них модель тратит попытки впустую.
  const known = new Set([...names, ...existing]);
  const real = (o: ObjectListRaw['objects'][number]): string[] => [...o.links, ...(o.parent ? [o.parent] : [])].map(norm).filter((x) => known.has(x));
  const linked = new Set<string>();
  for (const o of raw.objects) {
    const own = real(o).filter((x) => x !== norm(o.name));
    if (own.length) linked.add(norm(o.name));
    for (const x of own) linked.add(x);
  }
  const orphans = raw.objects.filter((o) => !linked.has(norm(o.name))).map((o) => o.name);
  if (orphans.length) return `у этих объектов нет ни одной связи: ${orphans.join(', ')}`;
  const visible = new Set([...raw.objects.filter((o) => !o.hidden).map((o) => norm(o.name)), ...existing]);
  const sealed = raw.objects
    .filter((o) => o.hidden)
    .filter((o) => {
      const mine = real(o);
      const theirs = raw.objects.filter((x) => !x.hidden && x.links.map(norm).includes(norm(o.name)));
      return !mine.some((x) => visible.has(x)) && !theirs.length;
    })
    .map((o) => o.name);
  if (sealed.length) return `скрытые объекты без связи с видимым: ${sealed.join(', ')}`;
  if (!topup) {
    const arcs = raw.objects.map((o) => o.arc).filter((a) => a !== 'none');
    // Лишние пометки код снимает сам (finish), мало — просит добавить.
    if (arcs.length < 2) return `больших нерешённых вещей ${arcs.length}, нужно от двух до четырёх`;
    if (new Set(arcs).size < 2) return 'большие нерешённые вещи одного рода: нужны хотя бы два разных';
  }
  return null;
}

const ARCS_MAX = 4;

/** Не больше четырёх больших вещей: сначала по одной каждого рода, потом по порядку списка. */
export function keepArcs(arcs: ReadonlyArray<Arc | null>): Array<Arc | null> {
  const kept = new Set<number>();
  const kinds = new Set<Arc>();
  arcs.forEach((a, i) => {
    if (a && !kinds.has(a) && kept.size < ARCS_MAX) {
      kinds.add(a);
      kept.add(i);
    }
  });
  arcs.forEach((a, i) => {
    if (a && kept.size < ARCS_MAX) kept.add(i);
  });
  return arcs.map((a, i) => (kept.has(i) ? a : null));
}

export const objectList: StructuredAgent<ObjectListInput, ObjectListRaw, ObjectPlan[]> = {
  name: 'world-objects-genesis',
  tool: 'submit_object_list',
  description: 'Список объектов города: имя, вид, связи, вложенность, скрытость, пометка большой вещи.',
  schema: objectListSchema,
  system: ({ rules }) => system(rules),
  user: ({ cityName, portrait, hidden, mustCover, existing, people }) =>
    mustCover?.length
      ? [
          cityText(cityName, portrait, hidden, people),
          section('ОБЪЕКТЫ, КОТОРЫЕ УЖЕ ЕСТЬ', (existing ?? []).join(', ')),
          section('ДЕТАЛИ ИГРОКА, КОТОРЫМ НУЖЕН СВОЙ ОБЪЕКТ', bullets([...mustCover])),
          `Добавь от 1 до ${TOPUP_MAX} новых объектов для этих деталей. Связи могут вести и к уже существующим объектам. arc у новых объектов — none. Вызови submit_object_list.`,
        ].join('\n\n')
      : [cityText(cityName, portrait, hidden, people), 'Составь полный список объектов города. Вызови submit_object_list.'].join('\n\n'),
  check: (raw, input) => listProblem(raw, input),
  finish: (raw, { existing }) => {
    const known = new Set([...raw.objects.map((o) => norm(o.name)), ...(existing ?? []).map(norm)]);
    const ok = (x: string, self: string): boolean => known.has(norm(x)) && norm(x) !== norm(self);
    const arcs = keepArcs(raw.objects.map((o) => (o.arc === 'none' ? null : o.arc)));
    return raw.objects.map((o, i) => ({
      name: o.name,
      type: o.type,
      links: [...new Set(o.links.filter((x) => ok(x, o.name)))],
      parent: o.parent && ok(o.parent, o.name) ? o.parent : null,
      hidden: o.hidden,
      arc: arcs[i] ?? null,
    }));
  },
};

function planLine(p: ObjectPlan): string {
  const marks = [p.type, p.hidden ? 'скрыт' : '', p.arc ?? '', p.parent ? `внутри: ${p.parent}` : ''].filter(Boolean).join(', ');
  return `${p.name} (${marks}); связи: ${p.links.join(', ') || '—'}`;
}

export const objectDetails: StructuredAgent<ObjectDetailsInput, ObjectDetailsRaw, GenesisObjectDraft[]> = {
  name: 'world-objects-genesis',
  tool: 'submit_object_details',
  description: 'Описание, вес и профиль по статам для каждого объекта из списка.',
  schema: objectDetailsSchema,
  system: ({ rules }) => system(rules),
  user: ({ cityName, portrait, hidden, plan }) =>
    [
      cityText(cityName, portrait, hidden),
      section('СПИСОК ОБЪЕКТОВ', bullets(plan.map(planLine))),
      'Опиши каждый объект из списка, имена бери ровно как в списке. Вызови submit_object_details.',
    ].join('\n\n'),
  check: (raw, { rules, plan }) => {
    const want = new Set(plan.map((p) => norm(p.name)));
    const got = raw.objects.map((o) => norm(o.name));
    const missing = plan.filter((p) => !got.includes(norm(p.name))).map((p) => p.name);
    if (missing.length) return `нет описаний для: ${missing.join(', ')}`;
    const extra = raw.objects.filter((o) => !want.has(norm(o.name))).map((o) => o.name);
    if (extra.length) return `таких объектов нет в списке: ${extra.join(', ')}`;
    const o = rules.fronts.objects;
    const bad = raw.objects.find((x) => isZeroProfile(x.stat_profile) || x.description.length > o.descriptionMax);
    return bad ? `объект «${bad.name}»: нулевой профиль или описание длиннее ${o.descriptionMax} знаков` : null;
  },
  finish: (raw, { plan }) =>
    plan.map((p) => {
      const d = raw.objects.find((o) => norm(o.name) === norm(p.name))!;
      return { ...p, description: d.description, weight: d.weight, statProfile: d.stat_profile };
    }),
};

export async function planWorldObjects(deps: AgentDeps, input: ObjectListInput): Promise<ObjectPlan[]> {
  return (await runStructured(deps, objectList, input)).value;
}

export async function describeWorldObjects(deps: AgentDeps, input: ObjectDetailsInput): Promise<GenesisObjectDraft[]> {
  return (await runStructured(deps, objectDetails, input)).value;
}
