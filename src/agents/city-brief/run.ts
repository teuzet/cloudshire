/**
 * Бриф города: компактные устойчивые факты для других агентов и канонические неизвестности,
 * привязанные к объектам острова.
 */

import type { CanonicalUnknown, Gender, WorldObject } from '../../core/city.js';
import { normalizeUnknowns } from '../../core/lore.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { objectsBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { BRIEF_MAX, cityBriefSchema, type CityBriefRaw } from './schema.js';

export interface CityBriefInput {
  cityName: string;
  patronName: string;
  patronGender: Gender;
  description: string;
  objects: WorldObject[];
}

export interface CityBrief {
  brief: string;
  unknowns: CanonicalUnknown[];
}

const prompt = loadPrompt(import.meta.url);

export const cityBriefAgent: StructuredAgent<CityBriefInput, CityBriefRaw, CityBrief> = {
  name: 'city-brief',
  tool: 'submit_city_brief',
  description: 'Компактный фактический бриф города. Тело — устойчивые факты. unknowns — канонические неизвестности, не сюжет.',
  schema: cityBriefSchema,
  system: ({ cityName, patronName, patronGender, description, objects }) =>
    composeSystem(
      ['world'],
      prompt,
      `Город «${cityName}».`,
      `Покровитель: «${patronName}», ${patronGender === 'female' ? 'женщина' : 'мужчина'}.`,
      description,
      section('ОБЪЕКТЫ', objectsBlock(objects)),
    ),
  user: () =>
    [
      'Собери КОМПАКТНЫЙ фактический бриф этого города для других агентов.',
      `Уложись в ${BRIEF_MAX} знаков.`,
      'Не пересказывай генезис литературно. Не пиши хронику месяца и не выдумывай тайну.',
      'Оставь: рельеф и хозяйство, институты, ключевые места, устойчивые напряжения, необычные постоянные черты.',
      'Только извлекай, ничего не добавляй. Не выдумывай офицеров, сановников и статы.',
      'Канонические неизвестности (в тексте прямо сказано, что X официально не установлено / никто не видел / не доказано) — в unknowns, узкими пунктами. Не дублируй их в brief. Слух и догадку в unknowns не клади. Бытовые дыры (даты, имена постов, сколько раз) — не unknowns.',
      'Бриф — живой документ: позже в нём могут поправить кусок, если город как место изменится навсегда.',
      'Вызови submit_city_brief.',
    ].join('\n'),
  check: (raw, { objects }) => {
    const known = new Set(objects.map((o) => o.id));
    const bad = raw.unknowns.flatMap((u) => u.object_ids).filter((id) => !known.has(id));
    return bad.length ? `нет таких объектов: ${[...new Set(bad)].join(', ')}` : null;
  },
  finish: (raw, { objects }) => ({
    brief: raw.brief.slice(0, BRIEF_MAX + 500),
    unknowns: normalizeUnknowns(
      raw.unknowns.map((u) => ({ text: u.text, objectIds: u.object_ids })),
      new Set(objects.map((o) => o.id)),
    ),
  }),
};

export async function writeCityBrief(deps: AgentDeps, input: CityBriefInput): Promise<CityBrief> {
  return (await runStructured(deps, cityBriefAgent, input)).value;
}
