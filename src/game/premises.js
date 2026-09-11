/**
 * Скрытый слой нити: что в истории правда, но город этого ещё не знает.
 *
 * Слой двухэтажный, и этажи работают по-разному.
 *
 * `hiddenAnswer` — сама разгадка, одна на историю. Её нельзя взять одним
 * дешёвым делом: сердцевина открывается, только когда город уже вложился —
 * либо исчерпал все подступы, либо набрал глубину, либо блестяще сработал.
 *
 * `hiddenPremises` — подступы к ней: улики, люди, которые знают, старые
 * записи, причина, по которой до сих пор не поняли. Они независимы друг от
 * друга и не образуют очереди: игрок подходит с той стороны, с какой придумал,
 * а какой подступ вскрыло дело, решает судья по смыслу поручения.
 *
 * Раскрытое переезжает в `revealedPremises` / `revealedAnswer` и с этой минуты
 * живёт по другим правилам: его можно писать в хронику и произносить вслух.
 * Поэтому все промпты, которые получают скрытое с пометкой «не писать»,
 * остаются верны без единой правки, а знание города не приходится собирать
 * по индексам.
 */

import { normalizeHiddenPremises } from './suspenseGraph.js';

/** Доля maxDepth, после которой расследование способно сложить картину. */
export const ANSWER_DEPTH_SHARE = 0.25;

export function normalizeRevealedPremises(raw) {
  return normalizeHiddenPremises(raw);
}

export function hiddenPremises(plot) {
  return Array.isArray(plot?.hiddenPremises) ? plot.hiddenPremises : [];
}

export function revealedPremises(plot) {
  return Array.isArray(plot?.revealedPremises) ? plot.revealedPremises : [];
}

export function hiddenAnswer(plot) {
  return String(plot?.hiddenAnswer || '').trim();
}

export function revealedAnswer(plot) {
  return String(plot?.revealedAnswer || '').trim();
}

/**
 * Целевая глубина, на которой сердцевина становится досягаемой.
 * Считается от maxDepth, поэтому масштаб истории учтён сам: мелкая ситуация
 * отдаёт секрет со второго дела, разрыв держит его до серьёзных вложений.
 */
export function answerDepthTarget(plot) {
  const max = Number(plot?.maxDepth);
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.round(max * ANSWER_DEPTH_SHARE * 100) / 100;
}

/**
 * Открыта ли сердцевина. Любого из трёх условий достаточно:
 * подступы исчерпаны, работа набрана, или дело сделано блестяще.
 */
export function answerOpen(plot, { finish = 'ok' } = {}) {
  if (!hiddenAnswer(plot)) return false;
  if (!hiddenPremises(plot).length) return true;
  if (finish === 'crit') return true;
  return (Number(plot?.depth) || 0) >= answerDepthTarget(plot);
}

/**
 * Текст подступа, на который указал судья.
 *
 * Судья видит текущий список неизвестного, поэтому нумерация совпадает сама.
 * Мусор и выход за границы — не раскрытие: это значит, что дело работает по
 * сути, но ничего не выясняет, и так бывает у большинства дел.
 */
export function premiseAtIndex(plot, raw) {
  if (raw == null || raw === '') return null;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < 0) return null;
  return hiddenPremises(plot)[n] || null;
}

function sameText(a, b) {
  return String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();
}

/**
 * Перенести подступ из скрытого в известное. Возвращает текст раскрытого или
 * `null`, если раскрывать было нечего.
 *
 * Ищем по тексту, а не по номеру: между вердиктом судьи и концом работы список
 * мог сдвинуться — другое дело вскрыло соседний подступ.
 */
export function revealPremise(plot, text) {
  if (!plot || !text) return null;
  const list = hiddenPremises(plot);
  const i = list.findIndex((item) => sameText(item, text));
  if (i < 0) return null;
  const [found] = plot.hiddenPremises.splice(i, 1);
  if (!Array.isArray(plot.revealedPremises)) plot.revealedPremises = [];
  plot.revealedPremises.push(found);
  return found;
}

/** Раскрыть саму разгадку. Проверку условий делает вызывающий. */
export function revealAnswer(plot) {
  const text = hiddenAnswer(plot);
  if (!text) return null;
  plot.hiddenAnswer = '';
  plot.revealedAnswer = text;
  return text;
}
