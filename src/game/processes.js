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
  return keys;
}

/**
 * Найти уже идущее дело той же смысловой нити (не только точное совпадение summary).
 */
export function findDuplicateProcess(domain, summary, detail = '') {
  const needle = normProcessText(`${summary} ${detail}`);
  if (needle.length < 4) return null;
  const needleTokens = new Set(processTokens(needle));
  const needleThemes = new Set(processThemeKeys(needle));
  const summaryOnly = normProcessText(summary);

  return (domain.state?.pendingActions || []).find((a) => {
    if (a.status !== 'active') return false;
    const hay = normProcessText(`${a.summary} ${a.detail || ''}`);
    if (!hay) return false;
    if (hay === summaryOnly || hay.includes(summaryOnly) || summaryOnly.includes(normProcessText(a.summary))) {
      return true;
    }
    const hayTokens = processTokens(hay);
    if (needleTokens.size && hayTokens.length) {
      const overlap = hayTokens.filter((t) => needleTokens.has(t));
      const need = Math.min(2, Math.max(1, Math.ceil(needleTokens.size * 0.4)));
      if (overlap.length >= need && overlap.length >= 2) return true;
    }
    const hayThemes = processThemeKeys(hay);
    if (needleThemes.size && hayThemes.some((k) => needleThemes.has(k))) {
      // Одна тема + хоть одно общее значимое слово → дубль
      const shared = hayTokens.filter((t) => needleTokens.has(t));
      if (shared.length >= 1) return true;
      // Чистая тема без слов: суд vs суд — дубль, если оба только про суд
      if (needleThemes.size === 1 && hayThemes.length === 1 && [...needleThemes][0] === hayThemes[0]) {
        return true;
      }
    }
    return false;
  });
}

/** Хроника утверждает, что дело уже закончено / сорвано. */
export function chronicleImpliesProcessFinished(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  if (
    /сорван|провал|провалил|уничтож|разруш|отменен|отменён|бросили дело|дело похоронили|не удалось/.test(
      t,
    )
  ) {
    return 'failed';
  }
  if (
    /завершен|завершён|окончен|закончен|готов[аоы](\s|$|,|\.)|сдано|сдан[ао](\s|$|,|\.)|открыт[ао] для|возвед[её]н|построен|достроен|воздвигнут/.test(
      t,
    ) ||
    /суд.{0,40}(вынес|оконч|закрыл)|приговор.{0,20}(вынес|оглас)|дело.{0,25}(закрыт|оконч)/.test(t) ||
    /работы.{0,25}(законч|заверш)|успешно.{0,20}(заверш|оконч)|дов[её]л.{0,20}до конца/.test(t)
  ) {
    return 'complete';
  }
  return null;
}

/**
 * Если запись хроники по процессу говорит «готово/сорвано», а процесс ещё active —
 * синхронизировать статус в том же тике.
 */
export function syncProcessesFromChronicle(domain, chronicleAdds, { tick = null, log = null } = {}) {
  if (!domain?.state?.pendingActions?.length || !chronicleAdds?.length) return [];
  const synced = [];
  for (const fact of chronicleAdds) {
    const pid = fact?.relatedPendingId;
    if (!pid) continue;
    const outcome = chronicleImpliesProcessFinished(fact.text);
    if (!outcome) continue;
    const action = domain.state.pendingActions.find((a) => a.id === pid && a.status === 'active');
    if (!action) continue;
    if (outcome === 'failed') {
      action.status = 'cancelled';
      action.cancelReason = action.cancelReason || 'по хронике месяца';
      action.monthsLeft = 0;
      action.updatedAt = new Date().toISOString();
      if (tick != null) action.resolvedTick = tick;
    } else {
      applyProcessAdvance(action, 0, { complete: true, tick });
    }
    synced.push({ processId: pid, outcome, summary: action.summary });
    log?.info?.('process.sync_from_chronicle', {
      processId: pid,
      outcome,
      summary: action.summary,
      factPreview: String(fact.text || '').slice(0, 160),
    });
  }
  return synced;
}
