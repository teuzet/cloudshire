/**
 * Посев историй на непрерывном времени.
 *
 * Раньше посев был шагом тика, и новость об истории склеивалась с отчётом
 * о делах. Теперь у домена есть свой срок следующей попытки: пришёл — решаем,
 * сеять ли и откуда. Температуры каналов остаются, но считаются на попытку.
 *
 * Главный регулятор — число живых угроз, а не число историй: угрозы и есть
 * генераторы событий, а история без угрозы событий не производит.
 */

import { DAYS_PER_MONTH, DAYS_PER_YEAR } from './gameClock.js';
import { chronicleEntries } from './models.js';
import { SEED_SOURCES, seedConfig, normalizeSeedTemp, worldSeedChance } from './seedTemp.js';
import { liveThreats } from './threats.js';
import { isStakedStory } from './plotlines.js';

/** Цель по живым угрозам у игрока. Ниже — сеем охотнее, выше — не сеем. */
export const THREAT_TARGET_MIN = 3;
export const THREAT_TARGET_MAX = 4;

/** Попытка посева — часто; сам посев после этого уходит в холодный период. */
export const ATTEMPT_INTERVAL_DAYS = [8, 15];

/** Минимальный зазор между двумя посевами: 1.5–2.5 реальных часа. */
export const SEED_COOLDOWN_DAYS = [22, 37];

/** Заявка старше этого срока выбрасывается: последствия мемориала не ждут вечно. */
export const SEED_REQUEST_MAX_AGE_DAYS = Math.round(DAYS_PER_YEAR * 1.5);

/**
 * Задержка появления. Большинство историй начинается сразу, но часть — это
 * отложенные последствия: игрок построил мемориал, а получил его через полгода.
 */
export const SEED_DELAY_TABLE = [
  { weight: 0.55, min: 0, max: 0 },
  { weight: 0.3, min: 10, max: 60 },
  { weight: 0.15, min: 60, max: DAYS_PER_YEAR },
];

function rollRange([min, max], rng = Math.random) {
  return min + Math.round(rng() * (max - min));
}

export function rollSeedDelay(rng = Math.random) {
  let r = rng();
  for (const row of SEED_DELAY_TABLE) {
    if (r < row.weight) return row.min + Math.round(rng() * (row.max - row.min));
    r -= row.weight;
  }
  return 0;
}

export function scheduleNextAttempt(domain, day, rng = Math.random) {
  if (!domain.state) domain.state = {};
  domain.state.nextSeedAttemptDay = Math.round(Number(day) || 0) + rollRange(ATTEMPT_INTERVAL_DAYS, rng);
  return domain.state.nextSeedAttemptDay;
}

export function applySeedCooldown(domain, day, rng = Math.random) {
  if (!domain.state) domain.state = {};
  domain.state.seedCooldownUntilDay = Math.round(Number(day) || 0) + rollRange(SEED_COOLDOWN_DAYS, rng);
  return domain.state.seedCooldownUntilDay;
}

export function seedAttemptDue(domain, day) {
  const next = Number(domain?.state?.nextSeedAttemptDay);
  if (!Number.isFinite(next)) return true;
  return Math.round(Number(day) || 0) >= next;
}

export function inSeedCooldown(domain, day) {
  const until = Number(domain?.state?.seedCooldownUntilDay);
  if (!Number.isFinite(until)) return false;
  return Math.round(Number(day) || 0) < until;
}

/** Сколько обязательств мира сейчас висит на домене. */
export function countLiveThreats(domain) {
  let n = 0;
  for (const plot of domain?.plotlines || []) {
    if (!isStakedStory(plot)) continue;
    n += liveThreats(plot).length;
  }
  return n;
}

/**
 * Множитель шанса от насыщенности. Меньше нормы — сеем охотнее,
 * в норме — обычный шанс, выше нормы — не сеем вовсе.
 */
export function saturationFactor(liveCount) {
  const n = Math.max(0, Math.round(Number(liveCount) || 0));
  if (n >= THREAT_TARGET_MAX + 1) return 0;
  if (n >= THREAT_TARGET_MAX) return 0.3;
  if (n >= THREAT_TARGET_MIN) return 0.7;
  if (n <= 1) return 1.6;
  return 1;
}

/**
 * Решение одной попытки посева: сеять ли, и из какого канала.
 * Выбор канала — взвешенный по температурам, а не «первый прошедший порог»:
 * иначе холодный канал не сеет никогда.
 */
export function decideSeedAttempt(domain, { day = 0, config = null, rng = Math.random } = {}) {
  const cfg = seedConfig(config);
  const temps = normalizeSeedTemp(domain?.state?.seedTemp, cfg);
  const factor = saturationFactor(countLiveThreats(domain));

  if (inSeedCooldown(domain, day) || factor <= 0) {
    return { seed: false, reason: factor <= 0 ? 'saturated' : 'cooldown', temps };
  }

  const weights = SEED_SOURCES.map((source) => ({
    source,
    weight: Math.max(0, worldSeedChance(temps[source], cfg)),
  }));
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return { seed: false, reason: 'cold', temps };

  const chance = Math.min(1, (total / SEED_SOURCES.length) * factor);
  if (rng() >= chance) return { seed: false, reason: 'roll', temps, chance };

  let r = rng() * total;
  let picked = weights[weights.length - 1].source;
  for (const w of weights) {
    r -= w.weight;
    if (r <= 0) {
      picked = w.source;
      break;
    }
  }
  return { seed: true, source: picked, temps, chance };
}

// ──────────────────────── очередь отложенных посевов ────────────────────────

let requestCounter = 0;

function nextRequestId() {
  requestCounter += 1;
  return `seedreq_${Date.now().toString(36)}_${requestCounter}`;
}

export function seedQueue(domain) {
  if (!domain.state) domain.state = {};
  if (!Array.isArray(domain.state.seedQueue)) domain.state.seedQueue = [];
  return domain.state.seedQueue;
}

/**
 * Поставить заявку. В очереди лежит только ссылка на зерно — текст истории
 * рождается лениво, в момент появления, чтобы не устареть в ожидании.
 */
export function enqueueSeedRequest(
  domain,
  { source = 'void', seedFactId = null, sourceProcessId = null, sourceOrderId = null, day = 0, delayDays = null, rng = Math.random } = {},
) {
  const delay = delayDays == null ? rollSeedDelay(rng) : Math.max(0, Math.round(delayDays));
  const req = {
    id: nextRequestId(),
    source: SEED_SOURCES.includes(source) ? source : 'void',
    seedFactId: seedFactId || null,
    sourceProcessId: sourceProcessId || null,
    sourceOrderId: sourceOrderId || null,
    requestedDay: Math.round(Number(day) || 0),
    appearDay: Math.round(Number(day) || 0) + delay,
    postponed: 0,
  };
  seedQueue(domain).push(req);
  return req;
}

export function dueSeedRequests(domain, day) {
  const d = Math.round(Number(day) || 0);
  return seedQueue(domain).filter((r) => r.appearDay <= d);
}

export function dropSeedRequest(domain, requestId) {
  const queue = seedQueue(domain);
  const i = queue.findIndex((r) => r.id === requestId);
  if (i < 0) return false;
  queue.splice(i, 1);
  return true;
}

/** Отмена правила гасит его отложенные последствия. */
export function dropSeedRequestsForOrder(domain, orderId) {
  const queue = seedQueue(domain);
  const kept = queue.filter((r) => r.sourceOrderId !== orderId);
  const dropped = queue.length - kept.length;
  domain.state.seedQueue = kept;
  return dropped;
}

export const SEED_STALE_REASONS = ['fact_gone', 'plot_open', 'duplicate', 'too_old', 'board_full'];

/**
 * Инварианты свежести, которые проверяются кодом до всякой модели.
 * Дорогой судья вызывается только если это прошло.
 */
export function checkSeedFreshness(
  domain,
  request,
  { day = 0, facts = null, openPlots = null, boardFull = false } = {},
) {
  const age = Math.round(Number(day) || 0) - Math.round(Number(request?.requestedDay) || 0);
  if (age > SEED_REQUEST_MAX_AGE_DAYS) return { fresh: false, reason: 'too_old' };

  const plots = openPlots || (domain?.plotlines || []);
  if (request?.seedFactId) {
    const list = facts || chronicleEntries(domain?.lore);
    const fact = list.find((f) => f && String(f.id) === String(request.seedFactId));
    if (!fact) return { fresh: false, reason: 'fact_gone' };
    if (fact.sourcePlotId && plots.some((p) => String(p.id) === String(fact.sourcePlotId))) {
      return { fresh: false, reason: 'plot_open' };
    }
    if (plots.some((p) => String(p.seedFactId || '') === String(request.seedFactId))) {
      return { fresh: false, reason: 'duplicate' };
    }
  }

  if (boardFull) return { fresh: false, reason: 'board_full', postpone: true };
  return { fresh: true };
}

/** Полная доска — не причина выбрасывать заявку: она просто ждёт. */
export function postponeSeedRequest(request, day, rng = Math.random) {
  request.postponed = Math.max(0, Math.round(Number(request.postponed) || 0)) + 1;
  request.appearDay = Math.round(Number(day) || 0) + rollRange([DAYS_PER_MONTH, DAYS_PER_MONTH * 3], rng);
  return request;
}

/**
 * Срез хроники, накопившийся с постановки заявки в очередь.
 * Он же уходит и судье свежести, и сборщику: судья не должен видеть больше,
 * чем сборщик, иначе сборщик напишет то, что уже противоречит миру.
 */
export function chronicleSince(domain, request, { limit = 12 } = {}) {
  const since = Math.round(Number(request?.requestedDay) || 0);
  return chronicleEntries(domain?.lore)
    .filter((f) => Number.isFinite(Number(f?.day)) && Number(f.day) >= since)
    .slice(-limit);
}
