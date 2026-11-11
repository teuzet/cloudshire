/**
 * Глашатай: жрец пишет покровителю весть об одном случившемся.
 * Тот же голос, что в разговоре, но без тулов и без новых заметок.
 */

import type { ChronicleEntry, City, Officer } from '../../core/city.js';
import { gameDate } from '../../core/time.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, chronicleBlock, officerLine, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { newsSchema, type NewsRaw } from './schema.js';


export interface HeraldInput {
  city: Pick<City, 'name' | 'patronName' | 'priest' | 'notes' | 'brief'>;
  entry: ChronicleEntry;
  /** Развязка — последнее слово об истории. */
  kind: 'beat' | 'resolution';
  /** Кто довёл работу, если довёл сановник. */
  officer: Officer | null;
  history: ChronicleEntry[];
  day: number;
}

const prompt = loadPrompt(import.meta.url);

export const herald: StructuredAgent<HeraldInput, NewsRaw, string> = {
  name: 'herald',
  tool: 'submit_news',
  description: 'Весть покровителю.',
  schema: newsSchema,
  system: ({ city, history, day }) =>
    composeSystem(
      ['safety', 'world', 'patron', 'priest', 'time', 'foreign', 'style-priest-voice'],
      prompt,
      `Город: ${city.name}. Покровитель: ${city.patronName}. Сегодня: ${gameDate(day).label}.`,
      `Ты: ${city.priest.name} (${city.priest.gender === 'female' ? 'она' : 'он'}), ${city.priest.nature}`,
      section('Память', bullets(city.notes.map((n) => n.text))),
      section('Прошлое этой истории', chronicleBlock(history)),
    ),
  user: ({ entry, kind, officer }) =>
    [
      `Повод: ${kind === 'resolution' ? 'развязка' : 'событие'}`,
      officer ? `Работу вёл: ${officerLine(officer)}` : '',
      `Запись летописи:\n${entry.text}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  finish: (raw) => raw.text,
};

export async function writeNews(deps: AgentDeps, input: HeraldInput): Promise<string> {
  return (await runStructured(deps, herald, input)).value;
}
