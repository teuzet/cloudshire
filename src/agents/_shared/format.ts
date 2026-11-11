/**
 * Как сущности ядра выглядят в промпте. Один формат на всех агентов,
 * чтобы модель везде видела одно и то же.
 */

import type { Rules, StatMap } from '../../core/rules.js';
import { STAT_IDS } from '../../core/rules.js';
import type { ChronicleEntry, Front, Officer, WorldObject } from '../../core/city.js';
import { gameDate } from '../../core/time.js';

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

/** Фронт для судей: описание, скрытая логика, живые события и скрытые улики. */
export function frontBlock(front: Front): string {
  const events = front.events.filter((e) => e.status !== 'fired');
  const clues = front.clues.filter((c) => c.status === 'hidden');
  return [
    `Фронт ${front.id}: ${front.description}`,
    section('Скрытая логика фронта', front.alignment),
    events.length ? section('События', bullets(events.map((e) => `${e.id} [${e.status}]: ${e.description}`))) : 'Событий нет.',
    clues.length ? section('Улики', bullets(clues.map((c) => `${c.id}: ${c.fact}`))) : '',
  ]
    .filter(Boolean)
    .join('\n\n');
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

export function namesBlock(names: readonly string[]): string {
  return names.length ? section('ИМЕНА', names.join(', ')) : 'ИМЕНА: списка нет, новых людей не заводи.';
}
