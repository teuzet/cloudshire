/**
 * Угрозы — обязательства мира перед историей.
 *
 * Автотика больше нет. У живой истории всегда есть хотя бы один скрытый процесс
 * со сроком, который принадлежит истории, а не игроку. Он тикает сам, и именно
 * он рождает новые записи в хронике, если игрок не вмешался.
 *
 * Всё здесь — чистые функции над обычными объектами. Никаких вызовов моделей:
 * движок считает, агент говорит.
 */

import {
  normalizeThreatBand,
  rollThreatDays,
  shiftThreatBand,
  pickThreatBands,
  THREAT_SPEC,
  remainingBand,
} from './bands.js';
import { maxFailsForGravity, parseFreeformGravity } from './plotlines.js';
import { hiddenAnswer, hiddenPremises, revealedAnswer, revealedPremises } from './premises.js';

export const THREAT_OUTCOMES = ['harm', 'neutral'];

/** Промежуточный удар или исход истории. Старые четыре слова больше не живой словарь. */
export const THREAT_STAGES = ['interim', 'finale'];

const LEGACY_SEVERITY_STAGE = {
  ТРЕВОГА: 'interim',
  УЩЕРБ: 'interim',
  УТРАТА: 'interim',
  КАТАСТРОФА: 'finale',
};

/** Сколько угроз история держит одновременно. */
export const GRAVITY_THREAT_SLOTS = {
  SITUATION: 1,
  EPISODE: 1,
  CRISIS: 2,
  RUPTURE: 3,
};

/** Неизвестная угроза всплывает сама, когда прошло больше трёх четвертей срока. */
export const SURFACE_AT_REMAINING_SHARE = 0.25;

/** Замедление после успешной защиты и потолок этого замедления. */
export const DEFENSE_SLOWDOWN_CAP = 'YEAR';
export const MAX_DEFENSE_SLOWDOWN = 3;

// ──────────────────────────── жизни и тяжесть ────────────────────────────

export function livesLeft(plot) {
  const maxFails =
    plot?.maxFails == null || plot?.maxFails === ''
      ? maxFailsForGravity(plot?.gravity)
      : Math.max(0, Math.round(Number(plot.maxFails) || 0));
  const failCount = Math.max(0, Math.round(Number(plot?.failCount) || 0));
  return maxFails - failCount;
}

/** Запас ран кончился: новые обязательства — только финальные, к плохой карточке. */
export function woundsExhausted(plot) {
  return livesLeft(plot) <= 0;
}

export function plotBadEndings(plot) {
  return (plot?.endings || []).filter((e) => e && e.kind === 'BAD_ENDING');
}

export function pickBadEnding(plot, rng = Math.random) {
  const list = plotBadEndings(plot);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

export function liveFinaleThreats(plot) {
  return liveThreats(plot).filter((t) => {
    if (!t?.endingId) return false;
    const ending = (plot?.endings || []).find((e) => String(e.id) === String(t.endingId));
    return !ending || ending.kind === 'BAD_ENDING';
  });
}

function maxFailsOf(plot) {
  if (plot?.maxFails == null || plot?.maxFails === '') return maxFailsForGravity(plot?.gravity);
  return Math.max(0, Math.round(Number(plot.maxFails) || 0));
}

/** Доля пути, которая ещё осталась до плохой карточки. 0 — это уже исход. */
export function remainingToBadEndingPct(plot) {
  const maxFails = maxFailsOf(plot);
  const left = livesLeft(plot);
  if (maxFails <= 0 || left <= 0) return 0;
  return Math.max(1, Math.round((100 * left) / maxFails));
}

export function threatStageForPlot(plot) {
  return livesLeft(plot) <= 0 ? 'finale' : 'interim';
}

export function formatKnownUnknown(plot) {
  const known = [
    plot?.synopsis ? `Наблюдаемый слой: ${plot.synopsis}` : '',
    revealedAnswer(plot) ? `Город уже знает разгадку: ${revealedAnswer(plot)}` : '',
    ...(revealedPremises(plot) || []).map((item) => `Город выяснил: ${item}`),
  ].filter(Boolean);
  const hidden = [
    hiddenAnswer(plot) ? `Разгадка (город не знает): ${hiddenAnswer(plot)}` : '',
    ...(hiddenPremises(plot) || []).map((item) => `Скрытый подступ: ${item}`),
  ].filter(Boolean);
  return [
    'ИЗВЕСТНОЕ И НЕИЗВЕСТНОЕ',
    known.length ? known.join('\n') : 'Город видит только то, что уже записано в хронике.',
    hidden.length
      ? `СКРЫТО:\n${hidden.join('\n')}`
      : 'Скрытого слоя нет: город понимает, откуда идёт причина.',
    'known=true — эту беду город уже может назвать своими словами, без разгадки.',
    'known=false — беда следует из скрытого или город ещё не видит, откуда удар.',
    'В формулировке известной беды скрытый слой не сливай.',
  ].join('\n');
}

export function formatWoundGuidance(plot) {
  const gravity = parseFreeformGravity(plot?.gravity);
  const stage = threatStageForPlot(plot);
  if (stage === 'finale') {
    return {
      stage,
      remainingPct: 0,
      guidance:
        `Это исход истории, не промежуточный удар. Масштаб — ${gravity}: ` +
        'пиши событие, которым город необратимо лишается того, из-за чего вопрос стоял. ' +
        'Не «стало хуже» — предмета спора после этого нет.',
    };
  }
  const pct = remainingToBadEndingPct(plot);
  return {
    stage,
    remainingPct: pct,
    guidance:
      `Промежуточный удар. До плохой концовки ещё ${pct}%. ` +
      `Тяжесть — относительно ${gravity}, не абсолютный конец города. ` +
      'Анти-таргет ниже — до него доходить нельзя.',
  };
}

export function threatSlots(plot) {
  const gravity = parseFreeformGravity(plot?.gravity);
  return GRAVITY_THREAT_SLOTS[gravity] ?? 1;
}

/**
 * Сколько угроз должно висеть сейчас.
 * Хотя бы одна всегда: у ситуации с нулём жизней первая же угроза — исход.
 */
export function targetThreatCount(plot) {
  const lives = livesLeft(plot);
  return Math.max(1, Math.min(threatSlots(plot), lives));
}

// ───────────────────────────── список угроз ─────────────────────────────

export function plotThreats(plot) {
  return Array.isArray(plot?.threats) ? plot.threats : [];
}

export function liveThreats(plot) {
  return plotThreats(plot).filter((t) => t && t.status === 'live');
}

export function liveHarmThreats(plot) {
  return liveThreats(plot).filter((t) => t.outcome !== 'neutral');
}

export function liveResolutions(plot) {
  return liveThreats(plot).filter((t) => t.outcome === 'neutral');
}

export function findThreat(plot, threatId) {
  return plotThreats(plot).find((t) => t && t.id === threatId) || null;
}

export function remainingDays(threat, day) {
  return Math.max(0, Math.round(Number(threat?.dueDay) || 0) - Math.round(Number(day) || 0));
}

export function nearestThreat(plot, day) {
  let best = null;
  for (const t of liveThreats(plot)) {
    if (!best || remainingDays(t, day) < remainingDays(best, day)) best = t;
  }
  return best;
}

let threatCounter = 0;

function nextThreatId(plotId) {
  threatCounter += 1;
  return `thr_${String(plotId || 'plot').replace(/[^a-zA-Z0-9_]/g, '')}_${Date.now().toString(36)}_${threatCounter}`;
}

/**
 * Завести угрозу. Полосу и текст даёт автор; срок бросает код.
 * Видимость решает автор беды (`known`); без ответа считаем беду видимой.
 */
export const THREAT_VALENCES = ['good', 'neutral', 'bad'];

export function normalizeValence(raw, { outcome = 'harm' } = {}) {
  const key = String(raw || '').trim().toLowerCase();
  if (THREAT_VALENCES.includes(key)) return key;
  return outcome === 'neutral' ? 'neutral' : 'bad';
}

export function createThreat({
  plot,
  text = '',
  band = 'SEASON',
  day = 0,
  outcome = 'harm',
  known = null,
  slowdown = 0,
  rng = Math.random,
  dueDay = null,
  endingId = null,
  valence = null,
  eventKind = null,
  stage = null,
  remainingPct = null,
} = {}) {
  const effectiveBand = shiftThreatBand(normalizeThreatBand(band), Math.max(0, Math.round(slowdown)));
  const rolledDays = Math.max(1, rollThreatDays(effectiveBand, rng));
  const created = Math.round(Number(day) || 0);
  const resolvedDue = dueDay != null ? Math.round(Number(dueDay)) : created + rolledDays;
  const totalDays = Math.max(1, dueDay != null ? resolvedDue - created : rolledDays);
  const isNeutral = outcome === 'neutral' || valence === 'neutral';
  const resolvedValence = normalizeValence(valence, { outcome: isNeutral ? 'neutral' : outcome });
  const wound = isNeutral ? { stage: null, remainingPct: null } : formatWoundGuidance(plot);
  const resolvedStage = isNeutral
    ? null
    : THREAT_STAGES.includes(stage)
      ? stage
      : wound.stage;
  const visible = isNeutral ? true : known == null ? true : !!known;
  return {
    id: nextThreatId(plot?.id),
    plotId: plot?.id || null,
    text: String(text || '').trim().slice(0, 400),
    band: effectiveBand,
    totalDays,
    dueDay: resolvedDue,
    createdDay: created,
    stage: resolvedStage,
    remainingPct: isNeutral
      ? null
      : remainingPct == null
        ? wound.remainingPct
        : Math.max(0, Math.round(Number(remainingPct) || 0)),
    known: visible,
    outcome: isNeutral ? 'neutral' : 'harm',
    valence: resolvedValence,
    endingId: endingId ? String(endingId) : null,
    eventKind: eventKind ? String(eventKind) : null,
    status: 'live',
    firedBy: null,
  };
}

export function attachThreat(plot, threat) {
  if (!plot || !threat) return threat;
  if (!Array.isArray(plot.threats)) plot.threats = [];
  plot.threats.push(threat);
  return threat;
}

// ──────────────────────────────── видимость ────────────────────────────────

/** Неизвестная угроза открывается сама, когда до срока осталась четверть пути. */
export function surfaceOverdueThreats(plot, day) {
  const surfaced = [];
  for (const t of liveThreats(plot)) {
    if (t.known) continue;
    const share = remainingDays(t, day) / Math.max(1, t.totalDays);
    if (share < SURFACE_AT_REMAINING_SHARE) {
      t.known = true;
      t.surfacedDay = Math.round(Number(day) || 0);
      surfaced.push(t);
    }
  }
  return surfaced;
}

export function revealThreat(threat, day) {
  if (!threat || threat.known) return false;
  threat.known = true;
  threat.surfacedDay = Math.round(Number(day) || 0);
  return true;
}

/** Что жрец может сказать вслух про известные угрозы: формулировка и полоса остатка. */
export function knownThreatsForSpeech(plot, day) {
  return liveThreats(plot)
    .filter((t) => t.known)
    .map((t) => {
      const ending = t.endingId
        ? (plot?.endings || []).find((e) => String(e.id) === String(t.endingId))
        : null;
      return {
        id: t.id,
        text: t.text,
        remainingBand: remainingBand(remainingDays(t, day)),
        kind: t.outcome === 'neutral' ? 'разрешение' : ending ? 'финал' : 'угроза',
        endingId: t.endingId || null,
        endingText: ending?.text || null,
      };
    })
    .sort((a, b) => remainingDays(findThreat(plot, a.id), day) - remainingDays(findThreat(plot, b.id), day));
}

/** Ближайшая известная беда (без нейтральных разрешений) — движку, с днями. */
export function nearestKnownDanger(plot, day) {
  let best = null;
  for (const t of liveThreats(plot)) {
    if (!t.known || t.outcome === 'neutral') continue;
    if (!best || remainingDays(t, day) < remainingDays(best, day)) best = t;
  }
  return best;
}

// ──────────────────────────── срабатывание ────────────────────────────

/**
 * Отсрочка выжившим угрозам: каждой прибавляется исходная длительность
 * сработавшей, но не выше её собственного стартового срока. Это не окно тишины,
 * а модификация счётчиков: город разгребает одну беду, остальные ждут.
 */
export function deferSurvivors(plot, firedThreat, day) {
  const bonus = Math.max(0, Math.round(Number(firedThreat?.totalDays) || 0));
  const changed = [];
  for (const t of liveThreats(plot)) {
    if (t.id === firedThreat?.id) continue;
    const before = t.dueDay;
    const cap = Math.round(Number(day) || 0) + t.totalDays;
    t.dueDay = Math.min(cap, t.dueDay + bonus);
    if (t.dueDay !== before) changed.push({ id: t.id, from: before, to: t.dueDay });
  }
  return changed;
}

/**
 * Срабатывание угрозы. Возвращает решение для планировщика; запись в хронику
 * и текст события делает рассказчик.
 */
function endingForThreat(plot, threat) {
  if (String(threat?.eventKind || '') === 'dock_meet') return null;
  const id = String(threat?.endingId || '').trim();
  if (id) {
    const found = (plot?.endings || []).find((e) => String(e.id) === id);
    if (found) return found;
    return { id, kind: 'BAD_ENDING', text: threat.text };
  }
  if (threat?.outcome === 'neutral') {
    return { id: null, kind: 'NEUTRAL_ENDING', text: threat.text };
  }
  return null;
}

export function fireThreat(plot, threat, { day = 0, firedBy = null } = {}) {
  if (!plot || !threat || threat.status !== 'live') {
    return { ok: false, reason: 'not_live' };
  }
  threat.status = 'fired';
  threat.firedDay = Math.round(Number(day) || 0);
  threat.firedBy = firedBy || null;

  if (String(threat.eventKind || '') === 'dock_meet') {
    return {
      ok: true,
      kind: 'event',
      closes: false,
      stage: null,
      remainingPct: null,
      endingKind: null,
      deferred: [],
    };
  }

  const linked = endingForThreat(plot, threat);
  if (linked) {
    plot.ending = {
      kind: linked.kind || 'NEUTRAL_ENDING',
      text: linked.text || threat.text,
      threatId: threat.id,
      endingId: linked.id || threat.endingId || null,
    };
    return {
      ok: true,
      kind: linked.kind === 'BAD_ENDING' ? 'threat' : 'resolution',
      stage: null,
      remainingPct: null,
      closes: true,
      endingKind: plot.ending.kind,
      deferred: [],
    };
  }

  plot.failCount = Math.max(0, Math.round(Number(plot.failCount) || 0)) + 1;
  const lives = livesLeft(plot);
  const deferred = deferSurvivors(plot, threat, day);
  return {
    ok: true,
    kind: 'threat',
    stage: threat.stage || 'interim',
    remainingPct: threat.remainingPct ?? remainingToBadEndingPct(plot),
    closes: false,
    endingKind: null,
    livesLeft: lives,
    deferred,
  };
}

// ──────────────────────────── снятие и защита ────────────────────────────

/** Угроза снята успешным делом игрока. Это защита, она считается. */
export function defendThreat(plot, threat, { day = 0, by = null } = {}) {
  if (!plot || !threat || threat.status !== 'live') return { ok: false, reason: 'not_live' };
  threat.status = 'averted';
  threat.avertedDay = Math.round(Number(day) || 0);
  threat.avertedBy = by || null;
  plot.defenseCount = Math.max(0, Math.round(Number(plot.defenseCount) || 0)) + 1;
  return { ok: true, defenseCount: plot.defenseCount };
}

/**
 * Угроза снята агентом разбора — потеряла смысл, а не была отбита.
 * Защитой не считается: иначе разбор был бы бесплатным способом гасить историю.
 */
export function cancelThreat(plot, threat, { day = 0, reason = '' } = {}) {
  if (!plot || !threat || threat.status !== 'live') return { ok: false, reason: 'not_live' };
  threat.status = 'cancelled';
  threat.cancelledDay = Math.round(Number(day) || 0);
  threat.cancelReason = String(reason || '').slice(0, 200);
  return { ok: true };
}

export const RECONCILE_DELAY_FACTOR = 1.5;

/** Отсрочка угрозы по вердикту разбора. */
export function delayThreat(threat, { day = 0, factor = RECONCILE_DELAY_FACTOR } = {}) {
  if (!threat || threat.status !== 'live') return { ok: false, reason: 'not_live' };
  const bonus = Math.round(Math.max(0, Number(threat.totalDays) || 0) * factor);
  threat.dueDay += bonus;
  threat.delayedDays = Math.max(0, Number(threat.delayedDays) || 0) + bonus;
  return { ok: true, bonus, dueDay: threat.dueDay };
}

/** DANGEROUS-дело: остаток срезается наполовину исходной длительности. */
export function hastenThreat(threat, { day = 0 } = {}) {
  if (!threat || threat.status !== 'live') return { ok: false, reason: 'not_live' };
  const cut = Math.round(Math.max(0, Number(threat.totalDays) || 0) / 2);
  const now = Math.round(Number(day) || 0);
  threat.dueDay = Math.max(now, threat.dueDay - cut);
  return { ok: true, cut, dueDay: threat.dueDay, dueNow: threat.dueDay <= now };
}

/** Крит RELEVANT: другой угрозе добавляется половина её исходного срока. */
export function reprieveThreat(threat) {
  if (!threat || threat.status !== 'live') return { ok: false, reason: 'not_live' };
  const bonus = Math.round(Math.max(0, Number(threat.totalDays) || 0) / 2);
  threat.dueDay += bonus;
  return { ok: true, bonus, dueDay: threat.dueDay };
}

// ──────────────────────── затухание и разрешение ────────────────────────

export function defenseCount(plot) {
  return Math.max(0, Math.round(Number(plot?.defenseCount) || 0));
}

/**
 * Каждая успешная защита делает следующую угрозу на ступень медленнее.
 * Город, который научился держать беду, получает передышку, а не бесконечную
 * карусель одинаково быстрых угроз.
 */
export function defenseSlowdown(plot) {
  return Math.min(MAX_DEFENSE_SLOWDOWN, defenseCount(plot));
}

/**
 * Шанс, что вместо очередной угрозы движок поставит разрешение —
 * нейтральную концовку с обратным отсчётом. Это выход из «бей крота»:
 * оборона в итоге приводит к тому, что беда просто выдыхается.
 */
export function resolutionChance(plot) {
  const depth = Math.max(0, Number(plot?.depth) || 0);
  const maxDepth = Math.max(0.01, Number(plot?.maxDepth) || 1);
  if (depth >= maxDepth) return 1;
  const defenses = defenseCount(plot);
  if (defenses < 2) return 0;
  let p = Math.min(0.9, 0.25 * (defenses - 1));
  if (depth === 0) p *= 0.5;
  return p;
}

/**
 * Чего движок хочет от автора: новую угрозу или разрешение.
 * Решает код — у автора нет права выбирать, чем кончится история.
 */
export function nextObligationRequest(plot, { day = 0, rng = Math.random } = {}) {
  const live = liveThreats(plot);
  if (liveResolutions(plot).length) return null;

  const used = live.map((t) => t.band);
  const gravity = parseFreeformGravity(plot?.gravity);
  const [band] = pickThreatBands(1, rng, { gravity });
  const existing = live.map((t) => ({
    text: t.text,
    remainingBand: remainingBand(remainingDays(t, day)),
    known: Boolean(t.known),
  }));
  const depth = Math.max(0, Number(plot?.depth) || 0);
  const maxDepth = Math.max(0.01, Number(plot?.maxDepth) || 1);
  const knownUnknown = formatKnownUnknown(plot);

  if (woundsExhausted(plot)) {
    if (liveFinaleThreats(plot).length) return null;
    if (depth >= maxDepth) {
      return {
        plotId: plot?.id || null,
        outcome: 'neutral',
        finale: false,
        endingId: null,
        band: shiftThreatBand(band, 1),
        slowdown: 0,
        stage: null,
        remainingPct: null,
        woundGuidance: null,
        antiTarget: null,
        endingText: null,
        known: true,
        livesLeft: livesLeft(plot),
        existingThreats: existing,
        usedBands: used,
        knownUnknown,
      };
    }
    const ending = pickBadEnding(plot, rng);
    const wound = formatWoundGuidance(plot);
    return {
      plotId: plot?.id || null,
      outcome: 'harm',
      finale: true,
      endingId: ending?.id || null,
      endingText: ending?.text || null,
      endingQuestionGone: ending?.questionGone || null,
      endingNowDifferent: ending?.nowDifferent || null,
      band,
      slowdown: 0,
      stage: wound.stage,
      remainingPct: wound.remainingPct,
      woundGuidance: wound.guidance,
      antiTarget: ending?.text || null,
      known: null,
      livesLeft: livesLeft(plot),
      existingThreats: existing,
      usedBands: used,
      knownUnknown,
    };
  }

  const target = targetThreatCount(plot);
  if (live.length >= target) return null;

  const wantsResolution = rng() < resolutionChance(plot);
  const slowdown = defenseSlowdown(plot);
  const wound = wantsResolution ? null : formatWoundGuidance(plot);
  const badEnding = plotBadEndings(plot)[0];

  return {
    plotId: plot?.id || null,
    outcome: wantsResolution ? 'neutral' : 'harm',
    finale: false,
    endingId: null,
    band: wantsResolution ? shiftThreatBand(band, 1) : band,
    slowdown: wantsResolution ? 0 : slowdown,
    stage: wantsResolution ? null : wound.stage,
    remainingPct: wantsResolution ? null : wound.remainingPct,
    woundGuidance: wantsResolution ? null : wound.guidance,
    antiTarget: wantsResolution ? null : badEnding?.text || null,
    endingText: null,
    known: wantsResolution ? true : null,
    livesLeft: livesLeft(plot),
    existingThreats: existing,
    usedBands: used,
    knownUnknown,
  };
}

/**
 * Дозаполнить обязательства истории до нормы. `author` получает заявку и
 * возвращает `{ text }`; если автора нет, ставится обязательство без текста —
 * рассказчик придумает формулировку на срабатывании.
 */
export function replenishThreats(plot, { day = 0, rng = Math.random, author = null } = {}) {
  const created = [];
  let guard = 0;
  while (guard < 4) {
    guard += 1;
    const req = nextObligationRequest(plot, { day, rng });
    if (!req) break;
    const drafted = author ? author(req) : null;
    const threat = createThreat({
      plot,
      text: drafted?.text || req.antiTarget || '',
      band: drafted?.band || req.band,
      outcome: req.outcome,
      slowdown: req.slowdown,
      known: req.outcome === 'neutral' ? true : drafted?.known ?? req.known,
      endingId: req.endingId || null,
      valence: req.finale ? 'bad' : req.outcome === 'neutral' ? 'neutral' : 'bad',
      stage: req.stage,
      remainingPct: req.remainingPct,
      day,
      rng,
    });
    attachThreat(plot, threat);
    created.push(threat);
  }
  return created;
}

// ───────────────────────────── нормализация ─────────────────────────────

export function normalizeThreat(raw, plotId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const band = normalizeThreatBand(raw.band);
  const totalDays = Math.max(1, Math.round(Number(raw.totalDays) || THREAT_SPEC[band].min));
  const status = ['live', 'fired', 'averted', 'cancelled'].includes(raw.status) ? raw.status : 'live';
  const outcome = raw.outcome === 'neutral' ? 'neutral' : 'harm';
  const stage = THREAT_STAGES.includes(raw.stage)
    ? raw.stage
    : LEGACY_SEVERITY_STAGE[String(raw.severity || '').trim().toUpperCase()] || (outcome === 'neutral' ? null : 'interim');
  const remainingPct =
    outcome === 'neutral' || stage === 'finale'
      ? stage === 'finale'
        ? 0
        : null
      : raw.remainingPct == null
        ? null
        : Math.max(0, Math.round(Number(raw.remainingPct) || 0));
  return {
    id: String(raw.id || nextThreatId(plotId)),
    plotId: raw.plotId || plotId || null,
    text: String(raw.text || '').slice(0, 400),
    band,
    totalDays,
    dueDay: Math.round(Number(raw.dueDay) || 0),
    createdDay: Math.round(Number(raw.createdDay) || 0),
    stage: outcome === 'neutral' ? null : stage,
    remainingPct,
    known: outcome === 'neutral' ? true : !!raw.known,
    outcome,
    valence: normalizeValence(raw.valence, { outcome }),
    endingId: raw.endingId ? String(raw.endingId) : null,
    status,
    firedBy: raw.firedBy || null,
    ...(raw.surfacedDay != null ? { surfacedDay: Math.round(Number(raw.surfacedDay)) } : {}),
    ...(raw.delayedDays != null ? { delayedDays: Math.max(0, Math.round(Number(raw.delayedDays))) } : {}),
  };
}

export function normalizePlotThreats(plot) {
  if (!plot || typeof plot !== 'object') return plot;
  const list = Array.isArray(plot.threats) ? plot.threats : [];
  plot.threats = list.map((t) => normalizeThreat(t, plot.id)).filter(Boolean);
  plot.defenseCount = defenseCount(plot);
  return plot;
}
