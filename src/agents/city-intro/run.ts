/**
 * Стартовая сцена: вид острова сверху (сообщение системы) и первый зов жреца, проверка связи.
 * Ликует жрец позже, получив первый ответ покровителя: это видит агент priest.
 */

import type { Gender, WorldObject } from '../../core/city.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { CALL_MAX, VIEW_MAX, VIEW_MIN, introSchema, type IntroRaw } from './schema.js';

export interface CityIntroInput {
  cityName: string;
  patronName: string;
  patronGender: Gender;
  brief: string;
  objects: ReadonlyArray<Pick<WorldObject, 'name' | 'description'>>;
  priest: { name: string; nature: string };
}

export interface CityIntro {
  view: string;
  priestCall: string[];
}

const prompt = loadPrompt(import.meta.url);

export const cityIntro: StructuredAgent<CityIntroInput, IntroRaw, CityIntro> = {
  name: 'city-intro',
  tool: 'submit_intro',
  description: 'Вид острова сверху для игрока и первые короткие сообщения жреца.',
  schema: introSchema,
  system: () => composeSystem(['world', 'patron', 'style-priest-voice'], prompt),
  user: ({ cityName, patronName, patronGender, brief, objects, priest }) =>
    [
      `Город «${cityName}». ${patronGender === 'female' ? 'Покровительница' : 'Покровитель'}: ${patronName}.`,
      `Верховный жрец: ${priest.name}. ${priest.nature}`,
      section('БРИФ', brief),
      section('ОБЪЕКТЫ', bullets(objects.map((o) => `${o.name}: ${o.description}`))),
      'Вызови submit_intro.',
    ].join('\n\n'),
  check: (raw) => {
    if (raw.view.length < VIEW_MIN - 50 || raw.view.length > VIEW_MAX + 150) return `view ${raw.view.length} знаков, нужно от ${VIEW_MIN} до ${VIEW_MAX}`;
    const long = raw.priest_call.find((m) => m.length > CALL_MAX);
    return long ? `сообщение жреца длиннее ${CALL_MAX} знаков: «${long.slice(0, 60)}…». Каждое — одна-две фразы.` : null;
  },
  finish: (raw) => ({ view: raw.view, priestCall: raw.priest_call }),
};

export async function writeCityIntro(deps: AgentDeps, input: CityIntroInput): Promise<CityIntro> {
  return (await runStructured(deps, cityIntro, input)).value;
}
