/**
 * Активность игрока: гистограмма часов для расписания сопряжения
 * и замер доли времени в стыке (копим, решений по доле не принимаем).
 */

export const ACTIVITY_HOURS = 24;

export function emptyActivity() {
  return {
    activeMsSolo: 0,
    activeMsDocked: 0,
    hoursUtc: Array(ACTIVITY_HOURS).fill(0),
    samples: 0,
    lastTurnAt: null,
  };
}

export function normalizeActivity(domain) {
  if (!domain || typeof domain !== 'object') return emptyActivity();
  const raw = domain.activity && typeof domain.activity === 'object' ? domain.activity : {};
  const hours = Array.isArray(raw.hoursUtc) ? raw.hoursUtc.slice(0, ACTIVITY_HOURS) : [];
  while (hours.length < ACTIVITY_HOURS) hours.push(0);
  const activity = {
    activeMsSolo: Math.max(0, Number(raw.activeMsSolo) || 0),
    activeMsDocked: Math.max(0, Number(raw.activeMsDocked) || 0),
    hoursUtc: hours.map((n) => Math.max(0, Number(n) || 0)),
    samples: Math.max(0, Math.round(Number(raw.samples) || 0)),
    lastTurnAt: raw.lastTurnAt || null,
  };
  domain.activity = activity;
  return activity;
}

/** Час 0–23 в указанной зоне. Без зоны — час сервера, как раньше. */
export function hourInTimeZone(now = new Date(), tz = null) {
  const date = now instanceof Date ? now : new Date(now);
  if (!tz) return date.getHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: String(tz),
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : date.getHours();
  } catch {
    return date.getHours();
  }
}

export function hourUtc(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return date.getUTCHours();
}

/**
 * Записать ход правителя. `docked` — город сейчас в стыке (для замера доли).
 * Хвост после хода тоже считается активным: игрок ещё читает.
 */
export function noteRulerActivity(domain, { now = Date.now(), docked = false, tailMinutes = 20 } = {}) {
  const activity = normalizeActivity(domain);
  const date = new Date(now);
  const hour = hourUtc(date);
  const minutes = Math.max(1, Math.round(Number(tailMinutes) || 20));
  activity.hoursUtc[hour] = (activity.hoursUtc[hour] || 0) + minutes;
  activity.samples += 1;
  activity.lastTurnAt = date.toISOString();
  const ms = minutes * 60 * 1000;
  if (docked) activity.activeMsDocked += ms;
  else activity.activeMsSolo += ms;
  domain.activity = activity;
  return activity;
}

export function activitySamples(domain) {
  return normalizeActivity(domain).samples;
}

/** Доля стыка по активному времени. Не используется матчмейкером — только замер. */
export function activeDockedFraction(domain) {
  const a = normalizeActivity(domain);
  const t = a.activeMsDocked + a.activeMsSolo;
  if (t <= 0) return 0;
  return a.activeMsDocked / t;
}
