/**
 * Генезис города из «рыбы» онбординга, двумя шагами одного агента:
 *   ядро   — имя, верховный жрец, первое слово, стартовые факты;
 *   аспекты — разделы подробного описания, пачками.
 * Объекты мира, сановники и бриф — отдельные агенты; порядок держит поток генезиса.
 */

import type { CitySeed, Gender, PoolName } from '../../core/city.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { namesBlock } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { type AspectDef } from './aspects.js';
import { aspectsSchema, coreSchema, type CoreRaw } from './schema.js';

export interface GenesisCore {
  cityName: string;
  priest: { name: string; gender: Gender; nature: string };
  greeting: string;
  openingLore: string[];
}

export interface GenesisCoreInput {
  seed: CitySeed;
  names: readonly PoolName[];
  /** Мировые правила сезона, если есть: город о них знает. */
  seasonRules: readonly string[];
}

export interface GenesisAspectsInput {
  seed: CitySeed;
  core: GenesisCore;
  batch: readonly AspectDef[];
  /** Уже написанные разделы: только для контекста, копировать нельзя. */
  already: Record<string, string>;
}

const prompt = loadPrompt(import.meta.url);

function system(seasonRules: readonly string[], names: readonly PoolName[] | null): string {
  return composeSystem(
    ['world', 'patron', 'style-names'],
    prompt,
    names ? namesBlock(names) : '',
    seasonRules.length ? `Что известно всему небу в эту пору:\n${seasonRules.map((r) => `- ${r}`).join('\n')}` : '',
  );
}

/** Частности генезиса поверх канона мира. */
export function cosmologyBlock(): string {
  return [
    'ИЗОЛЯЦИЯ ДЛЯ ГЕНЕЗИСА (жёстко):',
    '- Нет регулярных путей, паломничеств, караванов и «соседних регионов» на твёрдой земле.',
    '- Нет материка, соседних провинций, приезжих из других городов как бытовой нормы.',
    '- Не выдумывай чужие народы у ворот и торговлю с чужими островами.',
    '- Хозяйство, вера, праздники, торговля — внутри СВОЕГО острова (~20 км до обрыва).',
    '- «Паломничество» бывает только местным (свой храм, свой край), не с других островов.',
    '- Low-magic: магия есть, но не повсеместна. Не делай школы заклинаний и магические пропитки нормой быта.',
  ].join('\n');
}

const TOURIST = [/добро\s+пожалов/i, /пронизыва/i, /каждый\s+уголок/i, /здесь\s+вас?\s+ждут/i, /волшебство\s+прониз/i, /приятного\s+пребыв/i];
const ASKS_NAME = /как\s+(тебя|вам|нам)\s+(звать|обращ)|назов(и|ите)\s+(себя|имя)|как\s+к\s+тебе\s+обращ/i;

/** Почему приветствие не годится, или null. */
export function greetingProblem(text: string, patronName: string): string | null {
  if (TOURIST.some((re) => re.test(text))) return 'greeting: нужна речь слуги к божеству, не «добро пожаловать в город»';
  if (!text.toLowerCase().includes(patronName.toLowerCase()) || ASKS_NAME.test(text)) {
    return `greeting: обратись к «${patronName}» по имени и не проси, как звать`;
  }
  return null;
}

function seedLines(seed: CitySeed): string {
  return ['ЗАГОТОВКА ИГРОКА (не выдумывай другой город):', seed.pitch].join('\n');
}

export const genesisCore: StructuredAgent<GenesisCoreInput, CoreRaw, GenesisCore> = {
  name: 'city-genesis',
  tool: 'submit_core',
  description: 'Ядро города: имя, верховный жрец, greeting, opening_lore (8+ коротких фактов).',
  schema: coreSchema,
  system: ({ seasonRules, names }) => system(seasonRules, names),
  user: ({ seed }) => {
    const patron = seed.patronName;
    return [
      'Создай ЯДРО города. Обязательно вызови submit_core.',
      cosmologyBlock(),
      seed.cityName
        ? `Имя города УЖЕ выбрано игроком: «${seed.cityName}» — поле city_name = точно это. Это данное, не предмет космологии: не отвергай из-за звучания.`
        : 'Имя города — придуманное, кириллицей, не русское и не земное.',
      '',
      seedLines(seed),
      '',
      `opening_lore: минимум 8 коротких ПОСТОЯННЫХ фактов (не новости месяца). Не выдумывай цистерны и прочий канон «по умолчанию».`,
      'Учти изоляцию острова: без паломников/торговцев «из соседних регионов».',
      'priest_name — одно имя из списка ИМЕНА. Пол жреца задан списком: держись его.',
      '',
      `Имя покровителя УЖЕ дано: «${patron}». Храм и культ города — его. Это данное, не отвергай из-за звучания.`,
      seed.patronGender === 'female'
        ? 'Пол покровителя: женщина. Пиши «покровительница», женский род согласования.'
        : 'Пол покровителя: мужчина. Пиши «покровитель», мужской род согласования.',
      'greeting — ПЕРВАЯ РЕПЛИКА жреца к этому богу по имени:',
      `- Обратись «${patron}». Не проси, как звать: имя уже известно.`,
      '- 1–3 коротких предложения, живая речь от первого лица.',
      '- ЗАПРЕЩЕНО: «Добро пожаловать в …», реклама острова, гид по городу.',
    ].join('\n');
  },
  check: (raw, { seed, names }) => {
    if (seed.cityName && raw.city_name !== seed.cityName) return `city_name должно быть ровно «${seed.cityName}»`;
    if (names.length && !names.some((n) => n.name === raw.priest_name)) return `имени ${raw.priest_name} нет в списке ИМЕНА`;
    return greetingProblem(raw.greeting, seed.patronName);
  },
  finish: (raw, { names }) => ({
    cityName: raw.city_name,
    priest: { name: raw.priest_name, gender: names.find((n) => n.name === raw.priest_name)?.gender ?? 'male', nature: raw.priest_description },
    greeting: raw.greeting,
    openingLore: raw.opening_lore,
  }),
};

export function genesisAspects(batch: readonly AspectDef[]): StructuredAgent<GenesisAspectsInput, Record<string, string>, Record<string, string>> {
  return {
    name: 'city-genesis',
    tool: 'submit_aspects',
    description: 'Заполнить очередную пачку аспектов описания города.',
    schema: aspectsSchema(batch),
    system: () => system([], null),
    user: ({ seed, core, already }) => {
      const known = Object.entries(already)
        .slice(0, 3)
        .map(([id, text]) => `### уже есть ${id}\n${text.slice(0, 200)}…`)
        .join('\n');
      return [
        `Город «${core.cityName}», верховный жрец ${core.priest.name}.`,
        cosmologyBlock(),
        '',
        'ЗАГОТОВКА ИГРОКА (не выдумывай другой город, не добавляй эльфов/школу магии/аэропорт, если игрок их не просил):',
        seed.pitch,
        '',
        known ? `Контекст уже написанных разделов (не копируй):\n${known}` : '',
        '',
        'Заполни ТОЛЬКО эти аспекты через submit_aspects. Каждый уникален и конкретен.',
        'Пиши устойчивый лор (годы), не сиюминутные события — те для хроники.',
        'Изоляция острова: без регулярных гостей с чужих островов и «соседних земель».',
        'Не пиши статы, офицеров и сановников власти — только жизнь города.',
        batch.map((b) => `- ${b.id} «${b.title}»: ${b.hint}`).join('\n'),
      ].join('\n');
    },
    check: (raw) => {
      const norms = batch.map((d) => (raw[d.id] ?? '').replace(/\s+/g, ' ').slice(0, 120));
      return norms.some((t, i) => t && norms.indexOf(t) !== i) ? 'разделы повторяют друг друга: перепиши без копипаста' : null;
    },
    finish: (raw) => raw,
  };
}

export async function writeGenesisCore(deps: AgentDeps, input: GenesisCoreInput): Promise<GenesisCore> {
  return (await runStructured(deps, genesisCore, input)).value;
}

export async function writeGenesisAspects(deps: AgentDeps, input: GenesisAspectsInput): Promise<Record<string, string>> {
  return (await runStructured(deps, genesisAspects(input.batch), input)).value;
}
