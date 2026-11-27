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

function cityText(cityName: string, portrait: string, hidden: string): string {
  return [`Город «${cityName}».`, section('ПОРТРЕТ', portrait), section('СКРЫТОЕ', hidden)].join('\n\n');
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Почему список не годится, или null. Экспорт для тестов. */
export function listProblem(raw: ObjectListRaw, input: Pick<ObjectListInput, 'rules' | 'mustCover' | 'existing'>): string | null {
  const g = input.rules.fronts.genesisObjects;
  const topup = Boolean(input.mustCover?.length);
  const n = raw.objects.length;
  if (topup ? n < 1 || n > TOPUP_MAX : n < g.minCount || n > g.maxCount) {
    return topup ? `новых объектов ${n}, нужно от 1 до ${TOPUP_MAX}` : `объектов ${n}, нужно от ${g.minCount} до ${g.maxCount}`;
  }
  const names = raw.objects.map((o) => norm(o.name));
  const dup = names.filter((x, i) => names.indexOf(x) !== i);
  if (dup.length) return `имена повторяются: ${[...new Set(dup)].join(', ')}`;
  const existing = new Set((input.existing ?? []).map(norm));
  const clash = names.filter((x) => existing.has(x));
  if (clash.length) return `такие объекты уже есть: ${clash.join(', ')}`;
  const long = raw.objects.filter((o) => o.name.length > input.rules.fronts.objects.nameMax).map((o) => o.name);
  if (long.length) return `слишком длинные имена: ${long.join(', ')}`;
  const known = new Set([...names, ...existing]);
  const unknown = raw.objects.flatMap((o) => [...o.links, ...(o.parent ? [o.parent] : [])]).filter((x) => !known.has(norm(x)));
  if (unknown.length) return `связи ведут к объектам, которых нет в списке: ${[...new Set(unknown)].join(', ')}`;
  const linked = new Set<string>();
  for (const o of raw.objects) {
    const own = [...o.links, ...(o.parent ? [o.parent] : [])].map(norm).filter((x) => x !== norm(o.name));
    if (own.length) linked.add(norm(o.name));
    for (const x of own) linked.add(x);
  }
  const orphans = raw.objects.filter((o) => !linked.has(norm(o.name))).map((o) => o.name);
  if (orphans.length) return `у этих объектов нет ни одной связи: ${orphans.join(', ')}`;
  const visible = new Set([...raw.objects.filter((o) => !o.hidden).map((o) => norm(o.name)), ...existing]);
  const sealed = raw.objects
    .filter((o) => o.hidden)
    .filter((o) => {
      const mine = [...o.links, ...(o.parent ? [o.parent] : [])].map(norm);
      const theirs = raw.objects.filter((x) => !x.hidden && x.links.map(norm).includes(norm(o.name)));
      return !mine.some((x) => visible.has(x)) && !theirs.length;
    })
    .map((o) => o.name);
  if (sealed.length) return `скрытые объекты без связи с видимым: ${sealed.join(', ')}`;
  if (!topup) {
    const arcs = raw.objects.map((o) => o.arc).filter((a) => a !== 'none');
    if (arcs.length < 2 || arcs.length > 4) return `больших нерешённых вещей ${arcs.length}, нужно от двух до четырёх`;
    if (new Set(arcs).size < 2) return 'большие нерешённые вещи одного рода: нужны хотя бы два разных';
  }
  return null;
}

export const objectList: StructuredAgent<ObjectListInput, ObjectListRaw, ObjectPlan[]> = {
  name: 'world-objects-genesis',
  tool: 'submit_object_list',
  description: 'Список объектов города: имя, вид, связи, вложенность, скрытость, пометка большой вещи.',
  schema: objectListSchema,
  system: ({ rules }) => system(rules),
  user: ({ cityName, portrait, hidden, mustCover, existing }) =>
    mustCover?.length
      ? [
          cityText(cityName, portrait, hidden),
          section('ОБЪЕКТЫ, КОТОРЫЕ УЖЕ ЕСТЬ', (existing ?? []).join(', ')),
          section('ДЕТАЛИ ИГРОКА, КОТОРЫМ НУЖЕН СВОЙ ОБЪЕКТ', bullets([...mustCover])),
          `Добавь от 1 до ${TOPUP_MAX} новых объектов для этих деталей. Связи могут вести и к уже существующим объектам. arc у новых объектов — none. Вызови submit_object_list.`,
        ].join('\n\n')
      : [cityText(cityName, portrait, hidden), 'Составь полный список объектов города. Вызови submit_object_list.'].join('\n\n'),
  check: (raw, input) => listProblem(raw, input),
  finish: (raw) =>
    raw.objects.map((o) => ({
      name: o.name,
      type: o.type,
      links: [...new Set(o.links.filter((x) => norm(x) !== norm(o.name)))],
      parent: o.parent && norm(o.parent) !== norm(o.name) ? o.parent : null,
      hidden: o.hidden,
      arc: o.arc === 'none' ? null : o.arc,
    })),
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
