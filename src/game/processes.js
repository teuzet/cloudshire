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

  if (action.goal != null) {
    const goal = String(action.goal).trim().replace(/\s+/g, ' ');
    action.goal = goal ? goal.slice(0, 240) : null;
  }

  if (!Array.isArray(action.linkedStats)) action.linkedStats = [];
  const allowed = new Set(listStatIds(config));
  if (allowed.size) {
    action.linkedStats = [...new Set(action.linkedStats.map(String).filter((id) => allowed.has(id)))];
  } else {
    action.linkedStats = [...new Set(action.linkedStats.map(String))];
  }

  if (!action.status) action.status = 'active';
  if (!action.initiative) action.initiative = 'patron';
  action.blessed = Boolean(action.blessed);
  action.intel = Boolean(action.intel);
  if (action.objectiveMonths == null) {
    action.objectiveMonths = action.expectedMonths;
  } else {
    action.objectiveMonths = Math.max(1, Math.min(12, Math.round(Number(action.objectiveMonths) || 1)));
  }
  if (action.plotEngagement != null || action.plotAligned != null) {
    const raw = String(action.plotEngagement || '').toUpperCase();
    if (raw === 'DIRECT' || raw === 'RELEVANT' || raw === 'UNRELATED') {
      action.plotEngagement = raw;
    } else if (action.plotAligned === true) {
      action.plotEngagement = 'DIRECT';
    } else if (action.plotAligned === false) {
      action.plotEngagement = 'RELEVANT';
    } else {
      action.plotEngagement = 'UNRELATED';
    }
    action.plotAligned = action.plotEngagement === 'DIRECT';
  }
  return action;
}

function clampMonths(n, fallback = 1) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(12, v));
}

function appendText(old, extra) {
  const a = String(old || '').trim();
  const b = String(extra || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (a.includes(b)) return a;
  return `${a} ${b}`;
}

export function processIsFresh(action) {
  return Math.max(0, Number(action?.monthsDone) || 0) === 0;
}

/** Дело этого города, а не соседа. */
export function processOwnedBy(process, domainId) {
  if (!process || !domainId) return false;
  if (process.ownerDomainId) return String(process.ownerDomainId) === String(domainId);
  return true;
}

/**
 * Покровитель благословляет своё ещё идущее дело: при завершении исход будет критическим.
 */
export function blessProcess(process, { tick = null } = {}) {
  if (!process || typeof process !== 'object') return { ok: false, error: 'not_found' };
  normalizeProcess(process);
  if (process.status && process.status !== 'active') {
    return { ok: false, error: 'not_active', process };
  }
  if (process.blessed) return { ok: false, error: 'already_blessed', process };
  process.blessed = true;
  if (tick != null) process.blessedTick = tick;
  process.updatedAt = new Date().toISOString();
  return { ok: true, process };
}

export function pausedProcesses(domain, config = null) {
  normalizeDomainProcesses(domain, config);
  return (domain.state?.pendingActions || []).filter((a) => a.status === 'paused');
}

export function pauseProcess(process) {
  if (!process || typeof process !== 'object') return { ok: false, error: 'not_found' };
  normalizeProcess(process);
  if (process.status && process.status !== 'active') {
    return { ok: false, error: 'not_active', process };
  }
  process.status = 'paused';
  process.pausedAt = new Date().toISOString();
  process.updatedAt = process.pausedAt;
  return { ok: true, process };
}

export function resumeProcess(process, domain, config = null) {
  if (!process || typeof process !== 'object') return { ok: false, error: 'not_found' };
  normalizeProcess(process, config);
  if (process.status !== 'paused') return { ok: false, error: 'not_paused', process };
  const slots = canStartProcess(domain, config);
  if (!slots.ok) {
    return { ok: false, error: 'too_many_processes', active: slots.active, max: slots.max, process };
  }
  process.status = 'active';
  process.updatedAt = new Date().toISOString();
  return { ok: true, process };
}

/** Назначенный срок к честной оценке: <1 спешка, >1 обстоятельность. */
export function processPaceRatio(process) {
  const objective = Math.max(1, Number(process?.objectiveMonths || process?.expectedMonths || 1));
  const scheduled = Math.max(1, Number(process?.expectedMonths || objective));
  return scheduled / objective;
}

export function setRemainingMonths(action, remainingMonths) {
  const remaining = clampMonths(remainingMonths, 1);
  const done = Math.max(0, action.monthsDone || 0);
  action.monthsLeft = remaining;
  action.expectedMonths = done + remaining;
  action.durationMonths = action.expectedMonths;
  action.updatedAt = new Date().toISOString();
  return action;
}

export function applyObjectiveSchedule(action, objectiveMonths, remainingMonths = null) {
  action.objectiveMonths = clampMonths(objectiveMonths, 2);
  if (remainingMonths != null && Number.isFinite(Number(remainingMonths))) {
    setRemainingMonths(action, remainingMonths);
  } else if (processIsFresh(action)) {
    action.monthsLeft = action.objectiveMonths;
    action.expectedMonths = action.objectiveMonths;
    action.durationMonths = action.objectiveMonths;
  }
  action.updatedAt = new Date().toISOString();
  return action;
}

/**
 * Уточнить уже идущее дело.
 * Нулевой месяц — можно переписать целиком. Дальше только дополнить текст;
 * оставшийся срок менять можно, но не меньше одного месяца.
 */
export function reviseProcess(
  action,
  { summary, detail, addDetail, remainingMonths, linkedStats, characterNote, goal } = {},
  config = null,
) {
  normalizeProcess(action, config);
  const fresh = processIsFresh(action);
  if (fresh) {
    if (summary) action.summary = String(summary).trim();
    if (detail) action.detail = String(detail).trim();
    else if (addDetail) action.detail = appendText(action.detail, addDetail);
    if (characterNote !== undefined) action.characterNote = characterNote || null;
    if (linkedStats) {
      const linked = resolveLinkedStats(linkedStats, config);
      if (linked.length) action.linkedStats = linked;
    }
  } else {
    if (summary) action.summary = appendText(action.summary, summary);
    const extra = addDetail || detail;
    if (extra) action.detail = appendText(action.detail, extra);
    if (characterNote) action.characterNote = appendText(action.characterNote, characterNote);
    if (linkedStats) {
      const linked = resolveLinkedStats(linkedStats, config);
      if (linked.length) {
        action.linkedStats = [...new Set([...(action.linkedStats || []), ...linked])];
      }
    }
  }
  if (goal !== undefined) {
    const g = String(goal || '').trim().replace(/\s+/g, ' ');
    action.goal = g ? g.slice(0, 240) : null;
  }
  if (remainingMonths != null && Number.isFinite(Number(remainingMonths))) {
    setRemainingMonths(action, remainingMonths);
  }
  action.updatedAt = new Date().toISOString();
  normalizeProcess(action, config);
  return { action, fresh, rewritten: Boolean(fresh && (summary || detail)) };
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

// Бросок хода дела живёт в едином модуле бросков.
import {
  rollProcessAdvance,
  rollProcessFinish,
  FINISH_LABELS,
  FINISH_SHORT,
  formatFinishForPrompt,
} from './rolls.js';

export { rollProcessAdvance, rollProcessFinish, FINISH_LABELS, FINISH_SHORT, formatFinishForPrompt };

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

/**
 * Прогресс дел — целиком за движком: агент его не выбирает, только рассказывает.
 * Возвращает итоги месяца по каждому делу (что нужно обязательно описать).
 */
export function applyEngineProgress(domain, rolls, { tick = null, config = null, rng = Math.random } = {}) {
  const byId = new Map((domain.state?.pendingActions || []).map((a) => [a.id, a]));
  const outcomes = [];
  for (const r of rolls || []) {
    const process = byId.get(r.processId);
    if (!process || process.status !== 'active') continue;
    normalizeProcess(process, config);
    const before = process.monthsLeft;
    const { finished, monthsLeft } = applyProcessAdvance(process, r.advance, { tick });
    // След для правителя: как дело шло в последний месяц.
    process.lastAdvanceKind = r.kind;
    process.lastAdvance = r.advance;
    process.lastAdvanceTick = tick;
    let finish = null;
    let finishLabel = null;
    let blessed = Boolean(process.blessed);
    if (finished) {
      if (blessed) {
        finish = 'crit';
        finishLabel = FINISH_LABELS.blessed;
        process.finishKind = 'crit';
        process.finishBlessed = true;
        process.finishRoll = null;
        process.finishWeights = { fail: 0, ok: 0, crit: 100 };
      } else {
        const avg = processStatAverage(domain, process, config);
        const rolled = rollProcessFinish(avg, processPaceRatio(process), rng);
        finish = rolled.finish;
        finishLabel = FINISH_LABELS[finish];
        process.finishKind = finish;
        process.finishRoll = rolled.roll;
        process.finishWeights = rolled.weights;
      }
    }
    outcomes.push({
      processId: r.processId,
      summary: process.summary,
      detail: process.detail || '',
      goal: process.goal || null,
      linkedStats: [...(process.linkedStats || [])],
      kind: r.kind,
      advance: r.advance,
      monthsLeftBefore: before,
      monthsLeft,
      finished,
      finish,
      finishLabel,
      blessed,
      ownerDomainId: r.ownerDomainId || process.ownerDomainId || null,
      intel: Boolean(process.intel),
      plotlineId: process.plotlineId || null,
      plotEngagement: process.plotEngagement || null,
      plotAligned: process.plotEngagement === 'DIRECT' || process.plotAligned === true,
      // Обычный ход без завершения — фон, о нём отдельную запись не пишем.
      mustNarrate: finished || r.kind !== 'normal',
    });
  }
  return outcomes;
}

/** Что резолвер обязан описать по делам этого месяца, а что должен опустить. */
export function formatProcessOutcomesForPrompt(outcomes) {
  if (!outcomes?.length) return '(активных дел нет)';
  return outcomes
    .map((o) => {
      if (o.finished) {
        return (
          `- [${o.processId}] «${o.summary}» — ЗАВЕРШЕНО в этом месяце. ` +
          `Исход броска: ${formatFinishForPrompt(o.finish, { blessed: o.blessed })}.`
        );
      }
      if (o.kind === 'stall') {
        return (
          `- [${o.processId}] «${o.summary}» — ЗАСТОЙ: месяц прошёл без сдвига ` +
          `(осталось ~${o.monthsLeft} мес.). ОБЯЗАТЕЛЬНА запись: что именно помешало.`
        );
      }
      if (o.kind === 'surge') {
        return (
          `- [${o.processId}] «${o.summary}» — РЫВОК: сделано за два месяца вместо одного ` +
          `(осталось ~${o.monthsLeft} мес.). ОБЯЗАТЕЛЬНА запись: что позволило успеть.`
        );
      }
      return (
        `- [${o.processId}] «${o.summary}» — шло по расписанию (осталось ~${o.monthsLeft} мес.). ` +
        'Отдельную запись НЕ пиши.'
      );
    })
    .join('\n');
}

export function formatProcessLine(process, config = null) {
  normalizeProcess(process, config);
  const stats =
    process.linkedStats?.length > 0 ? process.linkedStats.join('+') : 'все статы';
  return (
    `- [${process.id}] ${process.summary}: ${process.detail || ''} ` +
    (process.goal ? `| цель: ${process.goal} ` : '') +
    `| ожидание ~${process.monthsLeft} мес. (оценка ${process.expectedMonths}) ` +
    `| статы: ${stats} (от ${process.onBehalfOf || process.characterName || '?'})` +
    (process.status === 'paused' ? ' | на паузе, слот свободен' : '') +
    (process.blessed ? ' | благословлено: исход будет [КРИТИЧЕСКИЙ УСПЕХ]' : '')
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

/** Как дело шло в прошлом месяце — словами, для речи правителя. */
export function processProgressFeel(process) {
  const kind = process?.lastAdvanceKind;
  if (kind === 'stall') return 'в прошлом месяце дело стояло';
  if (kind === 'surge') return 'в прошлом месяце продвинулись быстрее обычного';
  if (kind === 'normal') return 'идёт своим чередом, без задержек';
  return 'ход пока не проверяли';
}

function closedProcessOutcome(process) {
  if (process.finishBlessed || (process.blessed && process.finishKind === 'crit')) {
    return FINISH_LABELS.blessed;
  }
  if (process.finishKind && FINISH_LABELS[process.finishKind]) {
    return FINISH_LABELS[process.finishKind];
  }
  if (process.status === 'failed') return FINISH_LABELS.fail;
  if (process.status === 'cancelled') {
    return `свёрнуто (${process.cancelReason || 'без причины'})`;
  }
  if (process.status === 'resolved') return FINISH_LABELS.ok;
  return process.status;
}

/** Недавно закрытые дела: правитель должен помнить итог, а не «не знаю». */
export function recentlyClosedProcesses(domain, currentTick, { withinTicks = 2 } = {}) {
  const tick = Number(currentTick);
  return (domain.state?.pendingActions || [])
    .filter((a) => a.status && a.status !== 'active')
    .filter((a) => {
      if (!Number.isFinite(tick)) return false;
      const closed = Number(a.resolvedTick);
      return Number.isFinite(closed) && tick - closed <= withinTicks;
    })
    .map((a) => ({
      id: a.id,
      summary: a.summary,
      status: a.status,
      outcome: closedProcessOutcome(a),
    }));
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
 * Одна ли это работа. «Стройка храма» и «набор в храмовую стражу» делят предмет (храм),
 * но не род работы, поэтому дублем не считаются: у каждой стороны есть своя тема,
 * которой нет у другой.
 */
function sameWorkKind(a, b) {
  if (!a?.length || !b?.length) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  return a.every((k) => setB.has(k)) || b.every((k) => setA.has(k));
}

/**
 * Похожи ли по смыслу две короткие формулировки (дело, указ, порядок).
 * Подстрочного совпадения мало: «Открыть донабор в стражу» и «Продолжать донабор
 * в стражу» не пересекаются началами, но это одно и то же распоряжение.
 */
export function textsLookSame(a, b, { minShared = null } = {}) {
  const na = normProcessText(a);
  const nb = normProcessText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Для дел короткое вхождение ещё дубль. Для историй порог выше — подстроку не берём:
  // длинный синопсис всегда содержит кусок другого.
  if (minShared == null && Math.min(na.length, nb.length) >= 12 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }

  const ta = new Set(processTokens(na));
  const tb = new Set(processTokens(nb));
  if (!ta.size || !tb.size) return false;
  const shared = [...tb].filter((t) => ta.has(t));
  const need =
    minShared != null
      ? Math.max(1, Number(minShared) || 1)
      : Math.min(3, Math.max(2, Math.ceil(Math.min(ta.size, tb.size) * 0.5)));
  return shared.length >= need;
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
    const hayTokens = new Set(processTokens(hay));
    if (needleTokens.size && hayTokens.size) {
      const overlap = [...hayTokens].filter((t) => needleTokens.has(t));
      const need = Math.min(3, Math.max(2, Math.ceil(needleTokens.size * 0.45)));
      if (overlap.length >= need) return true;
    }
    // Общей темы мало: она бывает лишь предметом («храм»), а работы разные.
    if (needleThemes.length && sameWorkKind(needleThemes, hayThemes)) {
      const shared = [...hayTokens].filter((t) => needleTokens.has(t));
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
