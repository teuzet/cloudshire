/**
 * Исполнение указа на сопряжении: дело на главной нити + хроника на нити указа.
 */

import { newId } from './ids.js';
import { createLoreFact } from './models.js';
import { getLogger } from '../log.js';
import {
  resolveLinkedStats,
  applyObjectiveSchedule,
  guessProcessDuration,
  listStatIds,
} from './processes.js';
import { estimateProcessDuration } from './durationJudge.js';
import { attachChronicleToPlotlines } from './plotlines.js';
import { stampProcessOnConflux } from './confluxBoard.js';
import { markOrderFired } from './orders.js';
import { tickOrder } from './storyteller.js';

export function mainConfluxPlot(conflux) {
  if (!conflux) return null;
  const byId = (conflux.plotlines || []).find((p) => String(p.id) === String(conflux.mainPlotId));
  if (byId) return byId;
  return (conflux.plotlines || []).find((p) => p.isMainConflux) || null;
}

function orderAlreadyActing(domain, plot, conflux) {
  const orderId = String(plot?.id || '');
  const confluxId = String(conflux?.id || '');
  if (!orderId || !confluxId) return false;
  return (domain.state?.pendingActions || []).some(
    (a) =>
      (!a.status || a.status === 'active') &&
      String(a.sourceOrderId || '') === orderId &&
      String(a.confluxId || '') === confluxId,
  );
}

function linkedStatsForOrder(plot, config) {
  const fromPlot = resolveLinkedStats(plot?.relatedStats, config);
  if (fromPlot.length) return fromPlot;
  const ids = listStatIds(config);
  if (ids.includes('knowledge')) return ['knowledge'];
  return ids.slice(0, 1);
}

function processCopy(plot, partner, rule) {
  const neighbor = partner?.name ? `остров «${partner.name}»` : 'соседний остров';
  const summary = String(plot?.title || 'Порядок на сопряжении')
    .trim()
    .slice(0, 80);
  const detail = `${rule || plot?.synopsis || summary} Сопряжение с ${neighbor}: исполнить этот постоянный порядок.`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  const goal = `Исполнить порядок «${summary}» во время этой встречи.`.slice(0, 240);
  return { summary, detail, goal };
}

/**
 * Завести дело на главной нити сопряжения. Хронику не пишет.
 * @returns {{ ok: boolean, process?: object, mainPlot?: object, error?: string }}
 */
export function startDockOrderProcess(domain, plot, { conflux, partner, config, months = 2 } = {}) {
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  if (!Array.isArray(domain.state.pendingActions)) domain.state.pendingActions = [];

  const main = mainConfluxPlot(conflux);
  if (!main) return { ok: false, error: 'no_main_plot' };
  if (orderAlreadyActing(domain, plot, conflux)) return { ok: false, error: 'already_acting' };

  const modifier = (domain.state.modifiers || []).find((m) => m.id === plot.modifierId);
  const rule = modifier?.text || plot.synopsis || plot.title;
  const { summary, detail, goal } = processCopy(plot, partner, rule);
  const linked = linkedStatsForOrder(plot, config);
  const character = domain.characters?.[0] || null;
  const action = {
    id: newId('act'),
    summary,
    detail,
    goal,
    expectedMonths: Math.max(1, Math.round(Number(months) || 2)),
    durationMonths: Math.max(1, Math.round(Number(months) || 2)),
    monthsLeft: Math.max(1, Math.round(Number(months) || 2)),
    monthsDone: 0,
    linkedStats: linked,
    onBehalfOf: character?.name || 'постоянный порядок',
    characterId: character?.id || null,
    characterName: character?.name || null,
    status: 'active',
    initiative: 'patron',
    intel: false,
    sourceOrderId: plot.id,
    slotless: true,
    plotlineId: main.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  applyObjectiveSchedule(action, action.expectedMonths);
  stampProcessOnConflux(action, conflux, domain.id);
  main.relatedProcessIds = Array.isArray(main.relatedProcessIds) ? main.relatedProcessIds : [];
  if (!main.relatedProcessIds.includes(action.id)) main.relatedProcessIds.push(action.id);
  domain.state.pendingActions.push(action);
  return { ok: true, process: action, mainPlot: main };
}

function fallbackDockChronicle(domain, plot, world, { partner, refused, process }) {
  const neighbor = partner?.name ? `остров «${partner.name}»` : 'соседний остров';
  let text = `По постоянному порядку «${plot.title}» город исполнил правило на сопряжении с ${neighbor}.`;
  if (refused === 'no_main_plot') {
    text = `Постоянный порядок «${plot.title}» не сработал: сопряжение ещё не дало общей нити встречи.`;
  } else if (process?.summary) {
    text = `По постоянному порядку «${plot.title}» к ${neighbor} отправили: ${process.summary}.`;
  }
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle'],
    gameDateLabel: world?.gameDate?.label || null,
    tick: world?.tickIndex ?? null,
    author: 'order:dock-fallback',
    importance: 'minor',
    relatedPlotlineIds: [plot.id],
    relatedPendingId: process?.id || null,
  });
  domain.lore = domain.lore || [];
  domain.lore.push(fact);
  attachChronicleToPlotlines(domain, fact.id, [plot.id]);
  return fact;
}

/**
 * Один выстрел указа на текущее сопряжение: дело мимо лимита слотов и хроника.
 */
export async function fireConfluxDockOrder({
  config,
  runtime,
  domain,
  world,
  plot,
  conflux,
  partner = null,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({
    scope: 'order.dock',
    domainId: domain?.id,
    plotId: plot?.id,
    confluxId: conflux?.id,
  });
  const modifier = (domain.state?.modifiers || []).find((m) => m.id === plot.modifierId);
  const rule = modifier?.text || plot.synopsis || plot.title;
  const copy = processCopy(plot, partner, rule);

  const preview = startDockOrderProcess(domain, plot, {
    conflux,
    partner,
    config,
    months: 2,
  });
  if (preview.ok && runtime) {
    const estimated = await estimateProcessDuration({
      config,
      runtime,
      domain,
      summary: copy.summary,
      detail: copy.detail,
      log,
    });
    applyObjectiveSchedule(preview.process, estimated.months);
  } else if (preview.ok && !runtime) {
    applyObjectiveSchedule(preview.process, guessProcessDuration(copy.summary, copy.detail, 2));
  }

  const spawned = preview;
  const mainPlot = spawned.mainPlot || mainConfluxPlot(conflux);
  const event = {
    kind: 'conflux_dock',
    confluxId: conflux?.id || null,
    partnerName: partner?.name || null,
    processSummary: spawned.process?.summary || null,
    processId: spawned.process?.id || null,
    refused: spawned.ok ? null : spawned.error,
    mainPlotId: mainPlot?.id || null,
  };

  let result = null;
  if (runtime) {
    try {
      result = await tickOrder({
        config,
        runtime,
        domain,
        world,
        plot,
        mode: 'chronicle',
        event,
        log,
      });
    } catch (err) {
      log.warn('order.dock_tick_failed', { error: err.message });
    }
  }
  if (!result?.fact) {
    const fact = fallbackDockChronicle(domain, plot, world, {
      partner,
      refused: event.refused,
      process: spawned.process || null,
    });
    markOrderFired(plot, world?.tickIndex ?? null, { confluxId: conflux?.id });
    result = { fact, plot, mode: 'chronicle', spawned: null, process: spawned.process || null };
  }

  if (result.fact && mainPlot) {
    mainPlot.chronicleIds = Array.isArray(mainPlot.chronicleIds) ? mainPlot.chronicleIds : [];
    if (!mainPlot.chronicleIds.includes(result.fact.id)) mainPlot.chronicleIds.push(result.fact.id);
    const ids = new Set((result.fact.relatedPlotlineIds || []).map(String));
    ids.add(String(plot.id));
    ids.add(String(mainPlot.id));
    result.fact.relatedPlotlineIds = [...ids];
    if (spawned.process?.id) result.fact.relatedPendingId = spawned.process.id;
  }

  log.info('order.dock_fired', {
    title: plot.title,
    processId: spawned.process?.id || null,
    refused: spawned.ok ? null : spawned.error,
    factId: result.fact?.id || null,
  });
  return { ...result, process: spawned.process || null, refused: spawned.ok ? null : spawned.error };
}
