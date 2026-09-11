/**
 * Стенные часы сервера — только для nextTickAt админского force_tick.
 * Игровой календарь считается в gameClock от якоря запуска мира.
 */

import { syncWorldClock } from './gameClock.js';

export function tickIntervalHours(config) {
  const hours = Number(config?.tick?.intervalHours);
  return Number.isFinite(hours) && hours > 0 ? hours : 2;
}

export function tickIntervalMs(config) {
  return tickIntervalHours(config) * 60 * 60 * 1000;
}

export function localDayStartMs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Сколько двухчасовых слотов прошло с полуночи этого дня. */
export function clockTickIndex(now = Date.now(), config) {
  const elapsed = Math.max(0, Number(now) - localDayStartMs(now));
  return Math.floor(elapsed / tickIntervalMs(config));
}

export function gameDateFromTickIndex(tick) {
  const t = Math.max(0, Math.round(Number(tick) || 0));
  const year = Math.floor(t / 12) + 1;
  const month = (t % 12) + 1;
  return {
    year,
    month,
    label: `Год ${year}, месяц ${month}`,
    tick: t,
  };
}

export function worldDateLabel(world) {
  const y = Number(world?.gameDate?.year);
  const m = Number(world?.gameDate?.month);
  if (Number.isInteger(y) && y > 0 && Number.isInteger(m) && m >= 1 && m <= 12) {
    return `Год ${y}, месяц ${m}`;
  }
  const label = String(world?.gameDate?.label || '').trim();
  if (label) return label;
  return gameDateFromTickIndex(world?.tickIndex ?? 0).label;
}

export function genesisDateMessage(world) {
  return `Сейчас в мире — ${worldDateLabel(world)}.`;
}

/** Следующая граница интервала строго после now (14:00:00 → 16:00). */
export function nextAlignedTickAt(now = Date.now(), config) {
  const intervalH = tickIntervalHours(config);
  const d = new Date(now);
  const hour = d.getHours();
  const onBoundary =
    hour % intervalH === 0 &&
    d.getMinutes() === 0 &&
    d.getSeconds() === 0 &&
    d.getMilliseconds() === 0;
  const addHours = onBoundary ? intervalH : intervalH - (hour % intervalH);
  const out = new Date(d);
  out.setMilliseconds(0);
  out.setSeconds(0);
  out.setMinutes(0);
  out.setHours(hour + addHours);
  return out.toISOString();
}

/** Календарь нового мира: якорь = момент запуска, год 1 день 1. */
export function applyClockAlignedCalendar(world, config, now = Date.now()) {
  const epochAt = new Date(now).toISOString();
  world.epochAt = epochAt;
  world.dayIndex = 0;
  world.scheduler = {
    ...(world.scheduler || {}),
    epochAt,
    lastTickAt: null,
    nextTickAt: nextAlignedTickAt(now, config),
    tickInProgress: false,
    tickStartedAt: null,
  };
  syncWorldClock(world, { now, config });
  return world;
}
