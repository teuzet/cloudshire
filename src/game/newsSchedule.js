/**
 * Расписание писем месяца. Движок решает, слать ли tickNews.
 * Сближение островов (announce/approach) этим расписанием не глушится.
 */

export const NEWS_DETAIL = {
  full: 'full',
  brief: 'brief',
  essence: 'essence',
};

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function defaultNewsSchedule() {
  return {
    months: [...ALL_MONTHS],
    alsoOnCritical: true,
    detail: NEWS_DETAIL.essence,
    clickbait: true,
    ask: true,
  };
}

function cleanMonths(raw) {
  const set = new Set();
  for (const n of raw || []) {
    const m = Math.round(Number(n));
    if (m >= 1 && m <= 12) set.add(m);
  }
  return [...set].sort((a, b) => a - b);
}

export function normalizeNewsSchedule(raw) {
  const base = defaultNewsSchedule();
  if (!raw || typeof raw !== 'object') return base;
  const months = Array.isArray(raw.months) ? cleanMonths(raw.months) : base.months;
  const detail = NEWS_DETAIL[raw.detail] || base.detail;
  return {
    months: months.length ? months : [],
    alsoOnCritical: raw.alsoOnCritical == null ? base.alsoOnCritical : Boolean(raw.alsoOnCritical),
    detail,
    clickbait: raw.clickbait == null ? base.clickbait : Boolean(raw.clickbait),
    ask: raw.ask == null ? base.ask : Boolean(raw.ask),
  };
}

export function newsScheduleOf(domain) {
  return normalizeNewsSchedule(domain?.state?.newsSchedule);
}

export function setNewsSchedule(domain, patch = {}) {
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  const next = normalizeNewsSchedule({ ...newsScheduleOf(domain), ...patch });
  domain.state.newsSchedule = next;
  return next;
}

export function monthHasCritical(entries) {
  return (entries || []).some((e) => String(e?.importance || '').toLowerCase() === 'critical');
}

/** Слать ли письмо месяца. Вести о сближении сюда не входят. */
export function shouldSendTickNews(domain, gameDate, chronicleAdds = []) {
  const schedule = newsScheduleOf(domain);
  const month = Number(gameDate?.month);
  if (Number.isFinite(month) && schedule.months.includes(month)) return true;
  if (schedule.alsoOnCritical && monthHasCritical(chronicleAdds)) return true;
  return false;
}

export function splitTickNews(text, { max = 3 } = {}) {
  const body = String(text || '').trim();
  if (!body) return [];
  const chunks = body
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  if (chunks.length <= 1) return [body];
  return chunks.slice(0, Math.max(1, max));
}

export function tickNewsStyleHint(schedule) {
  const s = normalizeNewsSchedule(schedule);
  const detail =
    s.detail === 'full'
      ? 'Подробный отчёт: ключевое разверни, прочее коротко.'
      : s.detail === 'brief'
        ? 'Краткая выжимка: два-три предложения о главном, остальное одной фразой или никак.'
        : 'Супер-краткая выжимка: одна-две фразы. Только суть. Тихий месяц — ещё короче.';
  const click = s.clickbait
    ? 'Зачин кликбейтный: сразу что стряслось, чтобы покровитель захотел спросить. Не канцелярия.'
    : 'Без кричащего зачина — спокойная речь.';
  const ask = s.ask
    ? 'Закончи прямым вопросом покровителю: что делать, как быть, какой его воля.'
    : 'Вопросом не заканчивай, если сам не видишь нужды.';
  return [detail, click, ask].join(' ');
}
