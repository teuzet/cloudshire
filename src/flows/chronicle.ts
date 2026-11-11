/**
 * Запись случившегося: хроника (сухой факт пером хрониста) и весть жреца покровителю.
 */

import type { ChronicleEntry, City, Officer } from '../core/city.js';
import { appendChronicle, appendDialog } from '../core/chronicle.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { writeChronicle } from '../agents/front-chronicle/run.js';
import { writeNews } from '../agents/herald/run.js';
import { namesUsed, newId, returnNames, takeNames, tryAgent, type FlowDeps } from './context.js';

export interface Happening {
  fact: string;
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
  const names = await takeNames(deps, deps.rules.seeding.namesPerCall);
  const text = await tryAgent(
    deps,
    'front-chronicle',
    () => writeChronicle(deps.agents, { cityName: city.name, fact: h.fact, history, names }),
    h.fact,
  );
  const used = namesUsed(names, text);
  await returnNames(deps, names.filter((n) => !used.includes(n)));

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
