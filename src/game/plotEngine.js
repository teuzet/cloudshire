/**
 * Движок нитей: часы, отбор битов, окраска и бюджеты последствий.
 * Агент здесь не участвует — он получает готовый факт и облекает его в язык.
 * См. docs/PIVOT_PLOTLINES.md.
 */

import {
  normalizePlotlines,
  advancePlotClocks,
  findPlotline,
  findClosedPlotline,
  reopenClosedPlotline,
  plotCanFade,
  createErrandPlotline,
  boardHasRoom,
  plotConfig,
  clipPlotText,
  PLOT_SUMMARY_MAX,
} from './plotlines.js';
import {
  beatChance,
  pickRollStat,
  rollTint,
  tintFromProcessOutcome,
  TINT_LABELS,
} from './rolls.js';

/** Месячные часы доски: возраст растёт, интерес остывает. */
export function advancePlotMonth(domain, cfg) {
  return advancePlotClocks(domain, cfg);
}

function attachProcess(plot, processId) {
  const id = String(processId);
  if (id && !plot.relatedProcessIds.includes(id)) plot.relatedProcessIds.push(id);
  return plot;
}

/**
 * У каждого дела своя нить: открытая, недавно закрытая (её надо вернуть),
 * либо новая проходная. Нельзя заводить пустую карточку поверх уже случившейся развязки.
 */
export function ensureErrandForProcess(domain, process, { tick = null, config = null } = {}) {
  normalizePlotlines(domain, config);
  const processId = String(process?.id || '');
  const existing = (domain.plotlines || []).find((p) =>
    (p.relatedProcessIds || []).includes(processId),
  );
  if (existing) return { plot: existing, created: false };

  if (process?.plotlineId) {
    const named = findPlotline(domain, process.plotlineId);
    if (named) return { plot: attachProcess(named, processId), created: false };
  }

  const closed =
    (process?.plotlineId && findClosedPlotline(domain, process.plotlineId)) ||
    (domain.closedPlotlines || []).find((p) => (p.relatedProcessIds || []).includes(processId));
  if (closed) {
    const plot = reopenClosedPlotline(domain, closed);
    if (plot) return { plot: attachProcess(plot, processId), created: false, reopened: true };
  }

  const cfg = plotConfig(config || {});
  const room = boardHasRoom(domain, cfg);
  if (!room.errand) return { plot: null, created: false, reason: 'board_full' };

  const plot = createErrandPlotline(process, { tick, config });
  const parent = process?.plotlineId ? findClosedPlotline(domain, process.plotlineId) : null;
  if (parent?.reason || parent?.synopsis) {
    const known = parent.synopsis || `Уже установлено: ${parent.reason}`;
    plot.synopsis = clipPlotText(
      `${known} Поручение ещё шло: ${process.detail || process.summary || ''}`.trim(),
      PLOT_SUMMARY_MAX,
    );
  }
  domain.plotlines.push(plot);
  return { plot, created: true };
}

/** Привязать дело к существующей нити (когда игрок продолжает начатую историю). */
export function linkProcessToPlotline(domain, processId, plotlineId) {
  const plot = findPlotline(domain, plotlineId);
  if (!plot) return null;
  const id = String(processId);
  if (!plot.relatedProcessIds.includes(id)) plot.relatedProcessIds.push(id);
  return plot;
}

function plotsForProcess(domain, processId) {
  const id = String(processId);
  return (domain.plotlines || []).filter((p) => (p.relatedProcessIds || []).includes(id));
}

function statValue(domain, statId) {
  const v = Number(domain?.stats?.[statId]);
  return Number.isFinite(v) ? v : 50;
}

/**
 * План битов месяца.
 * Процессы всегда занимают слоты (и могут забить весь потолок).
 * Случайные тики живых историй — только в остаток. Сход слот не занимает.
 * Нити указов сюда не входят.
 */
export function planBeats({ domain, config, processOutcomes = [], rng = Math.random }) {
  const cfg = plotConfig(config || {});
  normalizePlotlines(domain, config);

  const beats = [];
  const taken = new Set();

  const addBeat = (plot, { mandatory, reason, tint, finale = false, fade = false, outcome = null }) => {
    if (!plot || taken.has(plot.id)) return false;
    taken.add(plot.id);
    const rolled =
      tint ||
      (() => {
        const statId = pickRollStat(plot.relatedStats, rng, cfg.roll);
        const r = rollTint(statValue(domain, statId), rng, cfg.roll);
        return { ...r, statId };
      })();
    beats.push({
      plotId: plot.id,
      title: plot.title,
      mandatory,
      reason,
      finale: Boolean(finale),
      fade: Boolean(fade),
      tint: typeof rolled === 'string' ? rolled : rolled.tint,
      tintLabel: TINT_LABELS[typeof rolled === 'string' ? rolled : rolled.tint],
      statId: typeof rolled === 'string' ? null : rolled.statId || null,
      roll: typeof rolled === 'string' ? null : rolled.roll ?? null,
      chance: typeof rolled === 'string' ? null : rolled.chance ?? null,
      processOutcome: outcome,
    });
    return true;
  };

  // 1. Процессы — всегда, даже сверх потолка.
  for (const outcome of processOutcomes) {
    if (!outcome?.mustNarrate) continue;
    for (const plot of plotsForProcess(domain, outcome.processId)) {
      addBeat(plot, {
        mandatory: true,
        reason: outcome.finished ? 'process_finished' : `process_${outcome.kind}`,
        tint: tintFromProcessOutcome(outcome),
        finale: outcome.finished && plot.kind === 'errand',
        outcome,
      });
    }
  }

  // 2. Сход забытой нити — служебное закрытие, слот не занимает.
  for (const plot of domain.plotlines) {
    if (plot.kind === 'order') continue;
    if (!plotCanFade(domain, plot, cfg)) continue;
    addBeat(plot, { mandatory: true, reason: 'fade', fade: true, tint: 'dual' });
  }

  const cap = cfg.beats.maxPerTick;
  let slotsUsed = beats.filter((b) => !b.fade).length;

  // 3. Случайные тики живых историй — только в остаток.
  for (const plot of domain.plotlines) {
    if (plot.kind !== 'story') continue;
    if (taken.has(plot.id)) continue;
    if (slotsUsed >= cap) break;
    const chance = beatChance(plot, cfg);
    if (rng() >= chance) continue;
    if (addBeat(plot, { mandatory: false, reason: 'roll' })) slotsUsed += 1;
  }

  return { beats, slotsUsed, cap };
}

/**
 * Ворота журнала: решает движок, а не формулировка в промпте.
 * Закрыты — строка вообще не попадает в контекст бита.
 */
export function openLogGate(domain, plot, config, rng = Math.random) {
  const cfg = plotConfig(config || {});
  const log = domain?.state?.monthLog || [];
  if (!log.length) return null;
  if (rng() >= cfg.log.influenceChance) return null;
  // Сначала строка, связанная с этой нитью, иначе любая свежая.
  const related = log.find((l) => (l.plotIds || []).includes(plot?.id));
  const line = related || log[log.length - 1];
  return line?.text || null;
}

export function clearMonthLog(domain) {
  if (domain?.state) domain.state.monthLog = [];
}

/** Бюджеты месяца: решения игрока и события мира считаются раздельно. */
export function createStatBudget(config) {
  const cfg = plotConfig(config || {});
  return {
    world: cfg.stats.worldBudget,
    player: cfg.stats.playerBudget,
    spentWorld: 0,
    spentPlayer: 0,
  };
}

const FORCE_BASE = { slight: 1, notable: 2, heavy: 4 };

/**
 * Направление даёт агент, величину — движок.
 * @param {{stat: string, direction: 'up'|'down', force?: string}[]} affects
 */
export function resolveStatDeltas(
  domain,
  affects = [],
  { importance = 40, finale = false, source = 'world', budget = null, config = null, catastrophe = false } = {},
) {
  const cfg = plotConfig(config || {});
  const allowed = new Set((config?.stats || []).map((s) => s.id));
  const importanceFactor = 0.5 + Math.max(0, Math.min(100, Number(importance) || 0)) / 100;
  const finaleFactor = finale ? cfg.stats.finaleFactor : 1;
  const deltas = {};

  for (const a of affects) {
    const stat = String(a?.stat || '');
    if (allowed.size && !allowed.has(stat)) continue;
    const dir = a?.direction === 'down' ? -1 : 1;
    const base = FORCE_BASE[a?.force] ?? FORCE_BASE.notable;
    let size = Math.max(1, Math.round(base * importanceFactor * finaleFactor));

    if (budget && !catastrophe) {
      const key = source === 'player' ? 'spentPlayer' : 'spentWorld';
      const cap = source === 'player' ? budget.player : budget.world;
      const left = Math.max(0, cap - budget[key]);
      if (left <= 0) continue;
      size = Math.min(size, left);
      budget[key] += size;
    }
    deltas[stat] = (deltas[stat] || 0) + dir * size;
  }

  return deltas;
}

function pickWeighted(items, weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return items[Math.floor(rng() * items.length)] || null;
  let roll = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1] || null;
}

/**
 * След тихого месяца в статах: небольшой сдвиг с тягой к середине.
 * Просевшее чаще выправляется, раздутое чаще садится — спираль не разгоняется.
 * @returns {{stat: string, name: string, direction: 'up'|'down', force: string}|null}
 */
export function planQuietDrift(domain, config, rng = Math.random, { force = false } = {}) {
  const cfg = plotConfig(config || {}).quiet;
  const stats = config?.stats || [];
  if (!stats.length) return null;
  if (!force && rng() >= cfg.driftChance) return null;

  const weights = stats.map((s) => 1 + (Math.abs(50 - statValue(domain, s.id)) / 50) * cfg.extremeBias);
  const stat = pickWeighted(stats, weights, rng);
  if (!stat) return null;

  const value = statValue(domain, stat.id);
  const upChance = 0.5 + ((50 - value) / 50) * cfg.meanReversion * 0.5;
  return {
    stat: stat.id,
    name: stat.name || stat.id,
    direction: rng() < upChance ? 'up' : 'down',
    force: rng() < cfg.notableChance ? 'notable' : 'slight',
  };
}

/** Просевшие стороны города — для подсказки о шансе на восстановление. */
export function lowStats(domain, config, threshold = 25) {
  return (config?.stats || [])
    .map((s) => ({ id: s.id, name: s.name, value: Number(domain?.stats?.[s.id]) }))
    .filter((s) => Number.isFinite(s.value) && s.value <= threshold);
}

export function formatBeatPlanForLog(beats) {
  if (!beats.length) return '(битов нет)';
  return beats
    .map(
      (b) =>
        `${b.mandatory ? '!' : ' '} «${b.title}» ${b.reason} → ${b.tint}` +
        (b.statId ? ` (по ${b.statId}: ${b.roll}/${b.chance})` : '') +
        (b.fade ? ' [угасла]' : b.finale ? ' [финал]' : ''),
    )
    .join('\n');
}
