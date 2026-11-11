/**
 * Генезис: из «рыбы» онбординга — описание города, бриф, жрец, сановники и первое слово.
 * Объекты мира из описания вынимает отдельный агент (world-objects-genesis).
 */

import type { CitySeed, Gender } from '../../core/city.js';
import type { Office } from '../../core/rules.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { namesBlock } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { genesisSchema, type GenesisRaw } from './schema.js';

export interface Person {
  name: string;
  gender: Gender;
  nature: string;
}

export interface CityGenesis {
  cityName: string;
  description: string;
  brief: string;
  priest: Person;
  officers: Record<Office, Person>;
  greeting: string;
}

export interface CityGenesisInput {
  seed: CitySeed;
  names: readonly string[];
  /** Мировые правила сезона, если есть: город о них знает. */
  seasonRules: readonly string[];
}

const prompt = loadPrompt(import.meta.url);

export const cityGenesis: StructuredAgent<CityGenesisInput, GenesisRaw, CityGenesis> = {
  name: 'city-genesis',
  tool: 'submit_genesis',
  description: 'Генезис города.',
  schema: genesisSchema,
  system: ({ names, seasonRules }) =>
    composeSystem(
      ['world', 'patron', 'style-names'],
      prompt,
      namesBlock(names),
      seasonRules.length ? `Что известно всему небу в эту пору:\n${seasonRules.map((r) => `- ${r}`).join('\n')}` : '',
    ),
  user: ({ seed }) =>
    [
      seed.cityName ? `Имя города: ${seed.cityName}` : 'Имя города: придумай',
      `Покровитель: ${seed.patronName} (${seed.patronGender === 'female' ? 'покровительница' : 'покровитель'})`,
      `Заготовка игрока:\n${seed.pitch}`,
    ].join('\n'),
  check: (raw, { seed, names }) => {
    if (seed.cityName && raw.city_name !== seed.cityName) return `city_name должно быть ровно «${seed.cityName}»`;
    const people = [raw.priest, raw.officers.treasurer, raw.officers.marshal, raw.officers.keeper, raw.officers.chancellor];
    const used = people.map((p) => p.name);
    if (new Set(used).size !== used.length) return 'имена людей повторяются';
    const allowed = new Set(names);
    const foreign = used.filter((n) => !allowed.has(n));
    return allowed.size && foreign.length ? `имён нет в списке: ${foreign.join(', ')}` : null;
  },
  finish: (raw) => ({
    cityName: raw.city_name,
    description: raw.description,
    brief: raw.brief,
    priest: raw.priest,
    officers: raw.officers,
    greeting: raw.greeting,
  }),
};

export async function writeCityGenesis(deps: AgentDeps, input: CityGenesisInput): Promise<CityGenesis> {
  return (await runStructured(deps, cityGenesis, input)).value;
}
