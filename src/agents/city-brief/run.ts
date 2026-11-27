/**
 * Бриф города: неизменное в городе для других агентов (изменяемое живёт в объектах)
 * и канонические неизвестности, привязанные к объектам острова. После генезиса бриф не правится.
 */

import type { CanonicalUnknown, Gender, WorldObject } from '../../core/city.js';
import { normalizeUnknowns } from '../../core/lore.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { objectsBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { BRIEF_MAX, BRIEF_MIN, cityBriefSchema, type CityBriefRaw } from './schema.js';

export interface CityBriefInput {
  cityName: string;
  patronName: string;
  patronGender: Gender;
  /** Портрет города. */
  description: string;
  /** Скрытая правда мира: только для неизвестностей. */
  hidden?: string;
  objects: WorldObject[];
  /** Люди города вне объектов: жрец и сановники. */
  people?: readonly string[];
}

export interface CityBrief {
  brief: string;
  unknowns: CanonicalUnknown[];
}

const prompt = loadPrompt(import.meta.url);

/** Опорные слова имени: слова с заглавной буквы не в начале (у человека — все). Берутся основы, чтобы ловить падежи. */
function nameStems(name: string, person: boolean): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  return (person ? words : words.slice(1))
    .filter((w) => /^[А-ЯЁA-Z]/.test(w))
    .map((w) => w.replace(/[^А-ЯЁа-яёA-Za-z-]/g, ''))
    .map((w) => (w.length > 4 ? w.slice(0, w.length - 2) : w))
    .filter((w) => w.length >= 3);
}

/** Почему бриф не годится, или null. Экспорт для тестов. */
export function briefProblem(raw: CityBriefRaw, input: Pick<CityBriefInput, 'objects' | 'people' | 'cityName' | 'patronName'>): string | null {
  const known = new Set(input.objects.map((o) => o.id));
  const bad = raw.unknowns.flatMap((u) => u.object_ids).filter((id) => !known.has(id));
  if (bad.length) return `нет таких объектов: ${[...new Set(bad)].join(', ')}`;
  if (raw.brief.length > BRIEF_MAX + 400) return `бриф ${raw.brief.length} знаков, нужно до ${BRIEF_MAX}`;
  // Имена города и покровителя бриф называет свободно.
  const own = new Set([...nameStems(input.cityName, true), ...nameStems(input.patronName, true)]);
  const hits = (stems: string[]): boolean =>
    stems.length > 0 && stems.every((st) => own.has(st) || new RegExp(`(^|[^А-ЯЁа-яёA-Za-z])${st}`).test(raw.brief)) && stems.some((st) => !own.has(st));
  const named = [
    ...input.objects.filter((o) => hits(nameStems(o.name, o.type === 'person'))).map((o) => o.name),
    ...(input.people ?? []).filter((n) => hits(nameStems(n, true))),
  ];
  return named.length ? `бриф называет то, что может измениться: ${named.join(', ')}. Скажи об этом общими словами` : null;
}

export const cityBriefAgent: StructuredAgent<CityBriefInput, CityBriefRaw, CityBrief> = {
  name: 'city-brief',
  tool: 'submit_city_brief',
  description: 'Бриф города: неизменное в нём. unknowns — то, что в мире прямо не установлено, с привязкой к объектам.',
  schema: cityBriefSchema,
  system: ({ cityName, patronName, patronGender, description, hidden, objects }) =>
    composeSystem(
      ['world'],
      prompt,
      `Город «${cityName}».`,
      `Покровитель: «${patronName}», ${patronGender === 'female' ? 'женщина' : 'мужчина'}.`,
      section('ПОРТРЕТ', description),
      hidden ? section('СКРЫТОЕ (чего горожане не знают; в бриф не пиши, только для неизвестностей)', hidden) : '',
      section('ОБЪЕКТЫ', objectsBlock(objects)),
    ),
  user: () => `Напиши бриф, от ${BRIEF_MIN} до ${BRIEF_MAX} знаков, и неизвестности. Вызови submit_city_brief.`,
  check: (raw, input) => briefProblem(raw, input),
  finish: (raw, { objects }) => ({
    brief: raw.brief,
    unknowns: normalizeUnknowns(
      raw.unknowns.map((u) => ({ text: u.text, objectIds: u.object_ids })),
      new Set(objects.map((o) => o.id)),
    ),
  }),
};

export async function writeCityBrief(deps: AgentDeps, input: CityBriefInput): Promise<CityBrief> {
  return (await runStructured(deps, cityBriefAgent, input)).value;
}
