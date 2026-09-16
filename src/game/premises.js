/**
 * Скрытый слой нити: что в истории правда, но город этого ещё не знает.
 *
 * Слой двухэтажный, и этажи работают по-разному.
 *
 * `hiddenAnswer` — сама разгадка, одна на историю. Её нельзя взять одним
 * дешёвым делом: сердцевина открывается, только когда город уже вложился —
 * либо исчерпал все подступы, либо набрал большую часть глубины, либо блестяще
 * сработал.
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

function normalizeSpace(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Доля maxDepth, после которой расследование способно сложить картину. */
export const ANSWER_DEPTH_SHARE = 0.6;
export const HIDDEN_PREMISE_MAX = 6;

export function normalizeHiddenPremises(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = normalizeSpace(typeof item === 'string' ? item : item?.text || item?.premise || '');
    if (text.length < 8) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= HIDDEN_PREMISE_MAX) break;
  }
  return out;
}

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
 * Считается от maxDepth, поэтому масштаб истории учтён сам: короткая ситуация
 * всё равно требует нескольких дел, разрыв держит секрет почти до конца.
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

function foldSpeech(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function speechWords(text, min) {
  return foldSpeech(text)
    .split(' ')
    .filter((w) => w.length >= min);
}

/**
 * Речь выдаёт ещё скрытую причину: уникальные длинные слова разгадки
 * проступили вслух, даже как «мы про это ничего не знаем».
 */
export function speechHintsHidden(plot, speech, { alreadySaid = '' } = {}) {
  const secret = [hiddenAnswer(plot), ...hiddenPremises(plot)].filter(Boolean).join(' ');
  if (!foldSpeech(secret)) return false;
  const pub = [plot?.synopsis, plot?.title, revealedAnswer(plot), ...revealedPremises(plot)].join(' ');
  const publicStems = new Set(speechWords(pub, 5).map((w) => w.slice(0, 6)));
  const allowed = new Set(speechWords(alreadySaid, 5).map((w) => w.slice(0, 6)));
  const said = foldSpeech(speech);
  if (!said) return false;
  for (const w of speechWords(secret, 8)) {
    const stem = w.slice(0, 6);
    if (publicStems.has(stem) || allowed.has(stem)) continue;
    if (said.includes(stem)) return true;
  }
  return false;
}
