/**
 * Месяц города на новых рельсах: событий вне нитей не бывает.
 *
 * Движок считает ход дел, часы нитей, отбор битов и окраску; рассказчик
 * пишет хронику; оценщик статов читает записи месяца и ставит след.
 * См. docs/PIVOT_PLOTLINES.md.
 */

import { newId } from './ids.js';
import { createLoreFact, normalizeDomain } from './models.js';
import { refreshChronicleDigest } from './memory.js';
import {
  normalizeDomainProcesses,
  activeProcesses,
  rollAllProcessAdvances,
  applyEngineProgress,
} from './processes.js';
import {
  normalizePlotlines,
  plotConfig,
  plotSeedChance,
  findPlotline,
  closePlotline,
  plotHasActiveProcess,
  attachChronicleToPlotlines,
} from './plotlines.js';
import {
  advancePlotMonth,
  planBeats,
  openLogGate,
  createStatBudget,
  ensureErrandForProcess,
  formatBeatPlanForLog,
  clearMonthLog,
} from './plotEngine.js';
import { seedPlot, beatPlot, echoDecisions, quietMonth, keepStories, fadeQuietPlot } from './storyteller.js';
import { scoreMonthStats } from './statJudge.js';
import { runSteward } from './steward.js';
import { getLogger } from '../log.js';

/** Указы, объявленные в этом месяце: их последствия и отыгрывает отзвук. */
function newEdictsThisMonth(domain, world) {
  const since = Math.max(0, (world.tickIndex || 0) - 1);
  return (domain.state?.modifiers || []).filter(
    (m) => Number.isInteger(m.declaredTick) && m.declaredTick >= since,
  );
}

/**
 * Один месяц одного города.
 * @returns {{ domain: object, chronicleAdds: object[] }}
 */
export async function resolveDomainMonth({
  config,
  runtime,
  domain,
  world,
  partner = null,
  confluxId = null,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({
    scope: 'month',
    domainId: domain.id,
    name: domain.name,
  });
  const working = structuredClone(domain);
  normalizeDomain(working);
  normalizePlotlines(working, config);
  normalizeDomainProcesses(working, config);
  if (typeof working.population !== 'number') working.population = config.genesis.population.min;

  const cfg = plotConfig(config);
  const chronicleAdds = [];
  const mirrorAdds = [];
  const budget = createStatBudget(config);

  // 0. Покровитель молчит — правитель может сам отдать один приказ (дело или указ).
  const steward = await runSteward({
    config,
    runtime,
    domain: working,
    world,
    log,
  });
  // Пик месяца: то, с чего правитель начнёт письмо. Без него развязка тонет
  // в ряду обычных записей и большое дело проходит незамеченным.
  let highlight = null;
  const raiseHighlight = (next) => {
    const rank = { finale: 1, catastrophe: 2 };
    if (!highlight || rank[next.kind] > rank[highlight.kind]) highlight = next;
  };

  // 1. Дела: ход считает движок, у каждого дела есть нить.
  for (const process of activeProcesses(working, config)) {
    ensureErrandForProcess(working, process, { tick: world.tickIndex, config });
  }
  const processRolls = rollAllProcessAdvances(working, config);
  const processOutcomes = applyEngineProgress(working, processRolls, {
    tick: world.tickIndex,
    config,
  });

  // 2. Часы доски.
  advancePlotMonth(working, cfg);

  // 3. План битов: обязательные впереди, потолок пробивают.
  const beats = planBeats({ domain: working, config, processOutcomes });
  log.info('month.plan', {
    beats: beats.length,
    mandatory: beats.filter((b) => b.mandatory).length,
    plan: formatBeatPlanForLog(beats),
    processes: processOutcomes.map((o) => ({
      id: o.processId,
      summary: o.summary,
      kind: o.kind,
      advance: o.advance,
      left: `${o.monthsLeftBefore}→${o.monthsLeft}`,
      finished: o.finished,
    })),
    budget: { world: budget.world, player: budget.player },
  });

  // 4. Биты.
  for (const beat of beats) {
    const plot = findPlotline(working, beat.plotId);
    if (!plot) continue;
    if (beat.fade) {
      const faded = fadeQuietPlot({ domain: working, plot, world });
      if (faded?.fact) chronicleAdds.push(faded.fact);
      log.info('month.plot_faded', { plotId: plot.id, title: plot.title });
      continue;
    }
    const logLine = openLogGate(working, plot, config);
    const result = await beatPlot({
      config,
      runtime,
      domain: working,
      world,
      beat,
      logLine,
      partner,
      confluxId,
      log,
    });
    if (result?.mirror?.fact) mirrorAdds.push(result.mirror.fact);
    if (result?.fact) {
      chronicleAdds.push(result.fact);
      if (result.closed) {
        raiseHighlight({
          kind: 'finale',
          title: plot.title,
          text: result.fact.text,
          note: `история «${plot.title}» кончилась`,
        });
      }
    } else {
      // Рассказчик не справился — движок пишет сухой минимум, чтобы месяц не пропал.
      const outcome = beat.processOutcome;
      const text = beat.finale
        ? `История «${beat.title}» закончилась.`
        : outcome?.finished
          ? `Дело «${outcome.summary}» закончилось.`
          : outcome
            ? `В деле «${outcome.summary}» произошёл сдвиг.`
            : `В истории «${beat.title}» произошёл сдвиг.`;
      const fact = createLoreFact({
        id: newId('lore'),
        text,
        tags: ['chronicle'],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'month-fallback',
        importance: beat.finale || outcome?.finished ? 'major' : 'minor',
        relatedPlotlineIds: [beat.plotId],
        relatedPendingId: outcome?.processId || null,
        processFinish: outcome?.finished ? outcome.finish || null : null,
      });
      working.lore.push(fact);
      attachChronicleToPlotlines(working, fact.id, [beat.plotId]);
      chronicleAdds.push(fact);
      plot.lastBeatTick = world.tickIndex;
      plot.beatCount += 1;
      if (beat.finale && !plotHasActiveProcess(working, plot)) {
        closePlotline(working, beat.plotId, { tick: world.tickIndex, reason: 'fallback' });
      }
    }
  }

  // 5. Завязка новой нити: чем пустее доска, тем охотнее.
  const seedChance = plotSeedChance(working, cfg, world.tickIndex);
  const wantSeed = Math.random() < seedChance;
  if (wantSeed) {
    const seeded = await seedPlot({ config, runtime, domain: working, world, log });
    if (seeded?.fact) chronicleAdds.push(seeded.fact);
  }

  // 6. Отзвук воли покровителя: указы этого месяца.
  const edicts = newEdictsThisMonth(working, world);
  if (edicts.length) {
    const echo = await echoDecisions({
      config,
      runtime,
      domain: working,
      world,
      edicts,
      log,
    });
    if (echo?.fact) chronicleAdds.push(echo.fact);
  }

  // 7. Тихий месяц: без сюжета, но город всё равно жил.
  if (!chronicleAdds.length) {
    const quiet = await quietMonth({ config, runtime, domain: working, world, log });
    if (quiet?.fact) chronicleAdds.push(quiet.fact);
  }

  // 8. Оценщик статов: читает записи месяца и ставит след. Величину считает движок.
  const scored = await scoreMonthStats({
    config,
    runtime,
    domain: working,
    world,
    chronicleAdds,
    budget,
    log,
  });
  if (scored?.catastrophe) {
    raiseHighlight({
      kind: 'catastrophe',
      title: scored.catastrophe.title,
      text: scored.catastrophe.text,
    });
  }

  // 9. Хранитель: синопсисы по свежей хронике; «история всплыла» → жар считает движок.
  // Журнал месяца ещё жив: по нему хранитель видит, о чём говорили до тика.
  const kept = await keepStories({
    config,
    runtime,
    domain: working,
    world,
    chronicleAdds,
    log,
  });

  // Журнал донёс разговоры до тика и здесь же гасится: чистить его снаружи нельзя —
  // там остаётся объект домена до резолва, и запись поверх стирает весь месяц.
  clearMonthLog(working);

  refreshChronicleDigest(working, config);
  working.lastTickAt = new Date().toISOString();

  log.info('month.done', {
    chronicle: chronicleAdds.length,
    plots: working.plotlines.length,
    seedChance: Number(seedChance.toFixed(2)),
    seeded: wantSeed,
    kept: kept ? { updated: kept.updated, surfaced: kept.surfaced } : null,
    statsScored: scored?.scored ?? 0,
    steward: steward?.act || null,
    highlight: highlight ? `${highlight.kind}: ${highlight.title}` : null,
    budgetSpent: { world: budget.spentWorld, player: budget.spentPlayer },
    stats: working.stats,
  });

  return { domain: working, chronicleAdds, mirrorAdds, highlight, stewardActs: steward?.act ? [steward.act] : [] };
}
