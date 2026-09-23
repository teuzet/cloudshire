/**
 * Движок нитей: часы, отбор битов, окраска и бюджеты последствий.
 * Агент здесь не участвует — он получает готовый факт и облекает его в язык.
 * См. docs/PLOTS.md.
 */

import {
  normalizePlotlines,
  advancePlotClocks,
  findPlotline,
  plotsForProcess,
  plotConfig,
  isThreeActPlot,
  isStoryPlot,
  isConfluxPlot,
  isStakedStory,
} from './plotlines.js';
import {
  pickRollStat,
  rollTint,
  tintFromProcessOutcome,
  TINT_LABELS,
  rollProcessAdvance,
} from './rolls.js';
import { applyStoryActMove } from './storyActs.js';
import { engagementOf, engagementAttends, applyEngagement } from './plotAlign.js';
import {
  applyEngineProgress,
  processStatAverage,
  normalizeProcess,
  processIsLive,
} from './processes.js';
import { releaseOfficerProcess } from './officers.js';

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
 * Поручение больше не карточка: процесс без plotlineId.
 * Если дело уже на истории — вернуть её. Иначе ничего не создавать.
 */
export function ensureErrandForProcess(domain, process, { tick = null, config = null } = {}) {
  void tick;
  normalizePlotlines(domain, config);
  const processId = String(process?.id || '');
  const existing = plotsForProcess(domain, processId).find((p) => isStoryPlot(p));
  if (existing) {
    if (process) process.plotlineId = existing.id;
    return { plot: existing, created: false };
  }
  if (process?.plotlineId) {
    const named = findPlotline(domain, process.plotlineId);
    if (named && isStoryPlot(named)) {
      return { plot: attachProcess(named, processId), created: false };
    }
  }
  if (process) process.plotlineId = null;
  return { plot: null, created: false };
}

/** Привязать дело к существующей нити (когда игрок продолжает начатую историю). */
export function linkProcessToPlotline(domain, processId, plotlineId) {
  const plot = findPlotline(domain, plotlineId);
  if (!plot) return null;
  const id = String(processId);
  if (!plot.relatedProcessIds.includes(id)) plot.relatedProcessIds.push(id);
  return plot;
}

function unlinkProcessFromPlot(plot, processId) {
  const id = String(processId);
  plot.relatedProcessIds = (plot.relatedProcessIds || []).filter((x) => String(x) !== id);
  return plot;
}

function processTime(process) {
  const t = Date.parse(process?.createdAt || '');
  return Number.isFinite(t) ? t : 0;
}

function findProcessById(domain, processId) {
  return (domain?.state?.pendingActions || []).find((a) => String(a.id) === String(processId)) || null;
}

/** DIRECT/RELEVANT активные дела на нити, старше первым. */
export function attendingQueueForPlot(domain, plot) {
  const ids = new Set((plot?.relatedProcessIds || []).map(String));
  return (domain?.state?.pendingActions || [])
    .filter((a) => {
      if (!ids.has(String(a.id))) return false;
      if (a.status && a.status !== 'active') return false;
      return engagementAttends(engagementOf(a));
    })
    .sort((a, b) => processTime(a) - processTime(b) || String(a.id).localeCompare(String(b.id)));
}

/**
 * UNRELATED снимается с истории: дело остаётся поручением без нити.
 */
export function rehomeUnrelatedProcess(domain, process, { tick = null, config = null } = {}) {
  void tick;
  void config;
  if (!process || process.intel) return { plot: null, rehomed: false, originPlot: null };
  const attached = plotsForProcess(domain, process.id);
  const engagement = engagementOf(process);
  if (engagement == null) {
    return { plot: attached[0] || findPlotline(domain, process.plotlineId) || null, rehomed: false, originPlot: null };
  }
  if (engagementAttends(engagement)) {
    return { plot: attached[0] || findPlotline(domain, process.plotlineId) || null, rehomed: false, originPlot: null };
  }
  const stories = attached.filter((p) => isStoryPlot(p));
  if (!stories.length) {
    process.plotlineId = null;
    return { plot: null, rehomed: false, originPlot: null };
  }
  const originPlot = stories[0];
  for (const plot of stories) unlinkProcessFromPlot(plot, process.id);
  applyEngagement(process, 'UNRELATED');
  process.plotlineId = null;
  return { plot: null, rehomed: true, originPlot };
}

/** Снять с трёхтактных нитей все дела, которые судья счёл UNRELATED. */
export function rehomeUnrelatedOnDomain(domain, { tick = null, config = null } = {}) {
  const moved = [];
  for (const process of domain?.state?.pendingActions || []) {
    const result = rehomeUnrelatedProcess(domain, process, { tick, config });
    if (result.rehomed) moved.push({ process, ...result });
  }
  return moved;
}

/** Остальные дела на нити не уходят в новую карточку: идущие сворачиваем, нужда отпала. */
export function mootSiblingProcesses(domain, plot, exceptProcessId) {
  if (!plot) return [];
  const except = String(exceptProcessId || '');
  const mooted = [];
  for (const id of [...(plot.relatedProcessIds || [])]) {
    if (String(id) === except) continue;
    const process = findProcessById(domain, id);
    if (!process) continue;
    if (!process.status || process.status === 'active') {
      process.status = 'revoked';
      process.revokeReason = 'нужда отпала';
      process.updatedAt = new Date().toISOString();
      releaseOfficerProcess(domain, process);
    }
    mooted.push({ id: process.id, summary: process.summary || process.id });
  }
  return mooted;
}

/**
 * Снять дело со всех нитей. Пустую карточку-поручение закрыть без новой истории.
 */
export function detachProcessFromPlots(domain, process) {
  if (!process) return { closedErrands: [] };
  const attached = plotsForProcess(domain, process.id);
  for (const plot of attached) unlinkProcessFromPlot(plot, process.id);
  process.plotlineId = null;
  return { closedErrands: [] };
}

/**
 * На трёхтактной нити в месяц тикает только старшее DIRECT/RELEVANT дело.
 * UNRELATED и поручения идут своим ходом. Если голова очереди уже продвинулась
 * и завершилась, следующая голова попадёт в следующий заход того же месяца.
 */
export function collectProcessAdvanceBatch(domain, alreadyAdvanced = new Set()) {
  const skip = new Set([...alreadyAdvanced].map(String));
  const active = (domain?.state?.pendingActions || []).filter(
    (a) => (!a.status || a.status === 'active') && !skip.has(String(a.id)),
  );
  const due = [];
  for (const process of active) {
    const stories = plotsForProcess(domain, process.id).filter((p) => isStoryPlot(p));
    if (!stories.length || !engagementAttends(engagementOf(process))) {
      due.push(process);
      continue;
    }
    const blocked = stories.some((plot) => {
      const head = attendingQueueForPlot(domain, plot)[0];
      return head && String(head.id) !== String(process.id);
    });
    if (!blocked) due.push(process);
  }
  return due;
}

export function applyQueuedEngineProgress(
  domain,
  { tick = null, config = null, rng = Math.random, skipProcess = null, averageOf = null } = {},
) {
  const outcomes = [];
  const advanced = new Set();
  for (let i = 0; i < 24; i += 1) {
    let batch = collectProcessAdvanceBatch(domain, advanced);
    if (typeof skipProcess === 'function') batch = batch.filter((p) => !skipProcess(p));
    if (!batch.length) break;
    const rolls = batch.map((p) => {
      normalizeProcess(p, config);
      const avg = averageOf ? averageOf(p) : processStatAverage(domain, p, config);
      const rolled = rollProcessAdvance(avg, rng);
      return {
        processId: p.id,
        summary: p.summary,
        monthsLeftBefore: p.monthsLeft,
        linkedStats: [...(p.linkedStats || [])],
        ownerDomainId: p.ownerDomainId || null,
        ...rolled,
      };
    });
    const part = applyEngineProgress(domain, rolls, { tick, config, rng });
    for (const o of part) {
      outcomes.push(o);
      advanced.add(String(o.processId));
    }
  }
  return outcomes;
}

function statValue(domain, statId) {
  const v = Number(domain?.stats?.[statId]);
  return Number.isFinite(v) ? v : 50;
}

/**
 * План битов: только исходы дел. Случайных тиков историй нет —
 * город пишет хронику, когда что-то кончилось или сработала угроза.
 */
export function planBeats({
  domain,
  config,
  processOutcomes = [],
  rng = Math.random,
  piercePlotIds = [],
} = {}) {
  const cfg = plotConfig(config || {});
  normalizePlotlines(domain, config);
  void piercePlotIds;

  const beats = [];
  const taken = new Set();

  const addBeat = (plot, { mandatory, reason, tint, finale = false, fade = false, outcome = null, actMove = null, skipTint = false, mootedProcesses = null }) => {
    if (!plot) return false;
    const processKey = outcome?.processId ? `${plot.id}:${outcome.processId}` : null;
    if (processKey) {
      if (taken.has(processKey)) return false;
      taken.add(processKey);
    } else if (taken.has(plot.id)) {
      return false;
    }
    taken.add(plot.id);
    const rolled =
      tint ||
      (skipTint
        ? 'dual'
        : (() => {
            const statId = pickRollStat(plot.relatedStats, rng, cfg.roll);
            const r = rollTint(statValue(domain, statId), rng, cfg.roll);
            return { ...r, statId };
          })());
    beats.push({
      plotId: plot.id,
      title: plot.title,
      mandatory,
      reason,
      finale: Boolean(finale || actMove?.ending),
      fade: Boolean(fade),
      tint: typeof rolled === 'string' ? rolled : rolled.tint,
      tintLabel: TINT_LABELS[typeof rolled === 'string' ? rolled : rolled.tint],
      statId: typeof rolled === 'string' ? null : rolled.statId || null,
      roll: typeof rolled === 'string' ? null : rolled.roll ?? null,
      chance: typeof rolled === 'string' ? null : rolled.chance ?? null,
      processOutcome: outcome,
      actMove: actMove || null,
      skipTint: Boolean(skipTint),
      mootedProcesses: mootedProcesses?.length ? mootedProcesses : null,
    });
    return true;
  };

  // 1. Процессы — всегда, даже сверх потолка. Прыжок такта — только на финише. Intel не двигает сюжет.
  // На одной нити — по очереди создания: сначала ход истории от первого дела, затем второе уже на новом состоянии.
  const orderedOutcomes = [...processOutcomes].sort((a, b) => {
    const pa = findProcessById(domain, a?.processId);
    const pb = findProcessById(domain, b?.processId);
    return processTime(pa) - processTime(pb) || String(a?.processId || '').localeCompare(String(b?.processId || ''));
  });
  for (const outcome of orderedOutcomes) {
    if (!outcome?.mustNarrate) continue;
    if (outcome.intel) continue;
    for (const plot of plotsForProcess(domain, outcome.processId)) {
      if (isConfluxPlot(plot)) continue;
      const relation = outcome.plotEngagement || engagementOf(findProcessById(domain, outcome.processId));
      if ((isThreeActPlot(plot) || isStakedStory(plot)) && relation && !engagementAttends(relation)) {
        continue;
      }
      if (isThreeActPlot(plot) && plot.ending) continue;
      let actMove = null;
      let mootedProcesses = null;
      if (isThreeActPlot(plot) && outcome.finished) {
        actMove = applyStoryActMove(plot, {
          trigger: 'process_finished',
          relation: outcome.plotEngagement,
          aligned: outcome.plotAligned === true,
          finish: outcome.finish || 'ok',
          rng,
          config: cfg,
        });
        if (actMove?.ending) {
          mootedProcesses = mootSiblingProcesses(domain, plot, outcome.processId);
        }
      }
      addBeat(plot, {
        mandatory: true,
        reason: outcome.finished ? 'process_finished' : `process_${outcome.kind}`,
        tint: tintFromProcessOutcome(outcome),
        finale: Boolean(actMove?.ending),
        outcome,
        actMove,
        skipTint: isThreeActPlot(plot),
        mootedProcesses,
      });
    }
  }

  const cap = cfg.beats.maxPerTick;
  const slotsUsed = beats.filter((b) => !b.fade).length;
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

function mergeDeltas(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    const n = (out[k] || 0) + v;
    if (n) out[k] = n;
    else delete out[k];
  }
  return out;
}

/**
 * Раскладка целых дельт: сумма модулей === budget.
 * polarity split держит плюс и минус отдельными бюджетами и складывает их, не деля пополам.
 */
export function scaleAffectsToBudget(
  affects,
  budget,
  { polarity = 'any', allowed = null, upBudget = null, downBudget = null } = {},
) {
  let rows = (affects || [])
    .map((a) => ({
      stat: String(a?.stat || ''),
      dir: a?.direction === 'down' ? -1 : 1,
      weight: Math.max(1, FORCE_BASE[a?.force] ?? 2),
    }))
    .filter((a) => a.stat && (!allowed || allowed.has(a.stat)));
  if (polarity === 'split') {
    const upB = Math.max(0, Math.round(Number(upBudget) || 0));
    const downB = Math.max(0, Math.round(Number(downBudget) || 0));
    let up = rows.filter((r) => r.dir > 0);
    let down = rows.filter((r) => r.dir < 0);
    if (!up.length && down.length && upB) up = down.map((r) => ({ ...r, dir: 1 }));
    if (!down.length && up.length && downB) down = up.map((r) => ({ ...r, dir: -1 }));
    const asAffect = (r) => ({ stat: r.stat, direction: r.dir > 0 ? 'up' : 'down', force: 'notable' });
    return mergeDeltas(
      upB ? scaleAffectsToBudget(up.map(asAffect), upB, { polarity: 'nonneg', allowed }) : {},
      downB ? scaleAffectsToBudget(down.map(asAffect), downB, { polarity: 'nonpos', allowed }) : {},
    );
  }
  const B = Math.max(0, Math.round(Number(budget) || 0));
  if (!B) return {};
  if (polarity === 'nonneg') rows = rows.filter((r) => r.dir > 0);
  if (polarity === 'nonpos') rows = rows.filter((r) => r.dir < 0);
  if (polarity === 'mixed') {
    const up = rows.filter((r) => r.dir > 0);
    const down = rows.filter((r) => r.dir < 0);
    if (up.length && down.length) {
      const upB = Math.max(1, Math.round(B / 2));
      const downB = Math.max(1, B - upB);
      return {
        ...scaleAffectsToBudget(up.map((r) => ({ stat: r.stat, direction: 'up', force: 'notable' })), upB, {
          polarity: 'nonneg',
          allowed,
        }),
        ...Object.fromEntries(
          Object.entries(
            scaleAffectsToBudget(
              down.map((r) => ({ stat: r.stat, direction: 'down', force: 'notable' })),
              downB,
              { polarity: 'nonpos', allowed },
            ),
          ),
        ),
      };
    }
  }
  if (!rows.length) return {};
  const sumW = rows.reduce((s, r) => s + r.weight, 0) || 1;
  const mags = rows.map((r) => Math.max(0, Math.round((r.weight / sumW) * B)));
  let cur = mags.reduce((a, b) => a + b, 0);
  let i = 0;
  while (cur !== B && i < 400) {
    const idx = i % mags.length;
    if (cur < B) {
      mags[idx] += 1;
      cur += 1;
    } else if (mags[idx] > 0) {
      mags[idx] -= 1;
      cur -= 1;
    }
    i += 1;
  }
  const deltas = {};
  rows.forEach((r, idx) => {
    const v = r.dir * mags[idx];
    if (v) deltas[r.stat] = (deltas[r.stat] || 0) + v;
  });
  return deltas;
}

/**
 * Направление даёт агент, величину — движок.
 * Если передан `absBudget`, сумма модулей равна ему (новый контракт).
 * Иначе старый месячный котёл — не используем.
 */
export function resolveStatDeltas(
  domain,
  affects = [],
  {
    source = 'world',
    budget = null,
    config = null,
    catastrophe = false,
    absBudget = null,
    polarity = 'any',
    upBudget = null,
    downBudget = null,
  } = {},
) {
  const allowed = new Set((config?.stats || []).map((s) => s.id));
  if (polarity === 'split' || absBudget != null) {
    return scaleAffectsToBudget(affects, absBudget, { polarity, allowed, upBudget, downBudget });
  }
  const deltas = {};
  for (const a of affects) {
    const stat = String(a?.stat || '');
    if (allowed.size && !allowed.has(stat)) continue;
    const dir = a?.direction === 'down' ? -1 : 1;
    const base = FORCE_BASE[a?.force] ?? FORCE_BASE.notable;
    let size = Math.max(1, Math.round(base));
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

/**
 * Один бюджет на пометки двух берегов.
 * marks: [{ domainId, stat, direction, force }] → Map domainId -> { stat: delta }
 */
export function scaleTaggedAffects(marks, budget, { polarity = 'any' } = {}) {
  const B = Math.max(0, Math.round(Number(budget) || 0));
  const empty = new Map();
  if (!B) return empty;
  let rows = (marks || [])
    .map((a) => ({
      domainId: String(a?.domainId || ''),
      stat: String(a?.stat || ''),
      dir: a?.direction === 'down' ? -1 : 1,
      weight: Math.max(1, FORCE_BASE[a?.force] ?? 2),
    }))
    .filter((a) => a.domainId && a.stat);
  if (polarity === 'nonneg') rows = rows.filter((r) => r.dir > 0);
  if (polarity === 'nonpos') rows = rows.filter((r) => r.dir < 0);
  if (!rows.length) return empty;
  const sumW = rows.reduce((s, r) => s + r.weight, 0) || 1;
  const mags = rows.map((r) => Math.max(0, Math.round((r.weight / sumW) * B)));
  let cur = mags.reduce((a, b) => a + b, 0);
  let i = 0;
  while (cur !== B && i < 400) {
    const idx = i % mags.length;
    if (cur < B) {
      mags[idx] += 1;
      cur += 1;
    } else if (mags[idx] > 0) {
      mags[idx] -= 1;
      cur -= 1;
    }
    i += 1;
  }
  const byDomain = new Map();
  rows.forEach((r, idx) => {
    const v = r.dir * mags[idx];
    if (!v) return;
    const curD = byDomain.get(r.domainId) || {};
    curD[r.stat] = (curD[r.stat] || 0) + v;
    byDomain.set(r.domainId, curD);
  });
  return byDomain;
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

/** Тихий месяц не двигает статы. */
export function planQuietDrift() {
  return null;
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
