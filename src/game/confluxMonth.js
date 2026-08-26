import { getLogger } from '../log.js';
import {
  normalizePlotlines,
  plotConfig,
  findPlotline,
  closePlotline,
  plotHasActiveProcess,
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
  sharedPlots,
  processesForPlots,
} from './confluxBoard.js';
import { beatSharedPlot } from './confluxBeat.js';
import { fadeQuietPlot, keepSharedStories } from './storyteller.js';
import { scoreMonthStats, factsForStatJudge } from './statJudge.js';

function boardFromShared(conflux, domains) {
  const plots = sharedPlots(conflux);
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

function rollSharedProcesses(conflux, plots, domainsById, config, rng = Math.random) {
  const list = processesForPlots(conflux, plots);
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

/**
 * Один ход shared-нитей (включая главную нить стыка). Вызывать раз за мировой тик.
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
  // Часы всех нитей сопряжения (локальных и shared) — всегда, даже если shared ещё нет.
  advancePlotMonth(conflux, cfg);
  const plots = sharedPlots(conflux);
  const addsByDomain = new Map((domains || []).map((d) => [d.id, []]));
  if (!plots.length) {
    return { conflux, domains, chronicleAddsByDomain: addsByDomain };
  }

  const domainsById = new Map(domains.map((d) => [d.id, d]));
  const board = boardFromShared(conflux, domains);

  const processOutcomes = applyEngineProgress(board, rollSharedProcesses(conflux, plots, domainsById, config), {
    tick: world.tickIndex,
    config,
  });
  conflux.processes = (conflux.processes || []).map((pr) => {
    const updated = (board.state.pendingActions || []).find((x) => x.id === pr.id);
    return updated || pr;
  });

  const mainId = conflux.mainPlotId;
  processOutcomes.sort((a, b) => {
    const pa = plots.find((p) => (p.relatedProcessIds || []).includes(a.processId));
    const pb = plots.find((p) => (p.relatedProcessIds || []).includes(b.processId));
    return Number(Boolean(pb?.isMainConflux)) - Number(Boolean(pa?.isMainConflux));
  });

  const { beats } = planBeats({
    domain: board,
    config,
    processOutcomes,
    piercePlotIds: mainId ? [mainId] : [],
  });

  log.info('conflux.month.plan', {
    shared: plots.length,
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

  return { conflux, domains, chronicleAddsByDomain: addsByDomain };
}
