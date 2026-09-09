/**
 * Настройки уведомлений.
 *
 * Тик был не только календарём, но и батчером: письмо месяца склеивало до трёх
 * событий в одно сообщение. Без тика это свойство надо восстановить явно,
 * иначе непрерывное время превращается в поток пушей.
 *
 * Инвариант: настройки управляют только пушами. Хроника пишется всегда
 * и полностью — то, что не дошло уведомлением, игрок найдёт в мини-аппке.
 */

import { DAYS_PER_MONTH } from './gameClock.js';

export const NOTIFY_INTENSITIES = ['всё', 'важное', 'сводка'];

export const NOTIFY_TRIGGERS = [
  'newStory',
  'threatSurfaced',
  'threatFired',
  'deedDone',
  'deedFailed',
  'errandDone',
  'plotClosed',
  'priestReport',
  'conflux',
];

/** Минимальный зазор между пушами в игровых днях, выводится из интенсивности. */
export const MIN_GAP_BY_INTENSITY = {
  'всё': 2,
  'важное': 8,
  'сводка': DAYS_PER_MONTH,
};

/** Что жрец не имеет права отключить сам, даже если попросили. */
export const PROTECTED_TRIGGERS = ['threatFired'];

const TRIGGERS_BY_INTENSITY = {
  'всё': NOTIFY_TRIGGERS,
  // Исход дела покровитель ждёт: он сам его завёл. Молчим только про мелкие поручения.
  'важное': [
    'newStory',
    'threatSurfaced',
    'threatFired',
    'deedDone',
    'deedFailed',
    'plotClosed',
    'priestReport',
    'conflux',
  ],
  'сводка': ['threatFired', 'plotClosed'],
};

export function parseIntensity(raw, fallback = 'важное') {
  const key = String(raw || '').trim().toLowerCase();
  return NOTIFY_INTENSITIES.includes(key) ? key : fallback;
}

export function defaultNotify() {
  return {
    intensity: 'важное',
    triggers: Object.fromEntries(
      NOTIFY_TRIGGERS.map((t) => [t, TRIGGERS_BY_INTENSITY['важное'].includes(t)]),
    ),
    quiet: { fromHour: null, toHour: null, tz: null },
    style: { detail: 'обычно', clickbait: false, ask: true },
    lastPushDay: null,
  };
}

export function normalizeNotify(raw) {
  const base = defaultNotify();
  if (!raw || typeof raw !== 'object') return base;
  const intensity = parseIntensity(raw.intensity, base.intensity);
  const preset = TRIGGERS_BY_INTENSITY[intensity];
  const triggers = {};
  for (const t of NOTIFY_TRIGGERS) {
    triggers[t] = raw.triggers?.[t] == null ? preset.includes(t) : !!raw.triggers[t];
  }
  for (const t of PROTECTED_TRIGGERS) triggers[t] = true;
  const fromHour = Number(raw.quiet?.fromHour);
  const toHour = Number(raw.quiet?.toHour);
  return {
    intensity,
    triggers,
    quiet: {
      fromHour: Number.isInteger(fromHour) && fromHour >= 0 && fromHour < 24 ? fromHour : null,
      toHour: Number.isInteger(toHour) && toHour >= 0 && toHour < 24 ? toHour : null,
      tz: raw.quiet?.tz ? String(raw.quiet.tz).slice(0, 64) : null,
    },
    style: {
      detail: ['коротко', 'обычно', 'подробно'].includes(raw.style?.detail) ? raw.style.detail : 'обычно',
      clickbait: !!raw.style?.clickbait,
      ask: raw.style?.ask == null ? true : !!raw.style.ask,
    },
    lastPushDay: Number.isFinite(Number(raw.lastPushDay)) ? Math.round(Number(raw.lastPushDay)) : null,
  };
}

export function notifySettings(domain) {
  if (!domain.state) domain.state = {};
  domain.state.notify = normalizeNotify(domain.state.notify);
  return domain.state.notify;
}

export function minGapDays(notify) {
  return MIN_GAP_BY_INTENSITY[parseIntensity(notify?.intensity)] ?? 8;
}

/**
 * Жрец может править триггеры и стиль в разговоре, но не тихие часы —
 * их ставит игрок руками, чтобы просьба «не буди» не терялась в диалоге.
 * Предохранители: не опускать интенсивность ниже «важное» и не глушить
 * сработавшую беду. Полную тишину включает только игрок.
 */
export function applyPriestNotifyChange(domain, { intensity = null, triggers = null, style = null } = {}) {
  const notify = notifySettings(domain);
  if (intensity) {
    const next = parseIntensity(intensity, notify.intensity);
    const capped = next === 'сводка' ? 'важное' : next;
    if (capped !== notify.intensity) {
      notify.intensity = capped;
      // Пресет накатываем заново. `normalizeNotify` материализует все флаги
      // явными булями, и после первого же прохода пресет из интенсивности
      // больше не выводится — без этого «пиши мне про всё» меняло бы подпись
      // громкости, не включая ни одного нового повода.
      const preset = TRIGGERS_BY_INTENSITY[capped] || [];
      for (const t of NOTIFY_TRIGGERS) notify.triggers[t] = preset.includes(t);
      for (const t of PROTECTED_TRIGGERS) notify.triggers[t] = true;
    }
  }
  if (triggers && typeof triggers === 'object') {
    for (const [key, value] of Object.entries(triggers)) {
      if (!NOTIFY_TRIGGERS.includes(key)) continue;
      if (PROTECTED_TRIGGERS.includes(key)) continue;
      notify.triggers[key] = !!value;
    }
  }
  if (style && typeof style === 'object') {
    notify.style = normalizeNotify({ ...notify, style: { ...notify.style, ...style } }).style;
  }
  domain.state.notify = normalizeNotify(notify);
  return domain.state.notify;
}

function inQuietHours(notify, now = new Date()) {
  const { fromHour, toHour } = notify?.quiet || {};
  if (fromHour == null || toHour == null) return false;
  const hour = now.getHours();
  if (fromHour === toHour) return false;
  if (fromHour < toHour) return hour >= fromHour && hour < toHour;
  return hour >= fromHour || hour < toHour;
}

/**
 * Отправлять ли пуш. `false` не отменяет событие: хроника уже написана,
 * просто телефон молчит.
 */
export function shouldPush(domain, { trigger, day = 0, now = new Date(), force = false } = {}) {
  const notify = notifySettings(domain);
  if (force) return { push: true, reason: 'force' };
  if (!notify.triggers[trigger]) return { push: false, reason: 'trigger_off' };
  if (inQuietHours(notify, now)) return { push: false, reason: 'quiet_hours' };
  const last = Number(notify.lastPushDay);
  if (Number.isFinite(last) && Math.round(Number(day) || 0) - last < minGapDays(notify)) {
    return { push: false, reason: 'min_gap' };
  }
  return { push: true, reason: 'ok' };
}

export function markPushed(domain, day) {
  const notify = notifySettings(domain);
  notify.lastPushDay = Math.round(Number(day) || 0);
  return notify;
}
