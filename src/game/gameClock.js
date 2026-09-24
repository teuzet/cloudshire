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

/** Месячный индекс из игрового дня: 30 дней = бывший тик. */
export function tickIndexFromDay(dayIndex) {
  return Math.floor(Math.max(0, Math.round(Number(dayIndex) || 0)) / DAYS_PER_MONTH);
}

/**
 * Завести часы мира. Идемпотентно: существующий якорь не трогаем.
 * Если якоря нет, но календарь уже есть — считаем, что этот момент и есть
 * сохранённый день, чтобы живой мир не откатился в год 1.
 */
export function startClock(world, now = Date.now(), config = null) {
  if (!world || typeof world !== 'object') return world;
  if (epochMs(world) == null) {
    const knownDay = Number.isFinite(Number(world.dayIndex))
      ? Math.max(0, Math.round(Number(world.dayIndex)))
      : Math.max(0, Math.round(Number(world.tickIndex) || 0)) * DAYS_PER_MONTH;
    world.epochAt = new Date(now - gameDaysToRealMs(knownDay, config)).toISOString();
    if (!Number.isFinite(Number(world.dayIndex))) world.dayIndex = knownDay;
  } else if (!world.epochAt) {
    world.epochAt = world.scheduler.epochAt;
  }
  if (!Number.isFinite(Number(world.dayIndex))) world.dayIndex = 0;
  return world;
}

/**
 * После загрузки снимка якорь надо поставить заново: иначе стена часов
 * уехала вперёд, и сохранённый день сразу станет прошлым.
 */
export function reanchorClock(world, { day, now = Date.now(), config = null, held = false } = {}) {
  if (!world || typeof world !== 'object') return world;
  const d = Math.max(0, Math.round(Number(day) || 0));
  world.epochAt = new Date(now - gameDaysToRealMs(d, config)).toISOString();
  world.pausedMs = 0;
  world.turnStartedAt = null;
  world.clockHeldAt = held ? now : null;
  return syncWorldClock(world, { now, config, day: d });
}

/**
 * Подтянуть dayIndex / tickIndex / gameDate из якоря и реального времени.
 * Календарь больше не инкрементируется полуночным тиком.
 */
export function syncWorldClock(world, { now = Date.now(), config = null, day = null } = {}) {
  if (!world || typeof world !== 'object') return world;
  startClock(world, now, config);
  const nextDay =
    day == null || !Number.isFinite(Number(day))
      ? currentDay(world, { now, config })
      : Math.max(0, Math.round(Number(day)));
  world.dayIndex = nextDay;
  world.tickIndex = tickIndexFromDay(nextDay);
  world.gameDate = {
    ...gameDateFromDay(nextDay),
    tick: world.tickIndex,
  };
  world.updatedAt = new Date().toISOString();
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

/** Сколько дней тестовый клиент может промотать за раз: год, не десятилетия. */
export const MAX_SKIP_DAYS = DAYS_PER_YEAR;

/**
 * Разобрать число дней для ручной промотки.
 * Пустое значение → fallback (месяц у старого «промотать»). Иначе 1…max или null.
 */
export function parseSkipDays(raw, { fallback = null, max = MAX_SKIP_DAYS } = {}) {
  if (raw == null || raw === '') return fallback;
  const n = Math.round(Number(raw));
  const cap = Math.max(1, Math.round(Number(max) || MAX_SKIP_DAYS));
  if (!Number.isFinite(n) || n < 1 || n > cap) return null;
  return n;
}

/**
 * Промотать часы вперёд на игровые дни.
 *
 * Якорь уезжает назад, а не растёт отдельный счётчик: день по-прежнему
 * считается из реального времени, и всё остальное — сроки дел, очередь
 * заданий, будильник — узнаёт о скачке само, без второго календаря.
 * Нужно ручному force_tick и плейтесту; в обычной игре не вызывается.
 */
export function skipGameDays(world, days, { config = null, now = Date.now(), pausedMs = 0 } = {}) {
  if (!world || typeof world !== 'object') return 0;
  startClock(world, now, config);
  const jump = Math.max(0, Math.round(Number(days) || 0));
  const held = Math.max(0, Number(pausedMs) || 0);
  if (!jump) return currentDay(world, { now, config, pausedMs: held });
  const shift = gameDaysToRealMs(jump, config);
  // Якорь месячного планировщика не трогаем: сдвинув его, мы бы заодно
  // объявили просроченными все пропущенные тики сопряжения.
  world.epochAt = new Date(Date.parse(world.epochAt) - shift).toISOString();
  const day = currentDay(world, { now, config, pausedMs: held });
  syncWorldClock(world, { now, config, day });
  return world.dayIndex;
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

/**
 * Сколько реального времени ждать — то, что видит игрок рядом с игровым сроком.
 *
 * Полосы нужны агентам, чтобы они не считали; игроку числа нужны как раз для
 * счёта: он по ним решает, заглянуть ли через полчаса или можно уйти спать.
 * Поэтому здесь не полоса, а прикидка в минутах и часах.
 */
export function realWaitLabel(days, config = null) {
  const d = Math.max(0, Number(days) || 0);
  if (!d) return 'вот-вот';
  const minutes = gameDaysToRealMs(d, config) / 60000;
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

/** Приблизительный срок дела для речи жреца: без числа дней. */
export function speakGameSpan(days) {
  const d = Math.max(0, Math.round(Number(days) || 0));
  if (d <= 1) return 'день';
  if (d <= 4) return 'несколько дней';
  if (d <= 10) return 'около недели';
  if (d <= 18) return 'две недели';
  if (d <= 25) return 'три недели';
  if (d <= 38) return 'месяц';
  if (d <= 52) return 'полтора месяца';
  if (d <= 75) return 'два месяца';
  if (d <= 105) return 'три месяца';
  if (d <= 135) return 'четыре месяца';
  if (d <= 200) return 'полгода';
  if (d <= 240) return 'больше полугода';
  if (d <= 330) return 'почти год';
  if (d <= 420) return 'год';
  if (d <= 540) return 'полтора года';
  const years = Math.max(2, Math.round(d / DAYS_PER_YEAR));
  if (years % 10 === 1 && years % 100 !== 11) return `${years} год`;
  if (years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 12 || years % 100 > 14)) return `${years} года`;
  return `${years} лет`;
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
