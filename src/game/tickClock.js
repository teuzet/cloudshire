/**
 * Тики по стенным часам сервера, не «через N часов после прошлого».
 * 00:00 дня старта/wipe = год 1, месяц 1; в 02:00 — год 1, месяц 2 (при intervalHours=2).
 */

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

/** Календарь и nextTickAt нового мира (старт сервера / wipeAll). */
export function applyClockAlignedCalendar(world, config, now = Date.now()) {
  const tick = clockTickIndex(now, config);
  world.tickIndex = tick;
  world.gameDate = gameDateFromTickIndex(tick);
  world.scheduler = {
    ...(world.scheduler || {}),
    epochAt: new Date(localDayStartMs(now)).toISOString(),
    lastTickAt: null,
    nextTickAt: nextAlignedTickAt(now, config),
    tickInProgress: false,
    tickStartedAt: null,
  };
  return world;
}
