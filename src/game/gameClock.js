/**
 * Игровые часы: непрерывное время вместо тиков.
 *
 *   игровой год = 360 игровых дней = 24 реальных часа
 *   1 игровой день = 4 реальные минуты
 *   1 игровой месяц (30 дней) = 2 реальных часа  ← бывший тик
 *
 * Текущий день считается от реального времени и якоря `world.epochAt`,
 * чтобы перезапуск процесса не терял ход времени.
 */

export const DAYS_PER_YEAR = 360;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = DAYS_PER_YEAR / DAYS_PER_MONTH;

const DEFAULT_REAL_HOURS_PER_YEAR = 24;

export function realHoursPerYear(config) {
  const h = Number(config?.time?.realHoursPerYear);
  return Number.isFinite(h) && h > 0 ? h : DEFAULT_REAL_HOURS_PER_YEAR;
}

/** Сколько реальных миллисекунд длится один игровой день. */
export function realMsPerGameDay(config) {
  return (realHoursPerYear(config) * 60 * 60 * 1000) / DAYS_PER_YEAR;
}

export function gameDaysToRealMs(days, config) {
  return Math.round(Number(days || 0) * realMsPerGameDay(config));
}

export function realMsToGameDays(ms, config) {
  return Number(ms || 0) / realMsPerGameDay(config);
}

function epochMs(world) {
  // Мир, заведённый месячным путём, уже держит якорь в scheduler: игровой год
  // начинается с начала реальных суток. Второй якорь развёл бы календари.
  const raw = world?.epochAt || world?.scheduler?.epochAt;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** Завести часы нового мира. Идемпотентно: существующий якорь не трогаем. */
export function startClock(world, now = Date.now()) {
  if (!world || typeof world !== 'object') return world;
  if (!world.epochAt) {
    world.epochAt = world.scheduler?.epochAt || new Date(now).toISOString();
  }
  if (!Number.isFinite(Number(world.dayIndex))) world.dayIndex = 0;
  return world;
}

/**
 * Текущий игровой день.
 * Время домена может стоять (ход правителя) — тогда учитывается накопленная пауза.
 */
export function currentDay(world, { now = Date.now(), config = null, pausedMs = 0 } = {}) {
  const epoch = epochMs(world);
  if (epoch == null) return Math.max(0, Math.round(Number(world?.dayIndex) || 0));
  const elapsed = Math.max(0, Number(now) - epoch - Math.max(0, Number(pausedMs) || 0));
  return Math.floor(elapsed / realMsPerGameDay(config));
}

/** Реальный момент, когда наступит указанный игровой день. */
export function realTimeOfDay(world, day, { config = null, pausedMs = 0 } = {}) {
  const epoch = epochMs(world);
  if (epoch == null) return null;
  return epoch + Math.max(0, Number(pausedMs) || 0) + Math.round(Number(day) * realMsPerGameDay(config));
}

export function gameDateFromDay(dayIndex) {
  const d = Math.max(0, Math.round(Number(dayIndex) || 0));
  const year = Math.floor(d / DAYS_PER_YEAR) + 1;
  const dayOfYear = d % DAYS_PER_YEAR;
  const month = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
  const day = (dayOfYear % DAYS_PER_MONTH) + 1;
  return {
    year,
    month,
    day,
    dayIndex: d,
    label: `Год ${year}, месяц ${month}, день ${day}`,
  };
}

export function worldDateLabel(world) {
  return gameDateFromDay(world?.dayIndex ?? 0).label;
}

/**
 * Словесная полоса промежутка — то, что видит агент вместо числа дней.
 * Тот же словарь, что у сроков дел: агенты не работают с днями.
 */
export function spanBandLabel(days) {
  const d = Math.max(0, Number(days) || 0);
  if (d <= 3) return 'считанные дни';
  if (d <= 18) return 'дни';
  if (d <= 65) return 'недели';
  if (d <= 160) return 'сезон';
  if (d <= 400) return 'год';
  return 'годы';
}

/** Приблизительный человеческий срок для речи жреца. */
export function humanSpan(days) {
  const d = Math.max(0, Math.round(Number(days) || 0));
  if (d <= 1) return 'со дня на день';
  if (d < 14) return `около ${d} дней`;
  if (d < DAYS_PER_MONTH * 2) return `несколько недель`;
  if (d < DAYS_PER_YEAR) {
    const months = Math.max(1, Math.round(d / DAYS_PER_MONTH));
    return `около ${months} мес.`;
  }
  const years = Math.max(1, Math.round(d / DAYS_PER_YEAR));
  return years === 1 ? 'около года' : `около ${years} лет`;
}
