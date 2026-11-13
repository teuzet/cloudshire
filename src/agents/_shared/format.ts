/**
 * Как сущности ядра выглядят в промпте. Один формат на всех агентов,
 * чтобы модель везде видела одно и то же.
 */

import type { Rules, StatMap } from '../../core/rules.js';
import { STAT_IDS } from '../../core/rules.js';
import type { ChronicleEntry, City, Front, Officer, PoolName, WorldObject } from '../../core/city.js';
import { gameDate, spanBand } from '../../core/time.js';
import { leadOf, officerOf } from '../../core/world/assignments.js';
import { daysLeft, isFrozen, shareDone } from '../../core/world/fronts.js';

export function bullets(lines: Array<string | null | undefined | false>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.length > 0).map((l) => `- ${l}`).join('\n');
}

export function section(title: string, body: string | null | undefined): string {
  const text = body?.trim();
  return text ? `${title}:\n${text}` : '';
}

export function objectLine(obj: Pick<WorldObject, 'id' | 'type' | 'name' | 'description'>): string {
  return `${obj.id} [${obj.type}] ${obj.name}: ${obj.description}`;
}

export function objectsBlock(objects: Array<Pick<WorldObject, 'id' | 'type' | 'name' | 'description'>>): string {
  return bullets(objects.map(objectLine));
}

const FRONT_FORM_WORDS: Record<Front['form'], string> = {
  deed: 'дело',
  tension: 'растёт напряжение',
  threat: 'угроза',
  clock: 'ждёт своего часа',
  find: 'поиск',
};

function shareWords(share: number): string {
  if (share <= 0.05) return 'в самом начале';
  if (share < 0.4) return 'пройдена меньшая часть';
  if (share < 0.65) return 'пройдена примерно половина';
  if (share < 0.95) return 'пройдена большая часть';
  return 'почти готово';
}

/**
 * Идущий фронт одной строкой для жреца: что это, далеко ли зашло, сколько осталось, кто ведёт.
 * Числа жрец не видит: срок приходит словесной полосой.
 */
export function frontLine(city: Pick<City, 'assignments' | 'officers' | 'fronts'>, front: Front, day: number): string {
  const lead = leadOf(city, front.id);
  const officer = lead ? officerOf(city, lead) : null;
  const left = daysLeft(front, day);
  const parts: string[] = [front.plus ? 'удобный случай' : FRONT_FORM_WORDS[front.form]];
  if (front.capacity > 0) parts.push(shareWords(shareDone(front, day)));
  if (isFrozen(city, front)) parts.push('стоит, пока не снята угроза');
  else if (front.capacity > 0 && left == null) parts.push('никто не ведёт, дело стоит');
  else if (front.capacity > 0 && left != null) parts.push(`работы осталось: ${spanBand(left)}`);
  if (front.deadlineDay != null) parts.push(`срок: ${spanBand(Math.max(0, front.deadlineDay - day))}`);
  if (officer) parts.push(`ведёт ${officer.title.toLowerCase()} ${officer.name}`);
  // Заголовок фронта агентам не нужен: они имеют дело с тем, что происходит.
  return `${front.id}: ${front.description || front.title} (${parts.join('; ')})`;
}

export function officerLine(officer: Officer): string {
  return `${officer.title} ${officer.name} (${officer.gender === 'female' ? 'она' : 'он'}): ${officer.nature}`;
}

export function chronicleBlock(entries: ChronicleEntry[]): string {
  return entries.map((e) => `[${gameDate(e.day).label}] ${e.text}`).join('\n\n');
}

export function statProfileLine(rules: Rules, profile: Partial<StatMap>): string {
  return STAT_IDS.filter((id) => profile[id])
    .map((id) => `${rules.stats.find((s) => s.id === id)?.name ?? id}: ${profile[id]}`)
    .join(', ');
}

/** Список имён для новых людей. Пол задан списком: ж — женщина, м — мужчина. */
export function namesBlock(names: readonly PoolName[]): string {
  return names.length
    ? section('ИМЕНА (пол задан: ж — женщина, м — мужчина; согласуй род)', names.map((n) => `${n.name} (${n.gender === 'female' ? 'ж' : 'м'})`).join(', '))
    : 'ИМЕНА: списка нет, новых людей не заводи.';
}
