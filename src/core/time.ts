/**
 * Игровое время. Непрерывное, без тиков:
 *
 *   игровой год = 360 игровых дней = realHoursPerYear реальных часов (по умолчанию 24)
 *   игровой месяц = 30 дней
 *
 * День считается от якоря мира (epochMs) и реального момента. Остановка часов
 * (dev-клиент) копится в pausedMs и вычитается.
 */

import type { Rules } from './rules.js';

export const DAYS_PER_YEAR = 360;
export const DAYS_PER_MONTH = 30;

export function msPerGameDay(rules: Pick<Rules, 'time'>): number {
  return (rules.time.realHoursPerYear * 60 * 60 * 1000) / DAYS_PER_YEAR;
}

export function gameDaysToMs(days: number, rules: Pick<Rules, 'time'>): number {
  return Math.round(days * msPerGameDay(rules));
}

export interface ClockState {
  /** Реальный момент, когда шёл день 0. */
  epochMs: number;
  /** Сколько реального времени часы стояли (накоплено). */
  pausedMs: number;
  /** Если часы сейчас стоят — с какого момента. */
  heldAtMs: number | null;
}

export function newClock(nowMs: number): ClockState {
  return { epochMs: nowMs, pausedMs: 0, heldAtMs: null };
}

function pausedTotal(clock: ClockState, nowMs: number): number {
  const held = clock.heldAtMs == null ? 0 : Math.max(0, nowMs - clock.heldAtMs);
  return Math.max(0, clock.pausedMs) + held;
}

/** Текущий игровой день (целый, с нуля). */
export function dayAt(clock: ClockState, nowMs: number, rules: Pick<Rules, 'time'>): number {
  const elapsed = Math.max(0, nowMs - clock.epochMs - pausedTotal(clock, nowMs));
  return Math.floor(elapsed / msPerGameDay(rules));
}

/** Реальный момент, когда наступит игровой день `day`. */
export function realMsOfDay(clock: ClockState, day: number, nowMs: number, rules: Pick<Rules, 'time'>): number {
  return clock.epochMs + pausedTotal(clock, nowMs) + Math.round(day * msPerGameDay(rules));
}

export function holdClock(clock: ClockState, nowMs: number): ClockState {
  if (clock.heldAtMs != null) return clock;
  return { ...clock, heldAtMs: nowMs };
}

export function releaseClock(clock: ClockState, nowMs: number): ClockState {
  if (clock.heldAtMs == null) return clock;
  return { ...clock, pausedMs: clock.pausedMs + Math.max(0, nowMs - clock.heldAtMs), heldAtMs: null };
}

/** Промотать часы вперёд: якорь уезжает назад, всё остальное узнаёт о скачке само. */
export function skipDays(clock: ClockState, days: number, rules: Pick<Rules, 'time'>): ClockState {
  const jump = Math.max(0, Math.round(days));
  return { ...clock, epochMs: clock.epochMs - gameDaysToMs(jump, rules) };
}

export interface GameDate {
  year: number;
  month: number;
  day: number;
  dayIndex: number;
  label: string;
}

export function gameDate(dayIndex: number): GameDate {
  const d = Math.max(0, Math.round(dayIndex));
  const year = Math.floor(d / DAYS_PER_YEAR) + 1;
  const dayOfYear = d % DAYS_PER_YEAR;
  const month = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
  const day = (dayOfYear % DAYS_PER_MONTH) + 1;
  return { year, month, day, dayIndex: d, label: `Год ${year}, месяц ${month}, день ${day}` };
}

/** Сколько реального времени ждать — то, что видит игрок рядом с игровым сроком. */
export function realWaitLabel(days: number, rules: Pick<Rules, 'time'>): string {
  const d = Math.max(0, days);
  if (!d) return 'вот-вот';
  const minutes = gameDaysToMs(d, rules) / 60000;
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 90) return `~${Math.round(minutes)} мин`;
  const hours = minutes / 60;
  if (hours < 24) {
    const rounded = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
    return `~${String(rounded).replace('.', ',')} ч`;
  }
  const realDays = Math.round((hours / 24) * 10) / 10;
  return `~${String(realDays).replace('.', ',')} сут`;
}

/**
 * Словесная полоса промежутка — то, что видит агент вместо числа дней.
 * Агенты не считают дни.
 */
export function spanBand(days: number): string {
  const d = Math.max(0, days);
  if (d <= 3) return 'считанные дни';
  if (d <= 18) return 'дни';
  if (d <= 65) return 'недели';
  if (d <= 160) return 'сезон';
  if (d <= 400) return 'год';
  return 'годы';
}
