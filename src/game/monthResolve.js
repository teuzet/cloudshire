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
  allowSequelAfter,
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
import { planOrderTicks, pickOrderOutcome, expireTimedOrders } from './orders.js';
import { resolvePendingOrders } from './orderSmith.js';
import { fireConfluxDockOrder } from './orderDock.js';
import { seedPlot, beatPlot, tickOrder, quietMonth, keepStories, fadeQuietPlot } from './storyteller.js';
import { resolveSuspenseLegacy } from './legacyResolver.js';
import { scoreMonthStats, factsForStatJudge } from './statJudge.js';
import { runSteward } from './steward.js';
import { getLogger } from '../log.js';
import { realignFinishedOutcomes } from './plotAlign.js';
import {
  hydrateDomainFromConflux,
  dehydrateDomainToConflux,
  maybeLeakChronicle,
  otherDomainId,
  copyChronicleToAwareCities,
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
  extraProcessOutcomes = [],
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
  const flowAdds = [];
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
  const expiredOrders = expireTimedOrders(working, world.tickIndex);
  for (const row of expiredOrders) {
    const title = row.plot?.title || 'порядок';
    const rule = String(row.modifier?.text || title).trim();
    const fact = createLoreFact({
      id: newId('lore'),
      text: `Срок порядка «${title}» истёк. Правило больше не действует: ${rule}`,
      tags: ['chronicle', 'order', 'expired'],
      gameDateLabel: world.gameDate?.label,
      tick: world.tickIndex,
      author: 'order-expire',
      importance: 'minor',
      relatedPlotlineIds: row.plot?.id ? [row.plot.id] : [],
    });
    working.lore = working.lore || [];
    working.lore.push(fact);
    chronicleAdds.push(fact);
  }

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
  const processRolls = rollAllProcessAdvances(working, config).filter((r) => {
    const proc = (working.state?.pendingActions || []).find((p) => p.id === r.processId);
    return !proc?.confluxId;
  });
  const localOutcomes = applyEngineProgress(working, processRolls, {
    tick: world.tickIndex,
    config,
  });
  const extra = (extraProcessOutcomes || []).filter((o) => {
    const plots = (working.plotlines || []).filter((p) =>
      (p.relatedProcessIds || []).includes(String(o.processId)),
    );
    return plots.length > 0 && !o.intel;
  });
  const processOutcomes = [...localOutcomes, ...extra];
  await realignFinishedOutcomes({ runtime, domain: working, outcomes: processOutcomes, log });

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
    expiredOrders: expiredOrders.length,
    budget: { world: budget.world, player: budget.player },
  });

  // 4. Биты процессов и историй.
  const sequelOffers = [];
  const suspenseClosures = [];
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
    if (conflux && result?.fact && plot) {
      const flowed = copyChronicleToAwareCities({
        plot,
        fact: result.fact,
        conflux,
        domains: partner ? [working, partner] : [working],
      });
      for (const row of flowed) flowAdds.push(row);
      const other = otherDomainId(conflux, working.id);
      const otherDomain = partner && String(partner.id) === String(other) ? partner : null;
      if (
        other &&
        otherDomain &&
        maybeLeakChronicle({
          plot,
          fact: result.fact,
          conflux,
          viewerId: other,
          viewerDomain: otherDomain,
          domains: partner ? [working, partner] : [working],
        })
      ) {
        log.info('conflux.chronicle_leaked', { plotId: plot.id, title: plot.title, to: other });
        const leaked = (otherDomain.lore || []).filter((f) => f.leakedFromId === result.fact.id);
        for (const fact of leaked) flowAdds.push({ domainId: other, fact });
      }
    }
    if (result?.fact) {
      chronicleAdds.push(result.fact);
      if (result.closed) {
        raiseHighlight({
          kind: 'finale',
          title: plot.title,
          text: result.fact.text,
          note: result.closeReason || 'история дошла до конца',
        });
        if (plot.storyType === 'suspense') {
          suspenseClosures.push({
            id: plot.id,
            title: plot.title,
            synopsis: plot.synopsis,
            gravity: plot.gravity,
            depth: plot.depth,
            ending: plot.ending,
            lastEntry: result.fact.text,
            closeReason: result.closeReason || '',
            hook: result.sequelHook || '',
          });
        }
        if (result.sequelHook && allowSequelAfter(plot)) {
          sequelOffers.push({
            id: plot.id,
            title: plot.title,
            synopsis: plot.synopsis,
            closeWhen: plot.closeWhen,
            reason: result.closeReason || '',
            hook: result.sequelHook,
            lastEntry: result.fact.text,
            gravity: plot.gravity,
            storyType: plot.storyType,
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

  // 5. Указы: расписание и сопряжение — всегда, даже сверх лимита; вероятность — только в остаток слотов.
  const orderPlan = planOrderTicks({
    domain: working,
    config,
    slotsLeft: Math.max(0, cap - used),
    tick: world.tickIndex,
    conflux,
  });
  for (const item of orderPlan) {
    const plot = findPlotline(working, item.plotId);
    if (!plot) continue;
    if (item.event === 'conflux_dock') {
      const result = await fireConfluxDockOrder({
        config,
        runtime,
        domain: working,
        world,
        plot,
        conflux,
        partner,
        log,
      });
      if (result?.fact) {
        chronicleAdds.push(result.fact);
        used += 1;
      }
      continue;
    }
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

  // 6. Посев мира: сиквел занимает освободившийся слот; иначе обычный посев, если живых историй нет.
  const { stories } = countOpen(working);
  const sequel = pickSequelSeed(working, sequelOffers, cfg);
  const seedChance = sequel ? 1 : plotSeedChance(working, cfg, world.tickIndex);
  const wantSeed =
    cap - used > 0 &&
    (Boolean(sequel) || stories === 0) &&
    (Boolean(sequel) || Math.random() < seedChance);
  let sequelledId = null;
  if (wantSeed) {
    const seeded = await seedPlot({
      config,
      runtime,
      domain: working,
      world,
      fromClosed: sequel,
      storyType:
        sequel?.storyType === 'mystery' || sequel?.storyType === 'suspense' ? sequel.storyType : null,
      log,
    });
    if (seeded?.fact) {
      chronicleAdds.push(seeded.fact);
      used += 1;
    }
    if (seeded?.plot && sequel?.id) sequelledId = sequel.id;
  }

  for (const closed of suspenseClosures) {
    if (closed.id === sequelledId) continue;
    const legacy = await resolveSuspenseLegacy({
      runtime,
      domain: working,
      world,
      closed,
      config,
      log,
    });
    if (legacy?.facts?.length) chronicleAdds.push(...legacy.facts);
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
    kept: kept ? { updated: kept.updated } : null,
    statsScored: scored?.scored ?? 0,
    steward: steward?.act || null,
    highlight: highlight ? `${highlight.kind}: ${highlight.title}` : null,
    budgetSpent: { world: budget.spentWorld, player: budget.spentPlayer },
    stats: working.stats,
  });

  if (conflux) dehydrateDomainToConflux(working, conflux);

  return { domain: working, chronicleAdds, mirrorAdds, flowAdds, highlight, stewardActs: steward?.act ? [steward.act] : [] };
}
