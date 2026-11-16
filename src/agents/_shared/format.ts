/**
 * Как сущности ядра выглядят в промпте. Один формат на всех агентов,
 * чтобы модель везде видела одно и то же.
 */

import type { Rules, StatMap } from '../../core/rules.js';
import { STAT_IDS } from '../../core/rules.js';
import type { ChronicleEntry, City, Front, Officer, PoolName, WorldObject } from '../../core/city.js';
import { gameDate, spanBand } from '../../core/time.js';
import { leadOf, officerOf } from '../../core/world/assignments.js';
import { EFFECT_WORDS, effectOf, hindrancesOf } from '../../core/world/hindrance.js';
import { daysLeft, isFrozen, progressAt, shareDone } from '../../core/world/fronts.js';
import { leadRatePerDay } from '../../core/world/numbers.js';

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
export function frontLine(
  city: Pick<City, 'assignments' | 'officers' | 'fronts' | 'objects'>,
  front: Front,
  day: number,
  rules?: Rules,
): string {
  const lead = leadOf(city, front.id);
  const officer = lead ? officerOf(city, lead) : null;
  const left = daysLeft(front, day);
  const parts: string[] = [front.plus ? 'удобный случай' : FRONT_FORM_WORDS[front.form]];
  if (front.capacity > 0) parts.push(shareWords(shareDone(front, day)));
  if (isFrozen(city, front)) parts.push('стоит, пока не снята угроза');
  else if (front.capacity > 0 && left == null && officer) {
    // Ведущий есть, а работа стоит: без этого жрец уверен, что дело идёт.
    parts.push('работа стоит на месте');
  } else if (front.capacity > 0 && left == null) {
    parts.push('никто не ведёт, дело стоит');
    // Сколько займёт у одного подходящего сановника: чтобы жрец видел, успеет ли дело к сроку.
    const rate = rules ? leadRatePerDay(rules, { verdict: 'fits', tempoSum: front.tempo, fit: 1 }) : 0;
    if (rate > 0) parts.push(`одному сановнику работы на: ${spanBand(Math.ceil((front.capacity - progressAt(front, day)) / rate))}`);
  }
  else if (front.capacity > 0 && left != null) parts.push(`работы осталось: ${spanBand(left)}`);
  if (front.deadlineDay != null) parts.push(`срок: ${spanBand(Math.max(0, front.deadlineDay - day))}`);
  // Полосы грубые: «сезон» работы и «сезон» срока не скажут, успеет ли ведущий. Это считает код.
  if (front.capacity > 0 && left != null && front.deadlineDay != null && day + left > front.deadlineDay) {
    parts.push('при нынешней работе к сроку не успеть');
  }
  if (officer) parts.push(`ведёт ${officer.title.toLowerCase()} ${officer.name}`);
  // Что мешает делу и как: словами мира. Как с этим быть, решает покровитель.
  for (const obj of hindrancesOf(city, front.id)) {
    parts.push(obj.attach?.answered ? `рядом ${obj.name}, но нынешний способ работы с этим справляется` : `мешает ${obj.name}: ${EFFECT_WORDS[effectOf(obj)]}`);
  }
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
