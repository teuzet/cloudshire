import { getLogger } from '../log.js';
import {
  plotConfig,
  findPlotline,
  closePlotline,
  plotHasActiveProcess,
  isOrderPlot,
} from './plotlines.js';
import {
  advancePlotMonth,
  planBeats,
  openLogGate,
  createStatBudget,
} from './plotEngine.js';
import { rollProcessAdvance } from './rolls.js';
import {
  normalizeProcess,
  applyEngineProgress,
  processStatAverage,
} from './processes.js';
import {
  normalizeConfluxBoard,
  processesForPlots,
  confluxMonthPlots,
  applyIntelFinishes,
} from './confluxBoard.js';
import { beatSharedPlot } from './confluxBeat.js';
import { fadeQuietPlot, keepSharedStories } from './storyteller.js';
import { scoreMonthStats, factsForStatJudge } from './statJudge.js';
import { realignFinishedOutcomes } from './plotAlign.js';

function storyPlots(conflux) {
  return (conflux?.plotlines || []).filter((p) => p && !isOrderPlot(p));
}

function boardFromPlots(conflux, domains, plots) {
  const processes = processesForPlots(conflux, plots);
  const stats = {};
  for (const d of domains) Object.assign(stats, d.stats || {});
  return {
    id: conflux.id,
    name: 'conflux',
    plotlines: plots,
    closedPlotlines: conflux.closedPlotlines || [],
    stats,
    state: {
      pendingActions: processes,
      monthLog: domains.flatMap((d) => d.state?.monthLog || []),
    },
  };
}

function rollConfluxProcesses(conflux, domainsById, config, rng = Math.random) {
  const list = (conflux.processes || []).filter((p) => !p.status || p.status === 'active');
  return list.map((p) => {
    normalizeProcess(p, config);
    const owner = domainsById.get(p.ownerDomainId) || [...domainsById.values()][0];
    const avg = processStatAverage(owner || { stats: {} }, p, config);
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
}

function outcomesForPlots(outcomes, plots) {
  const ids = new Set();
  for (const p of plots || []) {
    for (const id of p.relatedProcessIds || []) ids.add(String(id));
  }
  return (outcomes || []).filter((o) => ids.has(String(o.processId)));
}

/**
 * Ход нитей сопряжения: часы всех нитей; биты — главная встреча и contested.
 * Остальные процессы тоже двигаются здесь, чтобы хозяин не крутил их второй раз.
 */
export async function resolveConfluxSharedMonth({
  config,
  runtime,
  conflux,
  domains,
  world,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'conflux.month', confluxId: conflux.id });
  normalizeConfluxBoard(conflux);
  const cfg = plotConfig(config);
  advancePlotMonth(conflux, cfg);

  const addsByDomain = new Map((domains || []).map((d) => [d.id, []]));
  const domainsById = new Map((domains || []).map((d) => [d.id, d]));
  const allPlots = storyPlots(conflux);
  const fullBoard = boardFromPlots(conflux, domains, allPlots);

  const processOutcomes = applyEngineProgress(
    fullBoard,
    rollConfluxProcesses(conflux, domainsById, config),
    { tick: world.tickIndex, config },
  );
  const intelAdds = applyIntelFinishes({ conflux, domains, world, outcomes: processOutcomes });
  for (const row of intelAdds) {
    if (!addsByDomain.has(row.domainId)) addsByDomain.set(row.domainId, []);
    addsByDomain.get(row.domainId).push(row.fact);
  }
  conflux.processes = (conflux.processes || []).map((pr) => {
    const updated = (fullBoard.state.pendingActions || []).find((x) => x.id === pr.id);
    return updated || pr;
  });

  const storyOutcomes = processOutcomes.filter((o) => !o.intel);
  const plots = confluxMonthPlots(conflux);
  if (!plots.length) {
    return { conflux, domains, chronicleAddsByDomain: addsByDomain, processOutcomes: storyOutcomes };
  }

  const board = boardFromPlots(conflux, domains, plots);
  const beatOutcomes = outcomesForPlots(storyOutcomes, plots);
  await realignFinishedOutcomes({ runtime, domain: board, outcomes: beatOutcomes, log });

  const mainId = conflux.mainPlotId;
  beatOutcomes.sort((a, b) => {
    const pa = plots.find((p) => (p.relatedProcessIds || []).includes(a.processId));
    const pb = plots.find((p) => (p.relatedProcessIds || []).includes(b.processId));
    return Number(Boolean(pb?.isMainConflux)) - Number(Boolean(pa?.isMainConflux));
  });

  const { beats } = planBeats({
    domain: board,
    config,
    processOutcomes: beatOutcomes,
    piercePlotIds: mainId ? [mainId] : [],
  });

  log.info('conflux.month.plan', {
    contested: plots.length,
    beats: beats.length,
    plan: beats.map((b) => `${b.title}:${b.reason}`),
  });

  for (const beat of beats) {
    const plot = findPlotline(board, beat.plotId) || plots.find((p) => p.id === beat.plotId);
    if (!plot) continue;
    if (beat.fade) {
      const faded = fadeQuietPlot({ domain: board, plot, world });
      if (faded?.fact) {
        conflux.lore = conflux.lore || [];
        conflux.lore.push(faded.fact);
      }
      continue;
    }
    const logLine = openLogGate(board, plot, config);
    const result = await beatSharedPlot({
      config,
      runtime,
      conflux,
      domains,
      world,
      plot,
      beat,
      logLine,
      log,
    });
    const live = (conflux.plotlines || []).find((p) => p.id === plot.id);
    if (live) Object.assign(live, plot);
    if (result?.closed && !plotHasActiveProcess(board, plot)) {
      closePlotline(board, plot.id, {
        tick: world.tickIndex,
        reason: result.closeReason || 'условие закрытия исполнилось',
        sequelHook: result.sequelHook || '',
      });
      conflux.plotlines = (conflux.plotlines || []).filter((p) => p.id !== plot.id);
      conflux.closedPlotlines = board.closedPlotlines;
    }
    for (const row of result?.cityFacts || []) {
      if (!addsByDomain.has(row.domainId)) addsByDomain.set(row.domainId, []);
      addsByDomain.get(row.domainId).push(row.fact);
    }
  }

  const keepAdds = [];
  for (const adds of addsByDomain.values()) keepAdds.push(...adds);
  const internals = (conflux.lore || []).filter((f) => Number(f.tick) === Number(world.tickIndex));
  await keepSharedStories({
    runtime,
    conflux,
    domains,
    world,
    chronicleAdds: [...internals, ...keepAdds],
    log,
  });

  for (const domain of domains) {
    const adds = addsByDomain.get(domain.id) || [];
    const toScore = factsForStatJudge(adds);
    if (!toScore.length) continue;
    await scoreMonthStats({
      config,
      runtime,
      domain,
      world,
      chronicleAdds: toScore,
      budget: createStatBudget(config),
      log,
    });
  }

  return { conflux, domains, chronicleAddsByDomain: addsByDomain, processOutcomes: storyOutcomes };
}
