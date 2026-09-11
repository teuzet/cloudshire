/**
 * Скрытые посылки нити: что в истории правда, но город этого ещё не знает.
 *
 * `hiddenPremises` — всегда только неизвестное городу. Раскрытая посылка
 * переезжает в `revealedPremises` и с этой минуты живёт по другим правилам:
 * её можно писать в хронику и произносить вслух. Поэтому все промпты, которые
 * получают `hiddenPremises` с пометкой «в хронику не писать», остаются верны
 * без единой правки, а знание города не приходится собирать по индексам.
 */

import { normalizeHiddenPremises } from './suspenseGraph.js';

export function normalizeRevealedPremises(raw) {
  return normalizeHiddenPremises(raw);
}

export function hiddenPremises(plot) {
  return Array.isArray(plot?.hiddenPremises) ? plot.hiddenPremises : [];
}

export function revealedPremises(plot) {
  return Array.isArray(plot?.revealedPremises) ? plot.revealedPremises : [];
}

/**
 * Текст посылки, на которую указал судья.
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
 * Перенести посылку из скрытого в известное. Возвращает текст раскрытого или
 * `null`, если раскрывать было нечего.
 *
 * Ищем по тексту, а не по номеру: между вердиктом судьи и концом работы список
 * мог сдвинуться — другое дело раскрыло соседнюю посылку.
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

/** Следующее по порядку неизвестное — для крита, которому посылку не называли. */
export function revealNextPremise(plot) {
  return revealPremise(plot, hiddenPremises(plot)[0]);
}
