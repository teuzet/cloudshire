/**
 * Дела через проход: ускорение, окно, сдвиг от чужого стата, исход на обрыв.
 */

import {
  shiftDurationBand,
  shiftDifficultyBand,
  rollDurationDays,
  normalizeDurationBand,
  DURATION_SPEC,
} from './bands.js';
import { remainingDockDays, confluxConfig, hoursToGameDays } from './confluxTime.js';
import { spanBandLabel } from './gameClock.js';

export function isCrossIslandDeed(process, conflux, domainId) {
  if (!process || !conflux || conflux.status !== 'docked') return false;
  if (process.crossIsland) return true;
  if (process.targetDomainId && String(process.targetDomainId) !== String(domainId)) return true;
  return false;
}

export function remainingWindowBand(conflux, day) {
  return spanBandLabel(remainingDockDays(conflux, day));
}

/**
 * После оценщика: ускорение, сдвиг от opposedStat, отказ если не влезает в окно.
 */
export function applyCrossIslandJudged(judged, {
  process,
  actor,
  target,
  conflux,
  day,
  config,
  rng = Math.random,
} = {}) {
  if (!judged || !conflux || conflux.status !== 'docked') return { judged, error: null };
  const cfg = confluxConfig(config);
  process.crossIsland = true;
  process.targetDomainId = target?.id || process.targetDomainId || null;
  process.confluxId = conflux.id;
  process.abortOutcome = process.abortOutcome || 'вернуться домой с тем, что успели';

  let durationBand = judged.durationBand;
  let difficulty = judged.difficulty;
  const remaining = remainingDockDays(conflux, day);

  const opposed = process.opposedStat || judged.opposedStat || null;
  if (opposed && actor && target) {
    const ownKey = (process.linkedStats || [])[0] || null;
    const ownRaw = ownKey != null ? actor.stats?.[ownKey] : 50;
    const own = Number.isFinite(Number(ownRaw)) ? Number(ownRaw) : 50;
    const theirs = Number.isFinite(Number(target.stats?.[opposed])) ? Number(target.stats[opposed]) : 50;
    const delta = own - theirs;
    if (delta <= -20) {
      durationBand = shiftDurationBand(durationBand, 1);
      difficulty = shiftDifficultyBand(difficulty, 1);
    } else if (delta >= 20) {
      durationBand = shiftDurationBand(durationBand, -1);
      difficulty = shiftDifficultyBand(difficulty, -1);
    }
  }

  let days = rollDurationDays(durationBand, rng);
  days = Math.max(1, Math.round(days / cfg.crossIslandSpeedup));
  if (days > remaining) {
    const down = shiftDurationBand(durationBand, -1);
    if (down !== durationBand) {
      durationBand = down;
      days = Math.max(1, Math.round(rollDurationDays(durationBand, rng) / cfg.crossIslandSpeedup));
    }
  }
  if (days > remaining) {
    return {
      judged,
      error: 'window',
      message: `До расхождения островов не успеть (${remainingWindowBand(conflux, day)}). Можно послать разведку, а не долгую работу.`,
    };
  }

  judged.durationBand = durationBand;
  judged.difficulty = difficulty;
  judged.objectiveDays = days;
  judged.officerDays = Math.max(judged.officerDays || 5, days);
  void hoursToGameDays;
  void DURATION_SPEC;
  void normalizeDurationBand;
  return { judged, error: null };
}

export function secretRevealTexts(process, finish) {
  const ok = finish === 'crit' || finish === 'success' || finish === 'ok';
  const summary = String(process?.summary || 'скрытое поручение');
  const actor =
    process?.actorOutcomeText ||
    (ok ? `Скрытое поручение «${summary}» удалось.` : `Скрытое поручение «${summary}» провалилось.`);
  const victim =
    process?.victimOutcomeText ||
    (ok
      ? `На острове случилось следствие, причины с этого берега не видно.`
      : `На острове поймали чужого человека у цели: «${summary}» не удалось скрыть.`);
  return { actor, victim, ok };
}
