/**
 * Запись случившегося. Код собирает перемены события («дифф»), Летописец оформляет их в запись
 * хроники, Вестник делает из записи весть покровителю. Веха без перемен идёт в хронику словами
 * Агента битов: писать по пустому списку Летописцу нечего.
 */

import type { ChronicleEntry, City, Officer } from '../core/city.js';
import { appendChronicle, appendDialog } from '../core/chronicle.js';
import { describeChanges, isNotable, type Change } from '../core/world/changes.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { writeChronicleEntry } from '../agents/chronicler/run.js';
import { writeNews } from '../agents/herald/run.js';
import { newId, tryAgent, type FlowDeps } from './context.js';

export interface Happening {
  /** Суть события: слова Агента битов, Развязчика, Костюмера или кода. */
  gist: string;
  changes: Change[];
  source: ChronicleEntry['source'];
  frontId: string | null;
  day: number;
  /** resolution — история кончилась; beat — очередной поворот. */
  kind: 'beat' | 'resolution';
  officer: Officer | null;
  /** Слать ли весть. Тихие записи остаются только в хронике. */
  announce: boolean;
}

function storyHistory(city: City, frontId: string | null): ChronicleEntry[] {
  return frontId ? city.chronicle.filter((e) => e.frontId === frontId).slice(-5) : city.chronicle.slice(-3);
}

/** Записать случившееся и, если надо, вернуть весть для отправки после сохранения. */
export async function record(deps: FlowDeps, city: City, h: Happening): Promise<OutboundMessage | null> {
  const history = storyHistory(city, h.frontId);
  const lines = isNotable(h.changes) ? describeChanges(deps.rules, h.changes) : [];
  const text = lines.length
    ? await tryAgent(
        deps,
        'chronicler',
        () => writeChronicleEntry(deps.agents, { gist: h.gist, changes: lines }),
        [h.gist, ...lines].join(' '),
      )
    : h.gist;

  const entry = appendChronicle(city, { id: newId(deps, 'chr'), day: h.day, text, source: h.source, frontId: h.frontId });
  if (!h.announce) return null;

  const news = await tryAgent(
    deps,
    'herald',
    () => writeNews(deps.agents, { city, entry, kind: h.kind, officer: h.officer, history, day: h.day }),
    null,
  );
  if (!news) return null;
  appendDialog(city, { role: 'priest', text: news, day: h.day, kind: 'news' });
  return { ownerId: city.ownerId, text: news, kind: 'news', cityId: city.id };
}
