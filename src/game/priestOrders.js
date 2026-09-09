/**
 * Наказы жрецу: «рассказывай, как идут дела в порту».
 *
 * Это отдельная сущность, а не заметка в памяти жреца: заметка становится
 * подсказкой, которую модель то вспомнит, то нет, а игрок ждал механики.
 *
 * Расписания у наказа нет. Расписание пришлось бы угадывать — раз в месяц
 * окажется то спамом, то забвением, — а промахи расписания игрок читает как
 * поломку. Поэтому доклад едет попутно с ближайшим событием: всё равно
 * жрец в этот момент пишет письмо. Разрежает не время, а счётчик событий:
 * между двумя упоминаниями одной темы должны пройти другие события.
 *
 * Мир наказом не меняется — это только доклад. Фактов может не быть; тогда
 * жрец идёт к лормастеру, тот выдумывает один раз и записывает как факт.
 */

/** Больше трёх наказов — это уже поток докладов вместо игры. */
export const MAX_PRIEST_ORDERS = 3;

/** Сколько чужих событий должно пройти, прежде чем тему поднимут снова. */
export const REPORT_EVENT_GAP = 3;

const SUBJECT_MAX = 200;
const STOP_WORDS = new Set([
  'как',
  'что',
  'где',
  'дела',
  'идут',
  'про',
  'обо',
  'об',
  'о',
  'в',
  'на',
  'у',
  'и',
  'мне',
  'ли',
  'там',
  'всё',
  'все',
]);

let orderCounter = 0;

function nextOrderId() {
  orderCounter += 1;
  return `rep_${Date.now().toString(36)}_${orderCounter}`;
}

export function priestOrders(domain) {
  if (!domain.state) domain.state = {};
  if (!Array.isArray(domain.state.priestOrders)) domain.state.priestOrders = [];
  return domain.state.priestOrders;
}

/** Сквозной номер события домена: им, а не днями, разрежаются доклады. */
export function eventNo(domain) {
  if (!domain.state) domain.state = {};
  const raw = Number(domain.state.eventNo);
  domain.state.eventNo = Number.isFinite(raw) ? Math.round(raw) : 0;
  return domain.state.eventNo;
}

export function countEvent(domain) {
  const next = eventNo(domain) + 1;
  domain.state.eventNo = next;
  return next;
}

export function addPriestOrder(domain, { subject, day = 0 } = {}) {
  const list = priestOrders(domain);
  const text = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX);
  if (!text) return { ok: false, error: 'empty_subject' };
  if (list.length >= MAX_PRIEST_ORDERS) return { ok: false, error: 'too_many', limit: MAX_PRIEST_ORDERS };
  const dup = list.find((o) => o.subject.toLowerCase() === text.toLowerCase());
  if (dup) return { ok: false, error: 'duplicate', order: dup };
  const order = {
    id: nextOrderId(),
    subject: text,
    sinceDay: Math.round(Number(day) || 0),
    lastDay: null,
    // До первого доклада тема свежая: её можно поднять на первом же событии.
    lastEventNo: null,
    times: 0,
  };
  list.push(order);
  return { ok: true, order };
}

export function removePriestOrder(domain, orderId) {
  const list = priestOrders(domain);
  const i = list.findIndex((o) => o.id === orderId);
  if (i < 0) return { ok: false, error: 'not_found' };
  const [removed] = list.splice(i, 1);
  return { ok: true, order: removed };
}

export function findPriestOrder(domain, { orderId = null, subject = '' } = {}) {
  const list = priestOrders(domain);
  if (orderId) {
    const byId = list.find((o) => o.id === String(orderId));
    if (byId) return byId;
  }
  const needle = String(subject || '').trim().toLowerCase();
  if (!needle) return null;
  return (
    list.find((o) => o.subject.toLowerCase() === needle) ||
    list.find((o) => o.subject.toLowerCase().includes(needle) || needle.includes(o.subject.toLowerCase())) ||
    null
  );
}

function keywords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/** Событие само задело тему наказа — тогда доклад идёт к делу, а не сбоку. */
export function orderTouchedBy(order, texts = []) {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  if (!hay) return false;
  return keywords(order?.subject).some((w) => hay.includes(w));
}

export function reportGap(domain, order) {
  const raw = order?.lastEventNo;
  // О теме ещё не говорили — она бесконечно «забыта» и берётся первой.
  if (raw == null) return Infinity;
  const last = Number(raw);
  if (!Number.isFinite(last)) return Infinity;
  return eventNo(domain) - last;
}

/**
 * Какой наказ подхватить к этому событию. Не больше одного: два доклада в
 * одном письме — это уже сводка, а от сводок мы и уходили.
 *
 * Задетая событием тема идёт первой: жрецу есть что сказать по поводу.
 * Иначе берём самую забытую — ту, о которой не говорили дольше всех.
 */
export function pickReportSubject(domain, { texts = [], gap = REPORT_EVENT_GAP } = {}) {
  const eligible = priestOrders(domain).filter((o) => reportGap(domain, o) >= gap);
  if (!eligible.length) return null;
  const touched = eligible.filter((o) => orderTouchedBy(o, texts));
  const pool = touched.length ? touched : eligible;
  return pool.reduce((a, b) => (reportGap(domain, a) >= reportGap(domain, b) ? a : b));
}

export function markReported(domain, order, { day = 0 } = {}) {
  if (!order) return order;
  order.lastDay = Math.round(Number(day) || 0);
  order.lastEventNo = eventNo(domain);
  order.times = Math.max(0, Math.round(Number(order.times) || 0)) + 1;
  return order;
}

export function formatPriestOrders(domain) {
  const list = priestOrders(domain);
  if (!list.length) return '';
  return list.map((o) => `- ${o.subject}`).join('\n');
}
