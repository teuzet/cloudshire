/**
 * Месяц города на новых рельсах: событий вне нитей не бывает.
 *
 * Движок считает ход дел, часы нитей, отбор битов и окраску; рассказчик
 * превращает готовые факты в записи хроники. См. docs/PIVOT_PLOTLINES.md.
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
  boardHasRoom,
  pickPlotTags,
  findPlotline,
  closePlotline,
} from './plotlines.js';
import {
  advancePlotMonth,
  planBeats,
  openLogGate,
  createStatBudget,
  ensureErrandForProcess,
  formatBeatPlanForLog,
} from './plotEngine.js';
import { seedPlot, beatPlot, echoDecisions, quietMonth } from './storyteller.js';
import { getLogger } from '../log.js';

function newDecisionsThisMonth(domain, world) {
  const since = Math.max(0, (world.tickIndex || 0) - 1);
  const edicts = (domain.state?.modifiers || []).filter(
    (m) => Number.isInteger(m.declaredTick) && m.declaredTick >= since,
  );
  const acts = (domain.state?.events || []).filter(
    (e) => e?.kind === 'act' && Number.isInteger(e.declaredTick) && e.declaredTick >= since,
  );
  return { edicts, acts };
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
    budget: { world: budget.world, player: budget.player },
  });

  // 4. Биты.
  for (const beat of beats) {
    const plot = findPlotline(working, beat.plotId);
    if (!plot) continue;
    const logLine = openLogGate(working, plot, config);
    const result = await beatPlot({
      config,
      runtime,
      domain: working,
      world,
      beat,
      logLine,
      budget,
      partner,
      confluxId,
      log,
    });
    if (result?.mirror?.fact) mirrorAdds.push(result.mirror.fact);
    if (result?.fact) {
      chronicleAdds.push(result.fact);
    } else {
      // Рассказчик не справился — движок пишет сухой минимум, чтобы месяц не пропал.
      const fact = createLoreFact({
        id: newId('lore'),
        text: beat.finale
          ? `История «${beat.title}» закончилась.`
          : `В деле «${beat.title}» произошёл сдвиг.`,
        tags: ['chronicle'],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'month-fallback',
        importance: 'minor',
        relatedPlotlineIds: [beat.plotId],
      });
      working.lore.push(fact);
      chronicleAdds.push(fact);
      if (beat.finale) closePlotline(working, beat.plotId, { tick: world.tickIndex, reason: 'fallback' });
    }
  }

  // 5. Завязка новой нити, если доска не полна.
  const room = boardHasRoom(working, cfg);
  const wantSeed = room.story && Math.random() < cfg.beats.baseChance + (working.plotlines.length === 0 ? 0.5 : 0);
  if (wantSeed) {
    const tags = pickPlotTags(cfg);
    const seeded = await seedPlot({ config, runtime, domain: working, world, tags, log });
    if (seeded?.fact) chronicleAdds.push(seeded.fact);
  }

  // 6. Отзвук воли покровителя.
  const { edicts, acts } = newDecisionsThisMonth(working, world);
  if (edicts.length || acts.length) {
    const echo = await echoDecisions({
      config,
      runtime,
      domain: working,
      world,
      edicts,
      acts,
      budget,
      log,
    });
    if (echo?.fact) chronicleAdds.push(echo.fact);
    // Деяния — разовые: отыграны и уходят из состояния месяца.
    working.state.events = (working.state.events || []).filter((e) => !acts.includes(e));
  }

  // 7. Тихий месяц.
  if (!chronicleAdds.length) {
    const quiet = await quietMonth({ config, runtime, domain: working, world, log });
    if (quiet?.fact) chronicleAdds.push(quiet.fact);
  }

  refreshChronicleDigest(working, config);
  working.lastTickAt = new Date().toISOString();

  log.info('month.done', {
    chronicle: chronicleAdds.length,
    plots: working.plotlines.length,
    budgetSpent: { world: budget.spentWorld, player: budget.spentPlayer },
    stats: working.stats,
  });

  return { domain: working, chronicleAdds, mirrorAdds };
}
