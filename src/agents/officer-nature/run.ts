/**
 * Сановники: имена из пула мира и характер каждого в 1–2 предложениях.
 */

import type { Gender, PoolName } from '../../core/city.js';
import { OFFICES, type Office, type Rules } from '../../core/rules.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { namesBlock } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { officerNaturesSchema, type OfficerNaturesRaw } from './schema.js';

export interface OfficerPerson {
  name: string;
  gender: Gender;
  nature: string;
}

export interface OfficerNatureInput {
  rules: Rules;
  cityName: string;
  description: string;
  names: readonly PoolName[];
  /** Имена, уже занятые в этом городе (жрец). */
  taken: readonly string[];
}

const prompt = loadPrompt(import.meta.url);

export const officerNature: StructuredAgent<OfficerNatureInput, OfficerNaturesRaw, Record<Office, OfficerPerson>> = {
  name: 'officer-nature',
  tool: 'submit_officer_natures',
  description: 'Имя и характер каждого сановника: 1–2 предложения, не биография.',
  schema: officerNaturesSchema,
  system: ({ names }) => composeSystem(['world', 'style-names'], prompt, namesBlock(names)),
  user: ({ rules, cityName, description }) =>
    [
      `Город «${cityName}». Напиши характер четырёх сановников: как решают, чего не выносят, чем славятся.`,
      'По 1–2 предложения. Не биография, не диалоговая карточка. Не делай их героями историй.',
      '',
      ...rules.officers.map((o) => `- ${o.office} / ${o.title}. Ведает: ${o.focus}. Как действует: ${o.strategy}`),
      '',
      description.slice(0, 2500),
      '',
      'Вызови submit_officer_natures для всех четырёх.',
    ].join('\n'),
  check: (raw, { names, taken }) => {
    const offices = new Set(raw.officers.map((o) => o.office));
    if (offices.size !== OFFICES.length) return 'нужен ровно один на каждую должность';
    const used = raw.officers.map((o) => o.name);
    if (new Set(used).size !== used.length) return 'имена сановников повторяются';
    const clash = used.filter((n) => taken.includes(n));
    if (clash.length) return `имя уже занято: ${clash.join(', ')}`;
    const foreign = used.filter((n) => names.length && !names.some((p) => p.name === n));
    return foreign.length ? `имён нет в списке: ${foreign.join(', ')}` : null;
  },
  finish: (raw, { names }) =>
    Object.fromEntries(
      raw.officers.map((o) => [o.office, { name: o.name, gender: names.find((n) => n.name === o.name)?.gender ?? 'male', nature: o.nature }]),
    ) as Record<Office, OfficerPerson>,
};

export async function writeOfficerNatures(deps: AgentDeps, input: OfficerNatureInput): Promise<Record<Office, OfficerPerson>> {
  return (await runStructured(deps, officerNature, input)).value;
}
