/**
 * Перемены состояния города — «дифф», который код собирает за одно событие.
 * Летописец оформляет его в запись хроники, эхо и обновление ищут по нему задетое.
 */

import { STAT_IDS, type FrontForm, type ObjectType, type Rules, type StatMap } from '../rules.js';
import { magnitude } from './numbers.js';

export type Change =
  | { kind: 'object_created'; objectId: string; name: string; type: ObjectType; points: StatMap; temporary: boolean; hidden: boolean }
  | { kind: 'object_changed'; objectId: string; name: string; delta: StatMap; description: string | null }
  | { kind: 'object_removed'; objectId: string; name: string; points: StatMap; hidden: boolean }
  /** Объект выбыл: остался в городе, но ничего не даёт. */
  | { kind: 'object_out'; objectId: string; name: string; delta: StatMap }
  /** Выбывший объект вернулся к жизни. */
  | { kind: 'object_back'; objectId: string; name: string; delta: StatMap; description: string | null }
  | { kind: 'object_revealed'; objectId: string; name: string; description?: string }
  | { kind: 'fact'; text: string }
  | { kind: 'linked'; a: string; b: string; names: [string, string] }
  | { kind: 'stats'; points: Partial<StatMap> }
  | { kind: 'front_opened'; frontId: string; title: string; form: FrontForm; plus: boolean }
  | { kind: 'front_closed'; frontId: string; title: string; outcome: 'done' | 'averted' | 'failed' | 'cancelled' | 'expired' }
  | { kind: 'front_moved'; frontId: string; title: string; how: 'rollback' | 'pushed' | 'eased' | 'frozen' | 'slowed' | 'helped' | 'cleared' | 'setback' | 'burst' };

const TYPE_WORDS: Record<ObjectType, string> = {
  building: 'здание',
  structure: 'большое сооружение',
  landmark: 'достопримечательность',
  district: 'квартал',
  settlement: 'поселение',
  site: 'место',
  object: 'вещь',
  resource: 'запас',
  organization: 'учреждение',
  community: 'группа людей',
  person: 'человек',
  practice: 'обычай',
  capability: 'умение',
  policy: 'закон',
  threat: 'опасность',
  mystery: 'тайна',
};

function strength(abs: number): string {
  if (abs < 1.5) return 'чуть';
  if (abs < 4) return 'заметно';
  if (abs < 9) return 'сильно';
  return 'резко';
}

/** Как сдвиг стата виден в жизни города: [рост, спад]. Названия показателей в тексты не идут. */
const LIFE_WORDS: Record<(typeof STAT_IDS)[number], readonly [string, string]> = {
  prosperity: ['в лавках, мастерских и амбарах прибавилось', 'в лавках, мастерских и амбарах убавилось'],
  security: ['на улицах и у стен стало спокойнее', 'на улицах и у стен стало тревожнее'],
  knowledge: ['знающих людей и записей прибавилось', 'знающих людей и записей убавилось'],
  influence: ['к слову города прислушиваются охотнее', 'к слову города прислушиваются меньше'],
};

/** Сдвиг статов словами о жизни: агенты и игрок не видят ни чисел, ни названий показателей. */
export function statShiftWords(_rules: Pick<Rules, 'stats'>, delta: Partial<StatMap>): string {
  const parts: string[] = [];
  for (const id of STAT_IDS) {
    const v = Number(delta[id]) || 0;
    if (Math.abs(v) < 0.5) continue;
    parts.push(`${strength(Math.abs(v))} ${v > 0 ? LIFE_WORDS[id][0] : LIFE_WORDS[id][1]}`);
  }
  return parts.join(', ');
}

export const FORM_WORDS: Record<FrontForm, string> = {
  deed: 'дело',
  tension: 'растущее напряжение',
  threat: 'угроза со сроком',
  clock: 'отложенная перемена',
  find: 'поиск',
};

/** Как началось, словами мира: летописец и глашатай видят события, а не устройство игры. */
const OPENED_WORDS: Record<FrontForm, string> = {
  deed: 'это предстоит сделать',
  tension: 'растёт недовольство',
  threat: 'надвигается беда',
  clock: 'скоро это случится',
  find: 'предстоит разузнать',
};

const CLOSED_WORDS = {
  done: 'Сделано',
  averted: 'Обошлось',
  failed: 'Случилось',
  cancelled: 'Брошено',
  expired: 'Упущено',
} as const;

const MOVED_WORDS: Record<Extract<Change, { kind: 'front_moved' }>['how'], (t: string) => string> = {
  rollback: (t) => `Работу над «${t}» отбросило назад`,
  pushed: (t) => `Работа над «${t}» сильно продвинулась`,
  eased: (t) => `«${t}» ещё не позади`,
  frozen: (t) => `Работа над «${t}» встала, пока опасность рядом`,
  slowed: (t) => `Работа над «${t}» идёт медленнее из-за помехи`,
  helped: (t) => `У работы над «${t}» появились помощники`,
  cleared: (t) => `Помеху убрали, работа над «${t}» идёт дальше`,
  setback: (t) => `Часть сделанного для «${t}» потеряна`,
  burst: (t) => `«${t}» вылилось в открытую беду`,
};

/** Перемены словами для Летописца. Скрытое в список не попадает. */
export function describeChanges(rules: Pick<Rules, 'stats'>, changes: readonly Change[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    switch (c.kind) {
      case 'object_created': {
        if (c.hidden) break;
        const shift = statShiftWords(rules, c.points);
        out.push(c.temporary ? `Там, где идёт работа: ${c.name}` : `Появилось: ${c.name} (${TYPE_WORDS[c.type]})${shift ? `. В жизни города: ${shift}` : ''}`);
        break;
      }
      case 'object_changed': {
        const shift = statShiftWords(rules, c.delta);
        out.push(`Изменилось: ${c.name}${c.description ? `. Теперь: ${c.description}` : ''}${shift ? `. В жизни города: ${shift}` : ''}`);
        break;
      }
      case 'object_out': {
        const shift = statShiftWords(rules, c.delta);
        out.push(`Больше не служит городу, но ещё может быть возвращено: ${c.name}${shift ? `. В жизни города: ${shift}` : ''}`);
        break;
      }
      case 'object_back': {
        const shift = statShiftWords(rules, c.delta);
        out.push(`Возвращено к жизни: ${c.name}${c.description ? `. Теперь: ${c.description}` : ''}${shift ? `. В жизни города: ${shift}` : ''}`);
        break;
      }
      case 'object_removed': {
        if (c.hidden) break;
        const shift = statShiftWords(rules, negate(c.points));
        out.push(`Исчезло: ${c.name}${shift ? `. В жизни города: ${shift}` : ''}`);
        break;
      }
      case 'object_revealed':
        out.push(`Открылось: ${c.name}${c.description ? ` — ${c.description}` : ''}`);
        break;
      case 'fact':
        out.push(`Стало известно: ${c.text}`);
        break;
      case 'linked':
        out.push(`Теперь связаны: ${c.names[0]} и ${c.names[1]}`);
        break;
      case 'stats': {
        const shift = statShiftWords(rules, c.points);
        if (shift) out.push(`В жизни города: ${shift}`);
        break;
      }
      case 'front_opened':
        out.push(
          c.plus
            ? `Выпал случай: «${c.title}». Если никто не возьмётся вовремя, он уйдёт`
            : `Началось: «${c.title}» — ${OPENED_WORDS[c.form]}`,
        );
        break;
      case 'front_closed':
        out.push(`${CLOSED_WORDS[c.outcome]}: «${c.title}»`);
        break;
      case 'front_moved':
        out.push(MOVED_WORDS[c.how](c.title));
        break;
    }
  }
  return out;
}

function negate(points: StatMap): StatMap {
  return { prosperity: -points.prosperity, security: -points.security, knowledge: -points.knowledge, influence: -points.influence };
}

/** Объекты, чей вклад или существование изменились: от них идут эхо и обновление. */
export function changedObjectIds(changes: readonly Change[]): string[] {
  const ids = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'object_created' && !c.temporary) ids.add(c.objectId);
    if (c.kind === 'object_changed' && (magnitude(c.delta) > 0 || c.description)) ids.add(c.objectId);
    if (c.kind === 'object_removed' || c.kind === 'object_out' || c.kind === 'object_back') ids.add(c.objectId);
    if (c.kind === 'object_revealed') ids.add(c.objectId);
  }
  return [...ids];
}

/** Есть ли в переменах то, что обязано попасть в хронику. */
export function isNotable(changes: readonly Change[]): boolean {
  return changes.some((c) => !(c.kind === 'object_created' && c.hidden) && !(c.kind === 'object_removed' && c.hidden));
}
