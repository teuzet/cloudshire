/**
 * Ставка фронта: мир меняется, когда шкала дошла до конца.
 * Новую версию объекта для modify пишет агент; сюда она приходит готовой.
 */

import { type Impact, type Rules, type StatMap } from '../rules.js';
import type { City, Front, ModifyStake } from '../city.js';
import { activeAssignmentsForFront, closeAssignment } from './assignments.js';
import { addObjectVersion, createObject, deleteObject, findObject } from './objects.js';
import { addToLedger, objectContribution, recomputeStats } from './stats.js';

export type StakeChange =
  | { kind: 'created'; id: string }
  | { kind: 'modified'; id: string }
  | { kind: 'deleted'; id: string }
  | { kind: 'stats'; deltas: Partial<StatMap> }
  | { kind: 'reveal'; text: string };

export interface StakeResult {
  front: Front;
  changes: StakeChange[];
  /** Почему ставка не сыграла: цели нет или её нельзя трогать. */
  invalid: 'missing_target' | 'protected' | null;
}

export interface VersionDraft {
  description: string;
  weight: Impact;
  statProfile: Partial<StatMap>;
  statEffect?: StatMap;
}

/** Нужна ли этой ставке новая версия от агента. */
export function stakeNeedsVersion(front: Front): ModifyStake['modify'] | null {
  const stake = front.stake;
  if (stake && 'modify' in stake && !stake.modify.proposed) return stake.modify;
  return null;
}

/** Закрыть фронт и снять с него все поручения. */
export function finishFront(city: City, front: Front, day: number, status: 'resolved' | 'invalid'): void {
  front.status = status;
  front.resolvedDay = Math.max(0, Math.round(day));
  for (const a of activeAssignmentsForFront(city, front.id)) closeAssignment(city, a.id, day, 'done');
}

export function applyStake(
  rules: Rules,
  city: City,
  front: Front,
  args: { day: number; newObjectId: () => string; version?: VersionDraft | null },
): StakeResult {
  const { day } = args;
  const stake = front.stake;
  const changes: StakeChange[] = [];
  const fail = (invalid: StakeResult['invalid']): StakeResult => {
    finishFront(city, front, day, 'invalid');
    return { front, changes, invalid };
  };

  if (!stake) {
    // Фронт без ставки просто заканчивается.
  } else if ('create' in stake) {
    const spec = stake.create;
    const effect = spec.statEffect ?? objectContribution(rules, spec.weight ?? 'SIGNIFICANT', spec.statProfile ?? {});
    const obj = createObject(rules, {
      id: args.newObjectId(),
      type: spec.type,
      name: spec.name,
      description: spec.description || spec.name,
      statEffect: effect,
      refs: spec.refs ?? [],
      day,
    });
    city.objects.push(obj);
    recomputeStats(city);
    changes.push({ kind: 'created', id: obj.id });
  } else if ('modify' in stake) {
    const obj = findObject(city, stake.modify.target);
    if (!obj || obj.status !== 'active') return fail('missing_target');
    const proposed = stake.modify.proposed ?? args.version;
    if (!proposed) throw new Error('ставка modify без новой версии');
    const effect =
      proposed.statEffect ??
      objectContribution(rules, proposed.weight ?? 'MINOR', proposed.statProfile ?? obj.statEffect);
    addObjectVersion(rules, obj, { description: proposed.description || obj.description, statEffect: effect, day });
    recomputeStats(city);
    changes.push({ kind: 'modified', id: obj.id });
  } else if ('delete' in stake) {
    const obj = findObject(city, stake.delete.target);
    if (!obj || obj.status !== 'active') return fail('missing_target');
    if (obj.protected) return fail('protected');
    deleteObject(obj, day);
    recomputeStats(city);
    changes.push({ kind: 'deleted', id: obj.id });
  } else if ('stats' in stake) {
    addToLedger(city, stake.stats);
    changes.push({ kind: 'stats', deltas: stake.stats });
  } else if ('reveal' in stake) {
    changes.push({ kind: 'reveal', text: stake.reveal.text.trim() });
  }

  finishFront(city, front, day, 'resolved');
  return { front, changes, invalid: null };
}

/** Сухой факт о сыгравшей ставке для хрониста. */
export function stakeFact(city: City, result: StakeResult): string {
  const lines: string[] = [];
  for (const change of result.changes) {
    if (change.kind === 'reveal') lines.push(change.text);
    if (change.kind === 'created' || change.kind === 'modified' || change.kind === 'deleted') {
      const obj = findObject(city, change.id);
      const verb = change.kind === 'created' ? 'Появилось' : change.kind === 'modified' ? 'Изменилось' : 'Исчезло';
      if (obj) lines.push(`${verb}: ${obj.name}. ${obj.description}`.trim());
    }
    if (change.kind === 'stats') lines.push(result.front.description);
  }
  return lines.join('\n') || result.front.description;
}
