/**
 * Как данные выглядят в промптах узких агентов системы фронтов.
 * Эти агенты получают простые структуры, а не сущности ядра: поток сам решает, что им показать.
 */

import { GRADES, STAT_IDS, type Grade, type ObjectType, type Rules, type StatGrade, type StatId } from '../../core/rules.js';

/** Объект города в том виде, в каком его видит узкий агент. */
export interface ObjectBrief {
  id: string;
  type: ObjectType;
  name: string;
  description: string;
}

/** Виды объектов обычными словами: модель не обязана знать внутренние коды. */
export const TYPE_WORDS: Record<ObjectType, string> = {
  building: 'здание',
  structure: 'большое сооружение',
  landmark: 'достопримечательность',
  district: 'квартал',
  settlement: 'поселение',
  site: 'место',
  object: 'вещь',
  resource: 'ресурс или запас',
  organization: 'учреждение',
  community: 'группа людей',
  person: 'человек',
  practice: 'обычай или порядок',
  capability: 'умение или знание',
  policy: 'закон или указ',
  threat: 'опасность',
  mystery: 'тайна',
};

export function typesBlock(): string {
  return (Object.keys(TYPE_WORDS) as ObjectType[]).map((t) => `- ${t} — ${TYPE_WORDS[t]}`).join('\n');
}

export function briefLine(o: ObjectBrief): string {
  return `${o.id} — ${o.name} (${TYPE_WORDS[o.type]})${o.description ? `: ${o.description}` : ''}`;
}

export function briefList(objects: readonly ObjectBrief[], empty = 'пусто'): string {
  return objects.length ? objects.map((o) => `- ${briefLine(o)}`).join('\n') : empty;
}

export function block(title: string, body: string | null | undefined): string {
  const text = body?.trim();
  return text ? `${title}:\n${text}` : '';
}

export function join(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join('\n\n');
}

const GRADE_WORDS: Record<Grade, string> = { small: 'small', medium: 'medium', large: 'large', huge: 'huge' };

/** Вклад словами для промпта: «security up large; prosperity down small». */
export function gradesLine(effects: readonly StatGrade[]): string {
  return effects.length ? effects.map((e) => `${e.stat} ${e.direction} ${GRADE_WORDS[e.size]}`).join('; ') : 'нет';
}

/** Определения статов из правил: что каждый показатель значит и что в него входит. */
export function statDefinitions(rules: Rules): string {
  return rules.stats
    .map((s) => `- ${s.id} (${s.name}): ${[s.about, s.covers ? `Сюда входит: ${s.covers}` : ''].filter(Boolean).join(' ')}`)
    .join('\n');
}

export function isStatId(raw: string): raw is StatId {
  return (STAT_IDS as readonly string[]).includes(raw);
}

export const GRADE_LIST = GRADES;
