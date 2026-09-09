/**
 * Наказы жрецу: «докладывай раз в месяц, как идут дела в порту».
 *
 * Это отдельная сущность, а не заметка в памяти жреца: заметка становится
 * подсказкой, которую модель то вспомнит, то нет, а игрок ждал механики.
 *
 * Мир наказом не меняется — это только доклад. Фактов может не быть; тогда
 * жрец идёт к лормастеру, тот выдумывает один раз и записывает как факт.
 */

import { DAYS_PER_MONTH, DAYS_PER_YEAR } from './gameClock.js';

export const REPORT_CADENCES = ['месяц', 'сезон', 'год'];

export const CADENCE_DAYS = {
  'месяц': DAYS_PER_MONTH,
  'сезон': DAYS_PER_MONTH * 3,
  'год': DAYS_PER_YEAR,
};

/** Больше трёх наказов — это уже поток докладов вместо игры. */
export const MAX_PRIEST_ORDERS = 3;

export function parseCadence(raw, fallback = 'месяц') {
  const key = String(raw || '').trim().toLowerCase();
  return REPORT_CADENCES.includes(key) ? key : fallback;
}

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

export function addPriestOrder(domain, { subject, cadence = 'месяц', day = 0 } = {}) {
  const list = priestOrders(domain);
  const text = String(subject || '').trim().slice(0, 200);
  if (!text) return { ok: false, error: 'empty_subject' };
  if (list.length >= MAX_PRIEST_ORDERS) return { ok: false, error: 'too_many', limit: MAX_PRIEST_ORDERS };
  const cad = parseCadence(cadence);
  const everyDays = CADENCE_DAYS[cad];
  const order = {
    id: nextOrderId(),
    subject: text,
    cadence: cad,
    everyDays,
    nextDay: Math.round(Number(day) || 0) + everyDays,
    lastDay: null,
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

export function dueReports(domain, day) {
  const d = Math.round(Number(day) || 0);
  return priestOrders(domain).filter((o) => Number(o.nextDay) <= d);
}

export function markReported(order, day) {
  if (!order) return order;
  const d = Math.round(Number(day) || 0);
  order.lastDay = d;
  order.nextDay = d + Math.max(DAYS_PER_MONTH, Math.round(Number(order.everyDays) || DAYS_PER_MONTH));
  return order;
}

export function formatPriestOrders(domain) {
  const list = priestOrders(domain);
  if (!list.length) return '';
  return list.map((o) => `- ${o.subject} (раз в ${o.cadence})`).join('\n');
}
