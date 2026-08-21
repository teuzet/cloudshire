/**
 * Длительные процессы города (бывш. pending): ожидаемый срок + статы → бросок прогресса на тике.
 */

export function listStatIds(config) {
  return (config?.stats || []).map((s) => s.id);
}

export function normalizeProcess(action, config = null) {
  if (!action || typeof action !== 'object') return action;

  if (action.expectedMonths == null) {
    action.expectedMonths = Math.max(
      1,
      Math.min(12, Math.round(Number(action.durationMonths) || 1)),
    );
  } else {
    action.expectedMonths = Math.max(1, Math.min(12, Math.round(Number(action.expectedMonths) || 1)));
  }

  // Совместимость со старым durationMonths / monthsDone
  if (action.durationMonths == null) action.durationMonths = action.expectedMonths;
  else action.durationMonths = action.expectedMonths;

  if (action.monthsLeft == null) {
    const done = Math.max(0, Math.round(Number(action.monthsDone) || 0));
    action.monthsLeft = Math.max(0, action.expectedMonths - done);
  } else {
    action.monthsLeft = Math.max(0, Math.min(12, Math.round(Number(action.monthsLeft) || 0)));
  }

  action.monthsDone = Math.max(0, action.expectedMonths - action.monthsLeft);

  if (!Array.isArray(action.linkedStats)) action.linkedStats = [];
  const allowed = new Set(listStatIds(config));
  if (allowed.size) {
    action.linkedStats = [...new Set(action.linkedStats.map(String).filter((id) => allowed.has(id)))];
  } else {
    action.linkedStats = [...new Set(action.linkedStats.map(String))];
  }

  if (!action.status) action.status = 'active';
  return action;
}

export function normalizeDomainProcesses(domain, config = null) {
  if (!domain?.state) return domain;
  if (!Array.isArray(domain.state.pendingActions)) domain.state.pendingActions = [];
  for (const a of domain.state.pendingActions) normalizeProcess(a, config);
  return domain;
}

export function activeProcesses(domain, config = null) {
  normalizeDomainProcesses(domain, config);
  return (domain.state?.pendingActions || []).filter((a) => a.status === 'active');
}

/** Среднее связанных статов; если пусто — среднее всех статов домена или 50. */
export function processStatAverage(domain, process, config = null) {
  normalizeProcess(process, config);
  const stats = domain.stats || {};
  let ids = process.linkedStats || [];
  if (!ids.length) {
    ids = Object.keys(stats);
  }
  const vals = ids
    .map((id) => Number(stats[id]))
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return 50;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/**
 * Бросок 0–100 vs среднее статов:
 * roll > avg+40 → 0 (застой)
 * roll < avg-40 → 2 (рывок)
 * иначе → 1
 */
export function rollProcessAdvance(avgStat, rng = Math.random) {
  const avg = Math.max(0, Math.min(100, Math.round(Number(avgStat) || 50)));
  const roll = Math.floor(rng() * 101); // 0..100
  let advance = 1;
  let kind = 'normal';
  if (roll > avg + 40) {
    advance = 0;
    kind = 'stall';
  } else if (roll < avg - 40) {
    advance = 2;
    kind = 'surge';
  }
  return {
    roll,
    avg,
    advance,
    kind,
    unusual: kind !== 'normal',
    thresholds: { stallAbove: avg + 40, surgeBelow: avg - 40 },
  };
}

/** Броски для всех active процессов домена (до резолва). */
export function rollAllProcessAdvances(domain, config = null, rng = Math.random) {
  const list = activeProcesses(domain, config);
  return list.map((p) => {
    const avg = processStatAverage(domain, p, config);
    const rolled = rollProcessAdvance(avg, rng);
    return {
      processId: p.id,
      summary: p.summary,
      monthsLeftBefore: p.monthsLeft,
      linkedStats: [...(p.linkedStats || [])],
      ...rolled,
    };
  });
}

export function applyProcessAdvance(process, advance, { complete = false, failed = false, tick = null } = {}) {
  normalizeProcess(process);
  const step = Math.max(0, Math.min(6, Math.round(Number(advance) || 0)));
  process.monthsLeft = Math.max(0, (process.monthsLeft || 0) - step);
  process.monthsDone = Math.max(0, process.expectedMonths - process.monthsLeft);
  process.durationMonths = process.expectedMonths;
  process.updatedAt = new Date().toISOString();
  const finished =
    Boolean(failed) || Boolean(complete) || process.monthsLeft <= 0;
  if (finished) {
    process.status = failed ? 'failed' : 'resolved';
    if (tick != null) process.resolvedTick = tick;
    process.monthsLeft = 0;
    process.monthsDone = process.expectedMonths;
  }
  return { finished, step, monthsLeft: process.monthsLeft };
}

export function formatProcessLine(process, config = null) {
  normalizeProcess(process, config);
  const stats =
    process.linkedStats?.length > 0 ? process.linkedStats.join('+') : 'все статы';
  return (
    `- [${process.id}] ${process.summary}: ${process.detail || ''} ` +
    `| ожидание ~${process.monthsLeft} мес. (оценка ${process.expectedMonths}) ` +
    `| статы: ${stats} (от ${process.onBehalfOf || process.characterName || '?'})`
  );
}

export function formatProcessRollsForPrompt(rolls) {
  if (!rolls?.length) return '(нет активных процессов)';
  return rolls
    .map((r) => {
      const flag =
        r.kind === 'stall'
          ? ' ★ЗАСТОЙ (0 мес.) — обыграй в хронике'
          : r.kind === 'surge'
            ? ' ★РЫВОК (2 мес.) — обыграй в хронике'
            : ' (обычно 1 мес.)';
      return (
        `- [${r.processId}] «${r.summary}» roll=${r.roll} avgStats=${r.avg} → advance=${r.advance}${flag}`
      );
    })
    .join('\n');
}

export function resolveLinkedStats(raw, config) {
  const allowed = listStatIds(config);
  const set = new Set(allowed);
  let ids = Array.isArray(raw) ? raw.map(String) : [];
  ids = [...new Set(ids.filter((id) => set.has(id)))];
  return ids;
}

export function maxActiveProcesses(config) {
  const n = Number(config?.tick?.maxActiveProcesses);
  return Number.isFinite(n) && n >= 1 ? Math.min(12, Math.round(n)) : 4;
}

export function canStartProcess(domain, config = null) {
  const max = maxActiveProcesses(config);
  const active = activeProcesses(domain, config);
  return {
    ok: active.length < max,
    active: active.length,
    max,
    busy: active.map((a) => a.summary),
  };
}

/** Жёсткий срок от покровителя («в этом месяце» и т.п.) — не раздувать expectedMonths. */
export function hasHardPatronDeadline(summary, detail) {
  const t = `${summary || ''} ${detail || ''}`.toLowerCase();
  return (
    /в этом месяце|на этот месяц|за (этот )?месяц|до конца месяца|в течение месяца/.test(t) ||
    /за один месяц|одним месяцем|месяц и не больше|не позже (этого |текущего )?месяца/.test(t) ||
    /немедленн|сейчас же|сегодня же|без отлагательств|к концу месяца/.test(t)
  );
}

export function guessProcessDuration(summary, detail, duration) {
  const d = Math.max(1, Math.min(12, Math.round(Number(duration) || 1)));
  // Жёсткий дедлайн покровителя важнее «типичного» минимума по типу дела.
  if (hasHardPatronDeadline(summary, detail)) return d;

  const t = `${summary || ''} ${detail || ''}`.toLowerCase();
  let min = 1;
  if (/войн|штурм|ополчен|войск|взят.{0,20}ворот|поход|осад|арми|завосв|вторжен/.test(t)) {
    min = Math.max(min, 3);
  }
  if (/строит|винодел|храм|академи|библиотек|крепост|канал|дворец|мануфакт|верф/.test(t)) {
    min = Math.max(min, 3);
  }
  if (/посольств|лазут|развед|шпион|наблюд/.test(t)) {
    min = Math.max(min, 2);
  }
  return Math.max(min, d);
}

const PROCESS_STOP = new Set([
  'этот',
  'этой',
  'этого',
  'того',
  'чтобы',
  'когда',
  'после',
  'перед',
  'через',
  'месяц',
  'месяца',
  'месяцев',
  'город',
  'города',
  'люди',
  'людей',
  'нужно',
  'надо',
  'сделать',
  'приказ',
  'поручен',
  'поручение',
  'дело',
  'работы',
  'работа',
  // Общие глаголы/заготовки — иначе «подготовить X» ≈ «подготовить Y»
  'подготов',
  'готов',
  'устро',
  'организ',
  'начат',
  'провед',
  'устройств',
  'собра',
  'сдела',
  'нужн',
]);

function normProcessText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[«»"'„“]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function processTokens(s) {
  return normProcessText(s)
    .split(/[^а-яёa-z0-9]+/i)
    .map((w) => w.replace(/(ами|ями|ов|ев|ей|ом|ем|ах|ях|ую|юю|ая|яя|ые|ие|ый|ий|ой|ое|ее)$/i, ''))
    .filter((w) => w.length >= 4 && !PROCESS_STOP.has(w));
}

/** Грубые семантические нити: один суд / одна стройка храма и т.п. */
function processThemeKeys(text) {
  const t = normProcessText(text);
  const keys = [];
  if (/суд|тяжб|разбирательств|приговор|обвинен|казн/.test(t)) keys.push('court');
  if (/храм|святил|алтар|культ/.test(t)) keys.push('temple');
  if (/строит|возвед|перестро|форт|стен|башн|крепост|дворц|мост|канал|верф|мануфакт/.test(t)) {
    keys.push('build');
  }
  if (/оруж|меч|коп|доспех|арсенал|кузн/.test(t)) keys.push('arms');
  if (/развед|лазут|шпион|наблюд|соглед/.test(t)) keys.push('scout');
  if (/посольств|договор|перегов|союз/.test(t)) keys.push('diplomacy');
  if (/ополчен|набор|рекрут|обучен.{0,12}(воин|страж)|войск/.test(t)) keys.push('levy');
  if (/снабж|провиант|амбар|зерн|голод|пайк/.test(t)) keys.push('supply');
  if (/универс|академи|учебн|школ|семинар|курс/.test(t)) keys.push('education');
  if (/праздн|фестив|гулян|ярмарк|торжеств|карнавал/.test(t)) keys.push('festival');
  return keys;
}

function themesOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  const set = new Set(a);
  return b.some((k) => set.has(k));
}

/**
 * Найти уже идущее дело той же смысловой нити (не только точное совпадение summary).
 */
export function findDuplicateProcess(domain, summary, detail = '') {
  const needle = normProcessText(`${summary} ${detail}`);
  if (needle.length < 4) return null;
  const needleTokens = new Set(processTokens(needle));
  const needleThemes = processThemeKeys(needle);
  const summaryOnly = normProcessText(summary);

  return (domain.state?.pendingActions || []).find((a) => {
    if (a.status !== 'active') return false;
    const hay = normProcessText(`${a.summary} ${a.detail || ''}`);
    if (!hay) return false;
    const haySummary = normProcessText(a.summary);
    if (hay === summaryOnly || (summaryOnly.length >= 12 && (hay.includes(summaryOnly) || summaryOnly.includes(haySummary)))) {
      return true;
    }
    const hayThemes = processThemeKeys(hay);
    // Разные явные темы (университет vs праздник) — не дубль
    if (needleThemes.length && hayThemes.length && !themesOverlap(needleThemes, hayThemes)) {
      return false;
    }
    const hayTokens = processTokens(hay);
    if (needleTokens.size && hayTokens.length) {
      const overlap = hayTokens.filter((t) => needleTokens.has(t));
      const need = Math.min(3, Math.max(2, Math.ceil(needleTokens.size * 0.45)));
      if (overlap.length >= need) return true;
    }
    if (needleThemes.length && themesOverlap(needleThemes, hayThemes)) {
      const shared = hayTokens.filter((t) => needleTokens.has(t));
      if (shared.length >= 1) return true;
      if (needleThemes.length === 1 && hayThemes.length === 1 && needleThemes[0] === hayThemes[0]) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Найти активный процесс по id или по фрагменту summary/detail
 * (модели часто выдумывают id вроде university_curriculum).
 */
export function resolveActiveProcess(domain, processId, config = null) {
  const list = activeProcesses(domain, config);
  const raw = String(processId || '').trim();
  if (!raw) return { process: null, candidates: list };
  const byId = list.find((a) => a.id === raw);
  if (byId) return { process: byId, candidates: list };

  const needle = normProcessText(raw.replace(/[_-]+/g, ' '));
  if (needle.length < 3) return { process: null, candidates: list };

  // Выдуманные латиницей id → темы (university_curriculum → education)
  const inventedThemes = processThemeKeys(
    needle
      .replace(/\buniversity\b|\bacademy\b|\bcurriculum\b|\bschool\b|\beducation\b/g, ' университет учебный ')
      .replace(/\bfestival\b|\bfeast\b|\bcelebration\b|\bholliday\b|\bholiday\b/g, ' праздник ')
      .replace(/\btemple\b|\bshrine\b|\bcult\b/g, ' храм ')
      .replace(/\bcourt\b|\btrial\b|\bjudgment\b/g, ' суд ')
      .replace(/\barmy\b|\blevy\b|\brecruit\b|\bmilitia\b/g, ' ополчение войск ')
      .replace(/\bscout\b|\bspy\b|\brecon\b/g, ' разведка ')
      .replace(/\bdiplomacy\b|\benvoy\b|\btreaty\b/g, ' посольство ')
      .replace(/\bbuild\b|\bfort\b|\bwall\b|\bbridge\b/g, ' строительство ')
      .replace(/\barms\b|\bweapon\b|\bforge\b/g, ' оружие кузница ')
      .replace(/\bsupply\b|\bgrain\b|\bfood\b/g, ' провиант зерно '),
  );

  const scored = list
    .map((a) => {
      const hay = normProcessText(`${a.summary} ${a.detail || ''}`);
      let score = 0;
      if (hay.includes(needle) || needle.includes(normProcessText(a.summary))) score += 5;
      const nTok = processTokens(needle);
      const hTok = new Set(processTokens(hay));
      const overlap = nTok.filter((t) => hTok.has(t));
      score += overlap.length * 2;
      const hayThemes = processThemeKeys(hay);
      if (inventedThemes.length && themesOverlap(inventedThemes, hayThemes)) score += 4;
      const themes = processThemeKeys(needle);
      if (themes.length && themesOverlap(themes, hayThemes)) score += 3;
      return { a, score, overlap: overlap.length };
    })
    .filter((x) => x.score >= 3)
    .sort((x, y) => y.score - x.score);

  if (scored.length === 1 || (scored.length >= 2 && scored[0].score > scored[1].score + 1)) {
    return { process: scored[0].a, candidates: list };
  }
  return { process: null, candidates: list };
}

export function formatActiveProcessesForAgent(domain, config = null) {
  const list = activeProcesses(domain, config);
  if (!list.length) return '(нет активных дел)';
  return list.map((a) => formatProcessLine(a, config)).join('\n');
}
