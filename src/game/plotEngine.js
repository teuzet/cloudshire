/**
 * Движок нитей: часы, отбор битов, окраска и бюджеты последствий.
 * Агент здесь не участвует — он получает готовый факт и облекает его в язык.
 * См. docs/PIVOT_PLOTLINES.md.
 */

import {
  normalizePlotlines,
  advancePlotClocks,
  findPlotline,
  isOverdue,
  createErrandPlotline,
  boardHasRoom,
  plotConfig,
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

/** У каждого дела своя нить: либо существующая, либо проходная. */
export function ensureErrandForProcess(domain, process, { tick = null, config = null } = {}) {
  normalizePlotlines(domain, config);
  const existing = (domain.plotlines || []).find((p) =>
    (p.relatedProcessIds || []).includes(String(process?.id)),
  );
  if (existing) return { plot: existing, created: false };

  const cfg = plotConfig(config || {});
  const room = boardHasRoom(domain, cfg);
  if (!room.errand) return { plot: null, created: false, reason: 'board_full' };

  const plot = createErrandPlotline(process, { tick, config });
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
 * Обязательные идут первыми и потолок пробивают: дело завершилось или сорвалось,
 * нить пережила отпущенный срок. Добровольные добираются по вероятности до потолка.
 */
export function planBeats({ domain, config, processOutcomes = [], rng = Math.random }) {
  const cfg = plotConfig(config || {});
  normalizePlotlines(domain, config);

  const beats = [];
  const taken = new Set();

  const addBeat = (plot, { mandatory, reason, tint, finale = false, outcome = null }) => {
    if (!plot || taken.has(plot.id)) return;
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
      finale: finale || isOverdue(plot),
      tint: typeof rolled === 'string' ? rolled : rolled.tint,
      tintLabel: TINT_LABELS[typeof rolled === 'string' ? rolled : rolled.tint],
      statId: typeof rolled === 'string' ? null : rolled.statId || null,
      roll: typeof rolled === 'string' ? null : rolled.roll ?? null,
      chance: typeof rolled === 'string' ? null : rolled.chance ?? null,
      processOutcome: outcome,
    });
  };

  // 1. Обязательные от дел: окраску не кидаем, она уже в броске дела.
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

  // 2. Обязательные по возрасту: нить дожила до предела — финальный бит.
  for (const plot of domain.plotlines) {
    if (!isOverdue(plot)) continue;
    addBeat(plot, { mandatory: true, reason: 'overdue', finale: true });
  }

  // 3. Добровольные — до потолка.
  const cap = cfg.beats.maxPerTick;
  let voluntary = 0;
  for (const plot of domain.plotlines) {
    if (taken.has(plot.id)) continue;
    if (voluntary >= cap) break;
    const chance = beatChance(plot, cfg);
    if (rng() >= chance) continue;
    voluntary += 1;
    addBeat(plot, { mandatory: false, reason: 'roll' });
  }

  return beats;
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
export function planQuietDrift(domain, config, rng = Math.random) {
  const cfg = plotConfig(config || {}).quiet;
  const stats = config?.stats || [];
  if (!stats.length || rng() >= cfg.driftChance) return null;

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
        (b.finale ? ' [финал]' : ''),
    )
    .join('\n');
}
