/**
 * Портрет города из питча: первый шаг генезиса. Свободный текст на страницу, скрытая правда мира,
 * имя города и верховный жрец. Объекты, сановники, бриф и стартовая сцена — отдельные агенты.
 */

import type { CitySeed, Gender, PoolName } from '../../core/city.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { namesBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { PORTRAIT_MAX, PORTRAIT_MIN, portraitSchema, type PortraitRaw } from './schema.js';

export interface CityPortrait {
  cityName: string;
  priest: { name: string; gender: Gender; nature: string };
  portrait: string;
  hidden: string;
}

export interface CityPortraitInput {
  seed: CitySeed;
  names: readonly PoolName[];
  /** Мировые правила сезона, если есть: город о них знает. */
  seasonRules: readonly string[];
}

const prompt = loadPrompt(import.meta.url);

export const cityPortrait: StructuredAgent<CityPortraitInput, PortraitRaw, CityPortrait> = {
  name: 'city-genesis',
  tool: 'submit_portrait',
  description: 'Портрет города, скрытая правда, имя города и верховный жрец.',
  schema: portraitSchema,
  system: ({ seasonRules, names }) =>
    composeSystem(
      ['world', 'patron', 'style-names'],
      prompt,
      namesBlock(names),
      seasonRules.length ? section('ЧТО ИЗВЕСТНО ВСЕМУ НЕБУ В ЭТУ ПОРУ', seasonRules.map((r) => `- ${r}`).join('\n')) : '',
    ),
  user: ({ seed }) =>
    [
      section('ПИТЧ ИГРОКА', seed.pitch),
      `Покровитель города: ${seed.patronName}, ${seed.patronGender === 'female' ? 'покровительница' : 'покровитель'}.`,
      seed.cityName ? `Имя города дал игрок: «${seed.cityName}».` : 'Имя города игрок оставил миру: придумай его.',
      `Портрет — от ${PORTRAIT_MIN} до ${PORTRAIT_MAX} знаков. Вызови submit_portrait.`,
    ].join('\n\n'),
  check: (raw, { seed, names }) => {
    if (seed.cityName && raw.city_name !== seed.cityName) return `city_name должно быть ровно «${seed.cityName}»`;
    if (names.length && !names.some((n) => n.name === raw.priest_name)) return `имени ${raw.priest_name} нет в списке ИМЕНА`;
    if (raw.portrait.length > PORTRAIT_MAX + 500) return `портрет ${raw.portrait.length} знаков, нужно до ${PORTRAIT_MAX}`;
    return null;
  },
  finish: (raw, { names }) => ({
    cityName: raw.city_name,
    priest: { name: raw.priest_name, gender: names.find((n) => n.name === raw.priest_name)?.gender ?? 'male', nature: raw.priest_nature },
    portrait: raw.portrait,
    hidden: raw.hidden,
  }),
};

export async function writeCityPortrait(deps: AgentDeps, input: CityPortraitInput): Promise<CityPortrait> {
  return (await runStructured(deps, cityPortrait, input)).value;
}
