import { getLogger } from '../log.js';
import { newId } from './ids.js';
import {
  plotConfig,
  findPlotline,
  closePlotline,
  plotHasActiveProcess,
  isOrderPlot,
  attachChronicleToPlotlines,
} from './plotlines.js';
import {
  advancePlotMonth,
  planBeats,
  openLogGate,
  createStatBudget,
  applyQueuedEngineProgress,
  rehomeUnrelatedOnDomain,
} from './plotEngine.js';
import { processStatAverage } from './processes.js';
import {
  normalizeConfluxBoard,
  processesForPlots,
  confluxMonthPlots,
  applyIntelFinishes,
} from './confluxBoard.js';
import { beatSharedPlot } from './confluxBeat.js';
import { fadeQuietPlot, keepSharedStories } from './storyteller.js';
import { markChroniclePlotClosed, createLoreFact } from './models.js';
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

function bindLiveConfluxBoard(conflux, domains, plots) {
  const board = boardFromPlots(conflux, domains, plots);
  board.plotlines = conflux.plotlines || [];
  board.state.pendingActions = conflux.processes || [];
  return board;
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
  const fullBoard = bindLiveConfluxBoard(conflux, domains, allPlots);
  rehomeUnrelatedOnDomain(fullBoard, { tick: world.tickIndex, config });
  const processOutcomes = applyQueuedEngineProgress(fullBoard, {
    tick: world.tickIndex,
    config,
    averageOf: (p) => {
      const owner = domainsById.get(p.ownerDomainId) || [...domainsById.values()][0];
      return processStatAverage(owner || { stats: {} }, p, config);
    },
  });
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

  const board = bindLiveConfluxBoard(conflux, domains, plots);
  const beatOutcomes = outcomesForPlots(storyOutcomes, plots);
  await realignFinishedOutcomes({ runtime, domain: board, outcomes: beatOutcomes, log });
  rehomeUnrelatedOnDomain(board, { tick: world.tickIndex, config });

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

  for (const beat of beats) {
    for (const row of beat.mootedProcesses || []) {
      const fact = createLoreFact({
        id: newId('lore'),
        text: `Поручение «${row.summary}» свернули: нужда отпала.`,
        tags: ['chronicle'],
        gameDateLabel: world.gameDate?.label,
        tick: world.tickIndex,
        author: 'engine:moot',
        importance: 'minor',
        relatedPendingId: row.id,
        relatedPlotlineIds: [beat.plotId],
        sourcePlotId: beat.plotId,
      });
      conflux.lore = conflux.lore || [];
      conflux.lore.push(fact);
      attachChronicleToPlotlines(board, fact.id, [beat.plotId]);
    }
  }

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
      const closeReason = result.closeReason || 'условие закрытия исполнилось';
      closePlotline(board, plot.id, {
        tick: world.tickIndex,
        reason: closeReason,
        sequelHook: result.sequelHook || '',
      });
      markChroniclePlotClosed(result.fact, { reason: closeReason });
      for (const row of result.cityFacts || []) {
        markChroniclePlotClosed(row.fact, { reason: closeReason });
      }
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
