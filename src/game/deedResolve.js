/**
 * Что делает с историей завершившееся дело.
 *
 * Возвращает описание последствий; писать хронику и говорить с игроком —
 * не здесь. Единственный источник правды о том, как исход дела двигает нить.
 */

import { depthGain, closesPlot } from './deedMath.js';
import { alignmentOf } from './deedAlign.js';
import { revealPremise, revealAnswer, answerOpen } from './premises.js';
import {
  findThreat,
  liveThreats,
  liveHarmThreats,
  defendThreat,
  hastenThreat,
  reprieveThreat,
  fireThreat,
  livesLeft,
  remainingToBadEndingPct,
  threatStageForPlot,
} from './threats.js';

export const CRIT_CASCADE_STEPS = ['reprieve', 'restore_life', 'depth'];

/**
 * Каскад крита на RELEVANT-деле. Детерминированный, срабатывает ровно один пункт.
 * Сначала время другой беде, потом жизнь, и только если нечего дать — чуть глубины.
 */
export function critCascade(plot, threat) {
  const others = liveThreats(plot).filter((t) => t.id !== threat?.id);

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
 * Дело, которое целилось в саму разгадку, получает её — но только если
 * сердцевина уже открыта. Закрыта — и то же дело приносит подступ, который
 * назвал судья: пустых успехов у расследования не бывает ни в одной ветке.
 * Дело, которое ничего не выясняло, не приносит ничего.
 */
function revealForDeed(plot, process, finish) {
  if (process?.reachesAnswer && answerOpen(plot, { finish })) {
    const answer = revealAnswer(plot);
    if (answer) return { premises: [], answer };
  }
  const aimed = revealPremise(plot, process?.premiseText);
  return { premises: aimed ? [aimed] : [], answer: null };
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
    stage: null,
    remainingPct: null,
    revealed: [],
    answer: null,
  };
  if (!plot) return out;

  if (alignment === 'DIRECT') {
    if (finish === 'fail') {
      plot.failCount = Math.max(0, Math.round(Number(plot.failCount) || 0)) + 1;
      out.livesLeft = livesLeft(plot);
      out.stage = threatStageForPlot(plot);
      out.remainingPct = remainingToBadEndingPct(plot);
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
    // Глубину прибавляем до проверки сердцевины: иначе крупное расследование,
    // само перевалившее порог, отдавало бы разгадку только следующим делом.
    const found = revealForDeed(plot, process, finish);
    out.revealed = found.premises;
    out.answer = found.answer;
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
      out.stage = out.fired?.stage || null;
      out.remainingPct = out.fired?.remainingPct ?? null;
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
