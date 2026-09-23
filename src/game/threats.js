/**
 * Беды истории.
 *
 * У беды нет срока. Пул живёт одну стадию: пока шкала напряжения
 * не выберет одну и не приведёт её в исполнение. Последняя стадия
 * закрывает первопричину вместе с бедой.
 */

import { newId } from './ids.js';
import { maxFailsForGravity, parseFreeformGravity } from './plotlines.js';
import { hiddenAnswer, hiddenPremises, revealedAnswer, revealedPremises } from './premises.js';
import { threatConfig } from './pressure.js';

const SCALE_LADDER = ['SITUATION', 'EPISODE', 'CRISIS', 'RUPTURE'];

export function plotThreats(plot) {
  if (!plot) return [];
  if (!Array.isArray(plot.threats)) plot.threats = [];
  return plot.threats;
}

export function normalizeThreat(raw, plotId) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').trim();
  if (!text) return null;
  const status = ['live', 'fired', 'averted', 'cancelled'].includes(raw.status) ? raw.status : 'live';
  return {
    id: raw.id ? String(raw.id) : newId('thr'),
    plotId: String(raw.plotId || plotId || ''),
    text,
    stage: Math.max(0, Math.round(Number(raw.stage) || 0)),
    final: Boolean(raw.final),
    status,
    createdDay: raw.createdDay == null ? null : Math.round(Number(raw.createdDay) || 0),
    firedDay: raw.firedDay == null ? null : Math.round(Number(raw.firedDay) || 0),
    firedBy: raw.firedBy ? String(raw.firedBy) : null,
    avertedDay: raw.avertedDay == null ? null : Math.round(Number(raw.avertedDay) || 0),
    avertedBy: raw.avertedBy ? String(raw.avertedBy) : null,
    cancelledDay: raw.cancelledDay == null ? null : Math.round(Number(raw.cancelledDay) || 0),
    cancelReason: raw.cancelReason ? String(raw.cancelReason) : '',
  };
}

export function normalizePlotThreats(plot) {
  if (!plot) return plot;
  plot.threats = (Array.isArray(plot.threats) ? plot.threats : [])
    .map((t) => normalizeThreat(t, plot.id))
    .filter(Boolean);
  return plot;
}

export function liveThreats(plot) {
  return plotThreats(plot).filter((t) => t.status === 'live');
}

export function findThreat(plot, id) {
  const key = String(id || '');
  if (!key) return null;
  return plotThreats(plot).find((t) => t.id === key) || null;
}

export function livesLeft(plot) {
  const maxFails =
    plot?.maxFails == null || plot?.maxFails === ''
      ? maxFailsForGravity(plot?.gravity)
      : Math.max(0, Math.round(Number(plot.maxFails) || 0));
  const failCount = Math.max(0, Math.round(Number(plot?.failCount) || 0));
  return maxFails - failCount;
}

export function woundsExhausted(plot) {
  return livesLeft(plot) <= 0;
}

export function isFinalStage(plot) {
  return woundsExhausted(plot);
}

/**
 * Последняя стадия и глубины хватает на порог: сработавшая беда закроет историю
 * нейтрально. Какую из плохих взять, решает отдельный агент.
 */
export function neutralEndingDue(plot, config) {
  if (!plot || !isFinalStage(plot)) return false;
  const share = threatConfig(config).neutralDepthShare;
  const maxDepth = Math.max(1, Number(plot.maxDepth) || 1);
  return (Number(plot.depth) || 0) >= share * maxDepth;
}

/** Масштаб бед текущей стадии. Последняя стадия пишется масштабом самой истории. */
export function stageScale(plot) {
  const gravity = parseFreeformGravity(plot?.gravity);
  if (isFinalStage(plot)) return gravity;
  const stage = Math.max(0, Math.round(Number(plot?.stage ?? plot?.failCount) || 0));
  return SCALE_LADDER[Math.min(stage, SCALE_LADDER.length - 1)];
}

/**
 * Масштаб уже написанной беды.
 * После срабатывания стадия нити сдвигается, поэтому смотрим на саму беду,
 * а не на текущую стадию нити.
 */
export function firedThreatScale(plot, threat) {
  if (threat?.final) return parseFreeformGravity(plot?.gravity);
  const stage = Math.max(0, Math.round(Number(threat?.stage) || 0));
  return SCALE_LADDER[Math.min(stage, SCALE_LADDER.length - 1)];
}

export function stageThreatCount(plot, config, rng = Math.random) {
  const cfg = threatConfig(config);
  const span = cfg.perStage[parseFreeformGravity(plot?.gravity)] || cfg.perStage.EPISODE;
  const min = Math.max(1, Math.round(Number(span[0]) || 1));
  const max = Math.max(min, Math.round(Number(span[1]) || min));
  return min + Math.floor(rng() * (max - min + 1));
}

export function createThreat(plot, opts = {}) {
  if (plot && typeof plot.text === 'string' && (plot.plot || plot.band || plot.outcome)) {
    return createThreat(plot.plot || null, {
      text: plot.text,
      stage: plot.stage,
      final: plot.final ?? plot.finale ?? false,
      day: plot.day,
    });
  }
  const { text, stage = null, final = null, day = null } = opts;
  const threat = normalizeThreat(
    {
      text,
      stage: stage == null ? plot?.stage ?? 0 : stage,
      final: final == null ? isFinalStage(plot) : final,
      createdDay: day,
    },
    plot?.id,
  );
  return threat;
}

export function attachThreat(plot, threat) {
  if (!plot || !threat) return null;
  plotThreats(plot).push(threat);
  return threat;
}

/**
 * Заказ пула на текущую стадию. null, если живые беды этой стадии уже есть.
 */
export function stagePoolRequest(plot, { config, rng = Math.random } = {}) {
  if (!plot || plot.status === 'closed') return null;
  const stage = Math.max(0, Math.round(Number(plot.stage) || 0));
  if (liveThreats(plot).some((t) => t.stage === stage)) return null;
  return {
    stage,
    scale: stageScale(plot),
    final: isFinalStage(plot),
    count: stageThreatCount(plot, config, rng),
  };
}

export function cancelThreat(plot, threat, { day = null, reason = '' } = {}) {
  if (!threat || threat.status !== 'live') return { ok: false, reason: 'not_live' };
  threat.status = 'cancelled';
  threat.cancelledDay = day == null ? null : Math.round(Number(day) || 0);
  threat.cancelReason = String(reason || '').trim();
  return { ok: true };
}

/** Снять перечисленные беды. Возвращает те, что были живы. */
export function avertThreats(plot, ids, { day = null, by = null } = {}) {
  const averted = [];
  for (const id of ids || []) {
    const threat = findThreat(plot, id);
    if (!threat || threat.status !== 'live') continue;
    threat.status = 'averted';
    threat.avertedDay = day == null ? null : Math.round(Number(day) || 0);
    threat.avertedBy = by ? String(by) : null;
    averted.push(threat);
  }
  return averted;
}

/**
 * Привести беду в исполнение.
 * Не последняя стадия тратит жизнь и отменяет остальные беды пула.
 * Последняя закрывает историю: плохо, либо нейтрально, если глубины хватило.
 */
export function fireThreat(plot, threat, { day = null, firedBy = null, config = null } = {}) {
  if (!plot || !threat) return { ok: false, reason: 'not_found' };
  if (threat.status !== 'live') return { ok: false, reason: 'not_live' };
  threat.status = 'fired';
  threat.firedDay = day == null ? null : Math.round(Number(day) || 0);
  threat.firedBy = firedBy ? String(firedBy) : null;
  if (!isFinalStage(plot)) {
    plot.failCount = Math.round(Number(plot.failCount) || 0) + 1;
    plot.stage = Math.max(0, Math.round(Number(plot.stage) || 0)) + 1;
    for (const other of liveThreats(plot)) {
      cancelThreat(plot, other, { day, reason: 'стадия сменилась' });
    }
    return { ok: true, closes: false, livesLeft: livesLeft(plot), stage: plot.stage };
  }
  const neutral = neutralEndingDue(plot, config);
  plot.ending = {
    kind: neutral ? 'NEUTRAL_ENDING' : 'BAD_ENDING',
    threatId: threat.id,
    text: '',
    questionGone: '',
    nowDifferent: '',
  };
  return { ok: true, closes: true, endingKind: plot.ending.kind, livesLeft: livesLeft(plot) };
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
    hidden.length ? `СКРЫТО:\n${hidden.join('\n')}` : 'Скрытого слоя нет: город понимает, откуда идёт причина.',
    'В формулировке беды скрытый слой не сливай.',
  ].join('\n');
}
