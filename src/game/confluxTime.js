/**
 * Сроки сопряжения в игровых днях и выбор окна по часам игроков.
 */

import { realMsToGameDays, realWaitLabel } from './gameClock.js';
import { hourInTimeZone, normalizeActivity } from './activity.js';

export function confluxConfig(config) {
  const raw = config?.tick?.conflux || {};
  const minAgeMonths = Number(raw.minDomainAgeMonths);
  return {
    enabled: raw.enabled !== false,
    cadenceHours: Math.max(1, Number(raw.cadenceHours ?? 48)),
    cadenceJitterHours: Math.max(0, Number(raw.cadenceJitterHours ?? 6)),
    scheduleSlackHours: Math.max(0, Number(raw.scheduleSlackHours ?? 12)),
    prepHours: Math.max(1, Number(raw.prepHours ?? 6)),
    dockHours: Math.max(1, Number(raw.dockHours ?? 6)),
    activitySamplesMin: Math.max(0, Math.round(Number(raw.activitySamplesMin ?? 10))),
    activityTailMinutes: Math.max(1, Math.round(Number(raw.activityTailMinutes ?? 20))),
    minDomainAgeDays: Math.max(
      0,
      Math.round(Number(raw.minDomainAgeDays ?? (Number.isFinite(minAgeMonths) ? minAgeMonths * 30 : 180))),
    ),
    genesisBanHours: Math.max(0, Number(raw.genesisBanHours ?? 4)),
    preferNeverMet: raw.preferNeverMet !== false,
    maxNewPairsPerDay: Math.max(0, Math.round(Number(raw.maxNewPairsPerDay ?? raw.maxNewPairsPerTick ?? 2))),
    crossIslandSpeedup: Math.max(1, Number(raw.crossIslandSpeedup ?? 2)),
    contactSeedAtFraction: Math.min(0.9, Math.max(0.05, Number(raw.contactSeedAtFraction ?? 0.05))),
    prepDaysMin: Math.max(1, Math.round(Number(raw.prepDaysMin ?? (raw.etaMonths?.min ?? 1) * 30))),
    prepDaysMax: Math.max(
      Math.max(1, Math.round(Number(raw.prepDaysMin ?? (raw.etaMonths?.min ?? 1) * 30))),
      Math.round(Number(raw.prepDaysMax ?? (raw.etaMonths?.max ?? 3) * 30)),
    ),
    dockDaysMin: Math.max(1, Math.round(Number(raw.dockDaysMin ?? (raw.durationMonths?.min ?? 3) * 30))),
    dockDaysMax: Math.max(
      Math.max(1, Math.round(Number(raw.dockDaysMin ?? (raw.durationMonths?.min ?? 3) * 30))),
      Math.round(Number(raw.dockDaysMax ?? (raw.durationMonths?.max ?? 6) * 30)),
    ),
    contactWeights: raw.contactWeights && typeof raw.contactWeights === 'object' ? raw.contactWeights : {},
    quietSilenceDays: Math.max(1, Math.round(Number(raw.quietSilenceDays ?? 21))),
    quietChance: Math.max(0, Math.min(1, Number(raw.quietChance ?? 0.4))),
    quietCooldownDays: Math.max(1, Math.round(Number(raw.quietCooldownDays ?? 21))),
  };
}

export function rollInclusiveDays(min, max, rng = Math.random) {
  const lo = Math.min(Math.round(Number(min) || 1), Math.round(Number(max) || 1));
  const hi = Math.max(Math.round(Number(min) || 1), Math.round(Number(max) || 1));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function rollConfluxSpan(config, rng = Math.random) {
  const cfg = confluxConfig(config);
  return {
    prepDays: rollInclusiveDays(cfg.prepDaysMin, cfg.prepDaysMax, rng),
    dockDays: rollInclusiveDays(cfg.dockDaysMin, cfg.dockDaysMax, rng),
  };
}

export function hoursToGameDays(hours, config) {
  const h = Number(hours) || 0;
  if (h <= 0) return 0;
  return Math.max(1, Math.round(realMsToGameDays(h * 3600 * 1000, config)));
}

export function daysUntilDock(conflux, day) {
  if (conflux?.dockStartDay == null) return 0;
  return Math.max(0, Math.round(Number(conflux.dockStartDay)) - Math.round(Number(day) || 0));
}

export function daysUntilUndock(conflux, day) {
  if (conflux?.dockEndDay == null) return 0;
  return Math.max(0, Math.round(Number(conflux.dockEndDay)) - Math.round(Number(day) || 0));
}

export function remainingDockDays(conflux, day) {
  return daysUntilUndock(conflux, day);
}

/** Сколько дней до ближайшего события пары: стык или расхождение. */
export function pairRemainingDays(conflux, day) {
  if (!conflux) return null;
  if (conflux.status === 'docked') return daysUntilUndock(conflux, day);
  if (conflux.status === 'approaching') return daysUntilDock(conflux, day);
  return null;
}

export function dockSpanDays(conflux) {
  if (conflux?.dockStartDay == null || conflux?.dockEndDay == null) return null;
  return Math.max(0, Math.round(Number(conflux.dockEndDay)) - Math.round(Number(conflux.dockStartDay)));
}

export function pairPrimaryId(conflux) {
  return [...(conflux?.domainIds || [])].map(String).sort()[0] || null;
}

export function confluxDue(domain, now = Date.now()) {
  const raw = domain?.nextConfluxNotBefore;
  if (!raw) return true;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return true;
  return Number(now) >= at;
}

export function stampNextConflux(domain, { config, now = Date.now(), rng = Math.random } = {}) {
  const cfg = confluxConfig(config);
  const jitter = (rng() * 2 - 1) * cfg.cadenceJitterHours;
  const hours = Math.max(1, cfg.cadenceHours + jitter);
  domain.nextConfluxNotBefore = new Date(Number(now) + hours * 3600 * 1000).toISOString();
  return domain.nextConfluxNotBefore;
}

/** Свежий город: бан на сопряжение в реальных часах с момента генезиса. */
export function stampGenesisConfluxBan(domain, { config, now = Date.now() } = {}) {
  const hours = confluxConfig(config).genesisBanHours;
  if (!hours) return domain.nextConfluxNotBefore || null;
  const until = new Date(Number(now) + hours * 3600 * 1000).toISOString();
  const prev = Date.parse(domain.nextConfluxNotBefore || '');
  if (!Number.isFinite(prev) || prev < Date.parse(until)) {
    domain.nextConfluxNotBefore = until;
  }
  return domain.nextConfluxNotBefore;
}

function quietAtHour(quiet, hour) {
  const fromHour = quiet?.fromHour;
  const toHour = quiet?.toHour;
  if (fromHour == null || toHour == null) return false;
  if (fromHour === toHour) return false;
  if (fromHour < toHour) return hour >= fromHour && hour < toHour;
  return hour >= fromHour || hour < toHour;
}

function profileScore(hour, hoursUtc, quiet) {
  if (quietAtHour(quiet, hour)) return 0;
  return (Number(hoursUtc?.[hour]) || 0) + 1;
}

/**
 * На сколько часов от «сейчас» сдвинуть старт подготовки, чтобы стык попал
 * в пересечение активных часов. 0 — начинать сразу.
 */
export function pickPrepDelayHours({
  activityA,
  activityB,
  quietA = null,
  quietB = null,
  prepHours,
  dockHours,
  slackHours,
  samplesMin = 10,
} = {}) {
  const a = activityA || emptyHours();
  const b = activityB || emptyHours();
  const samples = Math.min(Number(a.samples) || 0, Number(b.samples) || 0);
  if (samples < samplesMin) return 0;

  const prep = Math.max(1, Number(prepHours) || 6);
  const dock = Math.max(1, Number(dockHours) || 6);
  const slack = Math.max(0, Math.round(Number(slackHours) || 0));
  let bestDelay = 0;
  let bestScore = -1;
  for (let delay = 0; delay <= slack; delay += 1) {
    let score = 0;
    const dockStart = prep + delay;
    for (let h = 0; h < dock; h += 1) {
      const hour = (dockStart + h) % 24;
      score += profileScore(hour, a.hoursUtc, quietA) + profileScore(hour, b.hoursUtc, quietB);
    }
    if (score > bestScore) {
      bestScore = score;
      bestDelay = delay;
    }
  }
  return bestDelay;
}

function emptyHours() {
  return { hoursUtc: Array(24).fill(0), samples: 0 };
}

export function quietFromNotify(notify) {
  if (!notify?.quiet) return null;
  return notify.quiet;
}

export function realPrepLabel(conflux, config) {
  const days = Math.max(0, Number(conflux?.dockStartDay) - Number(conflux?.prepStartDay || 0));
  return realWaitLabel(days, config);
}

export function domainActivityForSchedule(domain) {
  return normalizeActivity(domain);
}

export function hourNowInQuietTz(now, quiet) {
  return hourInTimeZone(now, quiet?.tz || null);
}
