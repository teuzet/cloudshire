/**
 * Запись случившегося. Код собирает перемены события («дифф»), Летописец оформляет их в запись
 * хроники, Вестник делает из записи весть покровителю. Веха без перемен идёт в хронику словами
 * Агента битов: писать по пустому списку Летописцу нечего.
 */

import type { ChronicleEntry, City, Officer } from '../core/city.js';
import { appendChronicle, appendDialog } from '../core/chronicle.js';
import { clipWords } from '../core/text.js';
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

/**
 * Память объектов: запись хроники ложится короткой строкой в лог каждого объекта, с которым
 * что-то случилось. Хроника остаётся про события; лог нужен, чтобы жрец знал, что было с вещью.
 */
function remember(deps: FlowDeps, city: City, changes: readonly Change[], text: string, day: number): void {
  const line = clipWords(text, 220);
  const ids = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'object_created' && (c.temporary || c.hidden)) continue;
    if (c.kind === 'object_created' || c.kind === 'object_changed' || c.kind === 'object_out' || c.kind === 'object_back' || c.kind === 'object_removed' || c.kind === 'object_revealed') ids.add(c.objectId);
  }
  for (const id of ids) {
    const obj = city.objects.find((o) => o.id === id);
    if (!obj) continue;
    const log = (obj.log ??= []);
    log.push({ day, text: line });
    if (log.length > deps.rules.fronts.objects.logMax) log.splice(0, log.length - deps.rules.fronts.objects.logMax);
  }
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
  remember(deps, city, h.changes, text, h.day);
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
