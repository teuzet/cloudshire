/**
 * Front: постепенный процесс к ставке.
 * Прогресс ленивый: хранится вместе с днём пересчёта и скоростью.
 */

import { newId } from '../game/ids.js';
import { activeAssignmentsForFront } from './assignment.js';
import {
  beatThresholds,
  driftPerDay,
  officerRate,
  parseDriftBand,
} from './scales.js';

const STATUSES = ['active', 'resolved', 'invalid'];
const EVENT_STATUSES = ['live', 'blocked', 'fired'];
const CLUE_STATUSES = ['hidden', 'revealed'];

function clipText(raw) {
  return String(raw || '').trim();
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const description = clipText(raw.description);
  if (!description) return null;
  const status = EVENT_STATUSES.includes(raw.status) ? raw.status : 'live';
  return {
    id: clipText(raw.id) || newId('evt'),
    description,
    status,
  };
}

function normalizeClue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fact = clipText(raw.fact);
  if (!fact) return null;
  const status = CLUE_STATUSES.includes(raw.status) ? raw.status : 'hidden';
  return {
    id: clipText(raw.id) || newId('clu'),
    fact,
    alignment: clipText(raw.alignment),
    status,
  };
}

export function normalizeFront(raw, config = null) {
  if (!raw || typeof raw !== 'object') return null;
  const description = clipText(raw.description);
  if (!description) return null;
  const effort = Math.max(0, Number(raw.effort) || 0);
  const progress = Math.max(0, Math.min(effort, Number(raw.progress) || 0));
  const beatCount = Math.max(0, Math.round(Number(raw.beatCount) || 0));
  const beatsFired = [...new Set(
    (Array.isArray(raw.beatsFired) ? raw.beatsFired : [])
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n >= 0 && n < beatCount),
  )];
  return {
    id: clipText(raw.id) || newId('front'),
    description,
    stake: raw.stake && typeof raw.stake === 'object' ? raw.stake : null,
    effort,
    progress,
    progressDay: Math.max(0, Math.round(Number(raw.progressDay) || 0)),
    driftBand: config ? parseDriftBand(config, raw.driftBand) : clipText(raw.driftBand).toUpperCase() || 'NONE',
    ratePerDay: Number.isFinite(Number(raw.ratePerDay)) ? Number(raw.ratePerDay) : 0,
    beatCount,
    beatsFired,
    events: (Array.isArray(raw.events) ? raw.events : []).map(normalizeEvent).filter(Boolean),
    clues: (Array.isArray(raw.clues) ? raw.clues : []).map(normalizeClue).filter(Boolean),
    alignment: clipText(raw.alignment),
    refs: [...new Set((Array.isArray(raw.refs) ? raw.refs : []).map((id) => clipText(id)).filter(Boolean))],
    pendingConsequences: Array.isArray(raw.pendingConsequences) ? raw.pendingConsequences : [],
    status: STATUSES.includes(raw.status) ? raw.status : 'active',
    createdDay: Math.max(0, Math.round(Number(raw.createdDay) || 0)),
    resolvedDay: raw.resolvedDay == null ? null : Math.max(0, Math.round(Number(raw.resolvedDay) || 0)),
  };
}

export function normalizeFronts(list, config = null) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => normalizeFront(item, config)).filter(Boolean);
}

export function createFront(config, {
  id = null,
  description,
  stake = null,
  effort = 0,
  driftBand = 'NONE',
  beatCount = 0,
  events = [],
  clues = [],
  alignment = '',
  refs = [],
  pendingConsequences = [],
  day = 0,
} = {}) {
  return normalizeFront({
    id,
    description,
    stake,
    effort,
    progress: 0,
    progressDay: day,
    driftBand,
    ratePerDay: driftPerDay(config, driftBand),
    beatCount,
    beatsFired: [],
    events,
    clues,
    alignment,
    refs,
    pendingConsequences,
    status: 'active',
    createdDay: day,
  }, config);
}

export function progressAt(front, day) {
  if (!front) return 0;
  const elapsed = Math.max(0, Math.round(Number(day) || 0) - Math.round(Number(front.progressDay) || 0));
  const raw = (Number(front.progress) || 0) + (Number(front.ratePerDay) || 0) * elapsed;
  const effort = Math.max(0, Number(front.effort) || 0);
  return Math.max(0, Math.min(effort, raw));
}

export function settleProgress(front, day) {
  if (!front) return 0;
  front.progress = progressAt(front, day);
  front.progressDay = Math.max(0, Math.round(Number(day) || 0));
  return front.progress;
}

export function recomputeRate(config, front, domain, day) {
  if (!front) return 0;
  settleProgress(front, day);
  let rate = driftPerDay(config, front.driftBand);
  for (const assignment of activeAssignmentsForFront(domain, front.id)) {
    const officer = (domain?.officers || []).find((item) => item && String(item.id) === String(assignment.officerId));
    const statId = officer?.statId;
    const stat = statId ? Number(domain?.stats?.[statId]) || 0 : 0;
    rate += officerRate(config, {
      stat,
      efficiency: assignment.efficiency,
      direction: assignment.direction,
    });
  }
  front.ratePerDay = rate;
  return rate;
}

export function pendingThresholds(front) {
  if (!front) return [];
  const fired = new Set(front.beatsFired || []);
  return beatThresholds(front.effort, front.beatCount).filter((_, index) => !fired.has(index));
}

export function nextEventDay(front) {
  if (!front || !(front.ratePerDay > 0)) return null;
  if (front.status && front.status !== 'active') return null;
  const candidates = pendingThresholds(front);
  if (front.progress < front.effort) candidates.push(front.effort);
  const ahead = candidates.filter((value) => value > front.progress + 1e-9);
  if (!ahead.length) return null;
  const target = Math.min(...ahead);
  const days = Math.ceil((target - front.progress) / front.ratePerDay - 1e-9);
  return front.progressDay + Math.max(0, days);
}

export function nextEventKind(front) {
  if (!front || !(front.ratePerDay > 0)) return null;
  const thresholds = pendingThresholds(front).filter((value) => value > front.progress + 1e-9);
  const nextBeat = thresholds.length ? Math.min(...thresholds) : null;
  if (nextBeat != null && nextBeat < front.effort) return 'front_beat';
  if (front.progress < front.effort) return 'front_stake';
  return null;
}

export function activeFronts(domain) {
  return (domain?.fronts || []).filter((front) => front && front.status === 'active');
}

export function findFront(domain, id) {
  const needle = String(id || '');
  return (domain?.fronts || []).find((front) => front && String(front.id) === needle) || null;
}
