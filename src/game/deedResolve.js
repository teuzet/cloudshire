/**
 * Что делает с историей завершившееся дело.
 *
 * Возвращает описание последствий; писать хронику и говорить с игроком —
 * не здесь. Единственный источник правды о том, как исход дела двигает нить.
 */

import { depthGain, closesPlot } from './deedMath.js';
import { alignmentOf } from './deedAlign.js';
import { revealPremise, revealNextPremise } from './premises.js';
import {
  findThreat,
  liveThreats,
  liveHarmThreats,
  defendThreat,
  hastenThreat,
  reprieveThreat,
  fireThreat,
  revealThreat,
  livesLeft,
  severityForLives,
} from './threats.js';

export const CRIT_CASCADE_STEPS = ['reveal', 'reprieve', 'restore_life', 'depth'];

/**
 * Каскад крита на RELEVANT-деле. Детерминированный, срабатывает ровно один пункт.
 * Порядок от самого информативного к самому скучному: сначала знание,
 * потом время, потом жизнь, и только если нечего дать — чуть глубины.
 */
export function critCascade(plot, threat, { day = 0 } = {}) {
  const others = liveThreats(plot).filter((t) => t.id !== threat?.id);

  const hidden = others.find((t) => !t.known);
  if (hidden && revealThreat(hidden, day)) {
    return { step: 'reveal', threatId: hidden.id, text: hidden.text };
  }

  const other = others[0];
  if (other) {
    const res = reprieveThreat(other);
    if (res.ok) return { step: 'reprieve', threatId: other.id, bonusDays: res.bonus };
  }

  if (Math.max(0, Math.round(Number(plot?.failCount) || 0)) > 0) {
    plot.failCount -= 1;
    return { step: 'restore_life', livesLeft: livesLeft(plot) };
  }

  plot.depth = Math.round((Number(plot.depth) || 0) * 100 + 50) / 100;
  return { step: 'depth', depthGain: 0.5 };
}

/**
 * Какая именно хорошая концовка сыграла.
 *
 * Дело не обязано целиться в конкретную концовку: глубину набирают чем угодно.
 * Но без ссылки на концовку финальную запись не к чему привязать — она не знает
 * ни чем снят вопрос, ни что в городе теперь иначе.
 */
function pickGoodEndingId(plot, process) {
  const aimed = String(process?.endingId || '').trim();
  if (aimed) return aimed;
  const good = (plot?.endings || []).find((e) => e.kind === 'GOOD_ENDING');
  return good?.id || null;
}

/**
 * Что город узнал из удавшегося дела.
 *
 * Обычный успех открывает ровно то, что дело и выясняло: судья назвал это
 * заранее, и у дела, которое ничего не выясняло, открывать нечего. Крит
 * открывает ещё один пункт — блестяще сделанная работа приносит больше, чем
 * просили, и это ровно тот случай, когда разгадка не должна умереть
 * непрочитанной.
 */
function revealForDeed(plot, process, finish) {
  const out = [];
  const aimed = revealPremise(plot, process?.premiseText);
  if (aimed) out.push(aimed);
  if (finish === 'crit') {
    const extra = revealNextPremise(plot);
    if (extra) out.push(extra);
  }
  return out;
}

function pickThreatForDeed(plot, process) {
  const byId = findThreat(plot, process?.threatId);
  if (byId && byId.status === 'live') return byId;
  return liveHarmThreats(plot)[0] || null;
}

/**
 * Применить завершившееся дело к нити.
 *
 * `finish` — уже брошенный исход: `fail` | `ok` | `crit`.
 * Возвращает `{ alignment, finish, depthGain, closes, endingKind, threat, cascade, fired }`.
 */
export function applyDeedToPlot({
  plot,
  process,
  finish = 'ok',
  day = 0,
  rng = Math.random,
} = {}) {
  const alignment = alignmentOf(process) || 'UNRELATED';
  const out = {
    alignment,
    finish,
    depthGain: 0,
    closes: false,
    endingKind: null,
    threatId: null,
    cascade: null,
    fired: null,
    livesLeft: livesLeft(plot),
    severity: null,
    revealed: [],
  };
  if (!plot) return out;

  if (alignment === 'DIRECT') {
    if (finish === 'fail') {
      plot.failCount = Math.max(0, Math.round(Number(plot.failCount) || 0)) + 1;
      out.livesLeft = livesLeft(plot);
      out.severity = severityForLives(out.livesLeft + 1);
      return out;
    }
    const gain = depthGain({
      durationBand: process?.durationBand,
      difficulty: process?.difficulty,
      gravity: plot.gravity,
      finish,
      rng,
    });
    out.depthGain = gain;
    plot.depth = Math.round(((Number(plot.depth) || 0) + gain) * 100) / 100;
    out.revealed = revealForDeed(plot, process, finish);
    if (closesPlot({ depth: 0, gain: plot.depth, maxDepth: plot.maxDepth })) {
      out.closes = true;
      out.endingKind = 'GOOD_ENDING';
      plot.ending = {
        kind: 'GOOD_ENDING',
        text: '',
        endingId: pickGoodEndingId(plot, process),
        processId: process?.id || null,
      };
    }
    return out;
  }

  if (alignment === 'RELEVANT') {
    const threat = pickThreatForDeed(plot, process);
    out.threatId = threat?.id || null;
    if (!threat || finish === 'fail') return out;
    defendThreat(plot, threat, { day, by: process?.id || null });
    if (finish === 'crit') out.cascade = critCascade(plot, threat, { day });
    return out;
  }

  if (alignment === 'DANGEROUS') {
    const threat = pickThreatForDeed(plot, process);
    out.threatId = threat?.id || null;
    if (!threat || finish === 'fail') return out;
    if (finish === 'crit') {
      out.fired = fireThreat(plot, threat, { day, firedBy: process?.id || null });
      out.closes = !!out.fired?.closes;
      out.endingKind = out.fired?.endingKind || null;
      out.severity = out.fired?.severity || null;
      out.livesLeft = livesLeft(plot);
      return out;
    }
    const res = hastenThreat(threat, { day });
    out.hastenedDays = res.cut;
    out.dueNow = !!res.dueNow;
    return out;
  }

  return out;
}
