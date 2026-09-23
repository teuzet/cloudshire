/**
 * Что делает с историей завершившееся дело.
 *
 * Возвращает описание последствий; писать хронику и говорить с игроком —
 * не здесь. Сработавшую беду здесь не исполняют: это делает цикл мира,
 * чтобы хроника связала дело и беду одним текстом.
 */

import { depthGain, closesPlot } from './deedMath.js';
import { alignmentOf } from './deedAlign.js';
import { revealPremise, revealAnswer, answerOpen } from './premises.js';
import { findThreat, avertThreats, livesLeft } from './threats.js';
import { shiftPressure, threatConfig } from './pressure.js';

function threatIdsOf(process) {
  const ids = [];
  if (Array.isArray(process?.threatIds)) ids.push(...process.threatIds);
  if (process?.threatId) ids.push(process.threatId);
  return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
}

function revealForDeed(plot, process, finish) {
  if (process?.reachesAnswer && answerOpen(plot, { finish })) {
    const answer = revealAnswer(plot);
    if (answer) return { premises: [], answer };
  }
  const aimed = revealPremise(plot, process?.premiseText);
  return { premises: aimed ? [aimed] : [], answer: null };
}

function relevantDepthGain(plot, count, finish, config) {
  if (!count) return 0;
  const cfg = threatConfig(config);
  const factor = finish === 'crit' ? cfg.relevantCritDepthFactor : 1;
  const raw = cfg.relevantDepthPerThreat * count * factor;
  const room = Math.max(0, (Number(plot.maxDepth) || 1) - 0.01 - (Number(plot.depth) || 0));
  return Math.round(Math.min(room, Math.max(0, raw)) * 100) / 100;
}

/**
 * Применить завершившееся дело к нити.
 *
 * `finish` — уже брошенный исход: `fail` | `ok` | `crit`.
 * `pressureFilled` — шкала этим делом перешла через ста.
 * `triggerThreat` — беда, которую успех опасного дела приводит в исполнение.
 */
export function applyDeedToPlot({
  plot,
  process,
  finish = 'ok',
  day = 0,
  config = null,
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
    threatIds: [],
    averted: [],
    triggerThreat: null,
    pressure: null,
    pressureFilled: false,
    revealed: [],
    answer: null,
    livesLeft: livesLeft(plot),
  };
  if (!plot) return out;

  if (alignment === 'DIRECT') {
    if (finish === 'fail') {
      out.pressure = shiftPressure(plot, day, threatConfig(config).directFail);
      out.pressureFilled = out.pressure.filled;
      out.livesLeft = livesLeft(plot);
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
    if (finish === 'crit') {
      out.pressure = shiftPressure(plot, day, threatConfig(config).directCrit);
    }
    const found = revealForDeed(plot, process, finish);
    out.revealed = found.premises;
    out.answer = found.answer;
    if (closesPlot({ depth: 0, gain: plot.depth, maxDepth: plot.maxDepth })) {
      out.closes = true;
      out.endingKind = 'GOOD_ENDING';
      plot.ending = {
        kind: 'GOOD_ENDING',
        text: '',
        questionGone: '',
        nowDifferent: '',
        processId: process?.id || null,
      };
    }
    return out;
  }

  if (alignment === 'RELEVANT') {
    const ids = threatIdsOf(process);
    out.threatIds = ids;
    out.threatId = ids[0] || null;
    if (finish === 'fail') {
      out.pressure = shiftPressure(plot, day, threatConfig(config).relevantFail);
      out.pressureFilled = out.pressure.filled;
      return out;
    }
    out.averted = avertThreats(plot, ids, { day, by: process?.id || null });
    const cfg = threatConfig(config);
    const factor = finish === 'crit' ? cfg.relevantCritFactor : 1;
    out.pressure = shiftPressure(plot, day, cfg.relevantPerThreat * out.averted.length * factor);
    const depth = relevantDepthGain(plot, out.averted.length, finish, config);
    if (depth) {
      out.depthGain = depth;
      plot.depth = Math.round(((Number(plot.depth) || 0) + depth) * 100) / 100;
    }
    return out;
  }

  if (alignment === 'DANGEROUS') {
    const id = threatIdsOf(process)[0] || '';
    const threat = findThreat(plot, id);
    out.threatId = threat?.id || null;
    if (threat && threat.status === 'live' && finish !== 'fail') out.triggerThreat = threat;
    return out;
  }

  return out;
}
