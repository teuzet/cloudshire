/**
 * Месяц города на новых рельсах: событий вне нитей не бывает.
 *
 * Движок считает ход дел, часы нитей, отбор битов и окраску; рассказчик
 * пишет хронику; оценщик статов читает записи месяца и ставит след.
 * См. docs/PIVOT_PLOTLINES.md и docs/STANDING_ORDERS.md.
 */

import { newId } from './ids.js';
import { createLoreFact, normalizeDomain } from './models.js';
import { FINISH_SHORT } from './rolls.js';
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
  pickSequelSeed,
  findPlotline,
  closePlotline,
  plotHasActiveProcess,
  attachChronicleToPlotlines,
  countOpen,
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
import { planOrderTicks, pickOrderOutcome } from './orders.js';
import { resolvePendingOrders } from './orderSmith.js';
import { seedPlot, beatPlot, tickOrder, quietMonth, keepStories, fadeQuietPlot } from './storyteller.js';
import { scoreMonthStats, factsForStatJudge } from './statJudge.js';
import { runSteward } from './steward.js';
import { getLogger } from '../log.js';
import {
  hydrateDomainFromConflux,
  dehydrateDomainToConflux,
  maybeLeakPlot,
  otherDomainId,
  isSharedPlot,
} from './confluxBoard.js';

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
  conflux = null,
  skipPlotClocks = false,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({
    scope: 'month',
    domainId: domain.id,
    name: domain.name,
  });
  const working = structuredClone(domain);
  normalizeDomain(working);
  if (conflux) hydrateDomainFromConflux(working, conflux, { mode: 'month' });
  normalizePlotlines(working, config);
  normalizeDomainProcesses(working, config);
  if (typeof working.population !== 'number') working.population = config.genesis.population.min;

  const cfg = plotConfig(config);
  const chronicleAdds = [];
  const mirrorAdds = [];
  const budget = createStatBudget(config);

  // 0. С четвёртого тихого месяца стюард заводит дело до хода месяца.
  // Письмо пишет tickNews по хронике, не стюард.
  const steward = await runSteward({
    config,
    runtime,
    domain: working,
    world,
    log,
  });
  if (steward?.chronicleAdds?.length) chronicleAdds.push(...steward.chronicleAdds);

  // 0b. Заявки на указы: карточки до тика нитей, чтобы «начиная сейчас» могло сработать в этом месяце.
  const orderCards = await resolvePendingOrders({
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

  // 2. Часы доски (нити указов не стареют). На конфлюксе часы shared/локальных уже тикнули.
  if (!skipPlotClocks) advancePlotMonth(working, cfg);

  // 3. План битов: процессы всегда, истории — в остаток.
  const { beats, slotsUsed, cap } = planBeats({ domain: working, config, processOutcomes });
  let used = slotsUsed;
  log.info('month.plan', {
    beats: beats.length,
    slotsUsed,
    cap,
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
    orderCards: orderCards.map((r) => r.action),
    budget: { world: budget.world, player: budget.player },
  });

  // 4. Биты процессов и историй.
  const sequelOffers = [];
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
    if (conflux && result?.fact && plot && !isSharedPlot(plot)) {
      const other = otherDomainId(conflux, working.id);
      if (other && maybeLeakPlot(plot, conflux, other)) {
        log.info('conflux.plot_leaked', { plotId: plot.id, title: plot.title, to: other });
      }
    }
    if (result?.fact) {
      chronicleAdds.push(result.fact);
      if (result.closed) {
        raiseHighlight({
          kind: 'finale',
          title: plot.title,
          text: result.fact.text,
          note: `история «${plot.title}» кончилась`,
        });
        if (result.sequelHook) {
          sequelOffers.push({
            id: plot.id,
            title: plot.title,
            synopsis: plot.synopsis,
            closeWhen: plot.closeWhen,
            reason: result.closeReason || '',
            hook: result.sequelHook,
            lastEntry: result.fact.text,
          });
        }
      }
    } else {
      const outcome = beat.processOutcome;
      const text = beat.finale
        ? `История «${beat.title}» закончилась.`
        : outcome?.finished
          ? `Дело «${outcome.summary}» закончилось. Исход: ${FINISH_SHORT[outcome.finish] || FINISH_SHORT.ok}.`
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

  // 5. Указы: расписание — всегда, даже сверх лимита; вероятность — только в остаток слотов.
  const orderPlan = planOrderTicks({
    domain: working,
    config,
    slotsLeft: Math.max(0, cap - used),
    tick: world.tickIndex,
  });
  for (const item of orderPlan) {
    const plot = findPlotline(working, item.plotId);
    if (!plot) continue;
    const mode = pickOrderOutcome(working, cfg);
    const result = await tickOrder({
      config,
      runtime,
      domain: working,
      world,
      plot,
      mode,
      log,
    });
    if (result?.fact) {
      chronicleAdds.push(result.fact);
      used += 1;
    }
  }

  // 6. Посев мира: после указов, только в остаток слота и если живых историй нет.
  const { stories } = countOpen(working);
  const sequel = pickSequelSeed(working, sequelOffers, cfg);
  const seedChance = sequel ? 1 : plotSeedChance(working, cfg, world.tickIndex);
  const wantSeed =
    cap - used > 0 &&
    (Boolean(sequel) || stories === 0) &&
    (Boolean(sequel) || Math.random() < seedChance);
  if (wantSeed) {
    const seeded = await seedPlot({
      config,
      runtime,
      domain: working,
      world,
      fromClosed: sequel,
      log,
    });
    if (seeded?.fact) {
      chronicleAdds.push(seeded.fact);
      used += 1;
    }
  }

  // 7. Тихий месяц: без сюжета, но город всё равно жил.
  if (!chronicleAdds.length) {
    const quiet = await quietMonth({ config, runtime, domain: working, world, log });
    if (quiet?.fact) chronicleAdds.push(quiet.fact);
  }

  // 8. Оценщик статов: только события. Тихий месяц без сюжета — не зовём.
  const toScore = factsForStatJudge(chronicleAdds);
  const scored = toScore.length
    ? await scoreMonthStats({
        config,
        runtime,
        domain: working,
        world,
        chronicleAdds: toScore,
        budget,
        log,
      })
    : { scored: 0, catastrophe: null };
  if (scored?.catastrophe) {
    raiseHighlight({
      kind: 'catastrophe',
      title: scored.catastrophe.title,
      text: scored.catastrophe.text,
    });
  }

  // 9. Хранитель: синопсисы по свежей хронике; «история всплыла» → жар считает движок.
  const kept = await keepStories({
    config,
    runtime,
    domain: working,
    world,
    chronicleAdds,
    log,
  });

  clearMonthLog(working);

  refreshChronicleDigest(working, config);
  working.lastTickAt = new Date().toISOString();

  log.info('month.done', {
    chronicle: chronicleAdds.length,
    plots: working.plotlines.length,
    slotsUsed: used,
    cap,
    seedChance: Number(seedChance.toFixed(2)),
    seeded: wantSeed,
    sequelOf: sequel?.id || null,
    ordersPlanned: orderPlan.length,
    kept: kept ? { updated: kept.updated, surfaced: kept.surfaced } : null,
    statsScored: scored?.scored ?? 0,
    steward: steward?.act || null,
    highlight: highlight ? `${highlight.kind}: ${highlight.title}` : null,
    budgetSpent: { world: budget.spentWorld, player: budget.spentPlayer },
    stats: working.stats,
  });

  if (conflux) dehydrateDomainToConflux(working, conflux);

  return { domain: working, chronicleAdds, mirrorAdds, highlight, stewardActs: steward?.act ? [steward.act] : [] };
}
