/**
 * Мост между сущностями ядра и входами узких агентов: что и какими словами им показать.
 * Агенты не видят чисел: вклад уходит классами, сроки — словесными полосами.
 */

import type { City, Front, FrontKey, Officer, WorldObject } from '../core/city.js';
import type { Relation, StatMap } from '../core/rules.js';
import { leadOf, officerOf } from '../core/world/assignments.js';
import { diffPoints, gradePoints, magnitude, pointsToGrades, rawToPoints } from '../core/world/numbers.js';
import { attachedTo, findObject, visibleObjects } from '../core/world/objects.js';
import { qualitativeStats } from '../core/world/stats.js';
import type { ObjectBrief } from '../agents/_shared/blocks.js';
import { appraiseContribution } from '../agents/contribution-appraiser/run.js';
import { sealKey, type SituationKind } from '../agents/key-sealer/run.js';
import { RELATION_WORDS } from '../agents/risk-appraiser/run.js';
import { tryAgent, type FlowDeps } from './context.js';

const KEY_OBJECTS = 8;

export function briefOf(o: Pick<WorldObject, 'id' | 'type' | 'name' | 'description'>): ObjectBrief {
  return { id: o.id, type: o.type, name: o.name, description: o.description };
}

/** То, что агентам можно показать как «в городе есть»: видимое и долговечное. */
export function visibleBriefs(city: City): ObjectBrief[] {
  return visibleObjects(city)
    .filter((o) => !o.temporary)
    .map(briefOf);
}

/** Должность и имя; пол в скобках, чтобы агенты верно склоняли глаголы. */
export function officerLabel(officer: Pick<Officer, 'title' | 'name' | 'gender'>): string {
  return `${officer.title.toLowerCase()} ${officer.name} (${officer.gender === 'female' ? 'женщина' : 'мужчина'})`;
}

export function leadLabel(city: City, front: Pick<Front, 'id'>): { label: string | null; manner: string | null; officer: Officer | null } {
  const lead = leadOf(city, front.id);
  const officer = lead ? officerOf(city, lead) : null;
  return { label: officer ? officerLabel(officer) : null, manner: lead?.text ? lead.text : null, officer };
}

/** Отпечаток дела с именами: кого оно занимает, на кого давит, кому выгодно. */
export function touchesOf(city: City, front: Pick<Front, 'footprint'>): Array<{ id: string; name: string; relation: Relation; reason: string }> {
  const out: Array<{ id: string; name: string; relation: Relation; reason: string }> = [];
  for (const entry of front.footprint) {
    const obj = findObject(city, entry.objectId);
    if (obj && obj.status === 'active') out.push({ id: obj.id, name: obj.name, relation: entry.relation, reason: entry.reason });
  }
  return out;
}

/** Участники ситуации строками для Запечатывателя. */
export function rolesOf(city: City, front: Front): string[] {
  const lines = touchesOf(city, front).map((t) => `${t.name} — ${RELATION_WORDS[t.relation]}: ${t.reason}`);
  for (const id of front.refs) {
    const obj = findObject(city, id);
    if (obj && obj.status === 'active') lines.push(`${obj.name}: ${obj.description}`);
  }
  for (const obj of attachedTo(city, front.id)) lines.push(`${obj.name} — ${(obj.attach?.rate ?? 0) < 0 ? 'мешает делу' : 'помогает делу'}: ${obj.description}`);
  return [...new Set(lines)];
}

export function situationOf(front: Pick<Front, 'title' | 'description'>): string {
  return front.description && front.description !== front.title ? `«${front.title}». ${front.description}` : `«${front.title}»`;
}

export function kindOf(front: Pick<Front, 'form' | 'plus'>): SituationKind {
  if (front.plus) return 'chance';
  if (front.form === 'tension') return 'tension';
  if (front.form === 'find') return 'search';
  if (front.form === 'deed') return 'work';
  return 'threat';
}

/** Самые весомые видимые объекты города с вкладом классами. */
export function keyObjects(deps: Pick<FlowDeps, 'rules'>, city: City) {
  return visibleObjects(city)
    .filter((o) => !o.temporary)
    .map((o) => ({ o, points: rawToPoints(city, o.statEffect) }))
    .sort((a, b) => magnitude(b.points) - magnitude(a.points))
    .slice(0, KEY_OBJECTS)
    .map(({ o, points }) => ({ name: o.name, type: o.type, effects: pointsToGrades(deps.rules, points) }));
}

export interface Appraisal {
  points: StatMap;
  /** false — агент сломался, вернулся запасной вариант. */
  ok: boolean;
}

/**
 * Оценщик вклада: классы от модели, пункты от ядра.
 * Новый объект при поломке получает нулевой вклад, переоценка оставляет прежний.
 */
export async function appraise(
  deps: FlowDeps,
  city: City,
  subject: Omit<ObjectBrief, 'id'>,
  before?: { points: StatMap; event: string },
): Promise<Appraisal> {
  const fallback = before ? { ...before.points } : gradePoints(deps.rules, []);
  const out = await tryAgent(
    deps,
    'contribution-appraiser',
    () =>
      appraiseContribution(deps.agents, {
        rules: deps.rules,
        subject,
        cityStats: qualitativeStats(deps.rules, city.stats),
        keyObjects: keyObjects(deps, city),
        before: before ? { effects: pointsToGrades(deps.rules, before.points), event: before.event } : null,
      }),
    null,
  );
  if (!out) return { points: fallback, ok: false };
  const points = gradePoints(deps.rules, out.effects);
  // Переоценка, которая вернула тот же набор классов, ничего не меняет: держим прежние пункты.
  if (before && magnitude(diffPoints(points, gradePoints(deps.rules, pointsToGrades(deps.rules, before.points)))) === 0) {
    return { points: { ...before.points }, ok: true };
  }
  return { points, ok: true };
}

/** Запечатыватель: ключ фронта. При поломке ключа нет, и любая стратегия получает «годится». */
export async function seal(
  deps: FlowDeps,
  city: City,
  front: Front,
  opts: { hint?: string | null; twistNeeded?: boolean } = {},
): Promise<FrontKey | null> {
  return tryAgent(
    deps,
    'key-sealer',
    () =>
      sealKey(deps.agents, {
        title: front.title,
        description: front.description,
        kind: kindOf(front),
        roles: rolesOf(city, front),
        hint: opts.hint ?? null,
        twistNeeded: Boolean(opts.twistNeeded),
      }),
    null,
  );
}
