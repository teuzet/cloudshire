/**
 * Непрерывный ход мира: события вместо тика.
 *
 * Тик был одновременно часами, батчером и рейт-лимитером. Здесь эти три вещи
 * разъехались: часы — `gameClock`, очередь событий — `scheduler`, разрежение
 * пушей — `notify`. Каждое событие разрешается в свой день и порождает ровно
 * одну запись в хронике, о которой жрец говорит сразу.
 *
 * Обработчики ниже — чистые относительно ввода-вывода: они меняют домен и
 * ставят задания в мир, но ничего не сохраняют и не отправляют. Отправку и
 * запись делает оркестратор в конце файла. Так их можно проверять без хранилища.
 */

import { newId } from './ids.js';
import { createLoreFact, markChroniclePlotClosed } from './models.js';
import { gameDateFromDay } from './gameClock.js';
import {
  scheduleJob,
  cancelJobsForPlot,
  cancelJobs,
  dueJobs,
  claimJob,
  completeJob,
  failJob,
} from './scheduler.js';
import {
  findPlotline,
  closePlotline,
  attachChronicleToPlotlines,
  isStakedStory,
  plotsForProcess,
  plotConfig,
  countOpen,
  normalizePlotlines,
  rollWoundStatBudget,
  rollStoryCompletionBudget,
} from './plotlines.js';
import { plotHostId } from './confluxBoard.js';
import { normalizeDomainProcesses, processIsLive } from './processes.js';
import { releaseOfficerProcess } from './officers.js';
import { normalizeDeed, rollDeedFinish, finishDeed, deedOutcome } from './deeds.js';
import { applyDeedToPlot } from './deedResolve.js';
import { alignmentOf } from './deedAlign.js';
import {
  liveThreats,
  findThreat,
  fireThreat,
  firedThreatScale,
  neutralEndingDue,
  normalizePlotThreats,
} from './threats.js';
import { fillStageThreats } from './threatSmith.js';
import { pickConsequenceThreat } from './threatPick.js';
import { pickNeutralThreat } from './neutralPick.js';
import { ensurePressure, fillDay, pressureAt, resetPressure } from './pressure.js';
import {
  deedTriggerLines,
  failedDeedCauseLines,
  fallbackDeedEntry,
  formatDeedPrompt,
  formatFinalePrompt,
  formatThreatPrompt,
  plotChronicleTail,
  threatTriggerLines,
  writeChronicle,
  deedActor,
  deedActorGender,
  CHRONICLE_FINALE_MAX,
} from './chronicler.js';
import { reconcilePlot } from './reconciler.js';
import { expirePauses } from './reconcile.js';
import {
  decideSeedAttempt,
  scheduleNextAttempt,
  applySeedCooldown,
  enqueueSeedRequest,
  offerErrandSeed,
  dueSeedRequests,
  dropSeedRequest,
  checkSeedFreshness,
  postponeSeedRequest,
} from './seedSchedule.js';
import { grainForSource, openingGrain, openingVoidGrain, yearChronicleGrain, formatChronicleGrain } from './seedChannels.js';
import { applyRuleDeed } from './cityRules.js';
import { plantStakedStory } from './storyteller.js';
import { accrueMana } from './mana.js';
import { countEvent, markReported, pickReportSubject } from './priestOrders.js';
import { decideAsk } from './herald.js';
import { writePairChronicle, confluxEvent, spreadChronicleToPair, formatPairArchive, narratePairDeed } from './confluxCanon.js';
import { formatPassageForPrompt } from './passage.js';
import { secretRevealTexts } from './deedConflux.js';
import { releasePassageHold } from './passage.js';
import { getLogger } from '../log.js';

/** Запись хроники события. День обязателен: по нему живёт вся новая механика. */
export function appendEventFact(
  domain,
  world,
  {
    text,
    plotId = null,
    processId = null,
    day = 0,
    author = 'engine',
    importance = 'major',
    tags = ['chronicle'],
    finish = null,
    secret = false,
    secretForDomainId = null,
    extra = {},
  },
) {
  const fact = createLoreFact({
    id: newId('lore'),
    text: String(text || '').slice(0, 1200),
    tags,
    gameDateLabel: gameDateFromDay(day).label,
    tick: world?.tickIndex ?? null,
    day,
    author,
    importance,
    relatedPendingId: processId || null,
    relatedPlotlineIds: plotId ? [plotId] : null,
    sourcePlotId: plotId || null,
    processFinish: finish || null,
    secret: Boolean(secret),
    secretForDomainId: secretForDomainId || null,
  });
  const completion = Number(extra.completionBudget);
  if (Number.isFinite(completion) && completion > 0) fact.completionBudget = Math.round(completion);
  if (extra.statPocket) fact.statPocket = extra.statPocket;
  if (extra.endingKind) fact.endingKind = extra.endingKind;
  if (extra.plotClosed) fact.plotClosed = true;
  const wound = Number(extra.woundBudget);
  if (Number.isFinite(wound) && wound > 0) fact.woundBudget = Math.round(wound);
  const gain = Number(extra.depthGain);
  if (Number.isFinite(gain) && gain > 0) fact.depthGain = gain;
  domain.lore = Array.isArray(domain.lore) ? domain.lore : [];
  domain.lore.push(fact);
  if (plotId) attachChronicleToPlotlines(domain, fact.id, [plotId]);
  return fact;
}

/** Один job на историю: день, когда шкала дойдёт до ста. */
export function schedulePressureJob(world, domain, plot) {
  if (!world || !plot) return null;
  const due = fillDay(plot);
  if (due == null) return null;
  const existing = (world.jobs || []).find(
    (j) => j.state === 'pending' && j.kind === 'pressure_fire' && j.payload?.plotId === plot.id,
  );
  if (existing) {
    existing.dueDay = due;
    return existing;
  }
  return scheduleJob(world, {
    domainId: domain?.id || null,
    kind: 'pressure_fire',
    dueDay: due,
    payload: { plotId: plot.id },
  });
}

/**
 * Снять задания, которым не на что срабатывать.
 *
 * Нить может исчезнуть — её закрыли, сбросили или потеряли на гонке записи, —
 * а задание на её угрозу останется ждать своего дня. В живом мире таких
 * висело два: срок приходил, обработчик не находил нити и молчал, но день
 * мира всё равно просыпался на них.
 */
export function sweepOrphanJobs(world, domain, { conflux = null, log = null } = {}) {
  if (!world || !domain) return [];
  const plots = new Set((domain.plotlines || []).map((p) => p.id));
  if (conflux) {
    for (const plot of conflux.plotlines || []) plots.add(plot.id);
  }
  const deeds = new Set((domain.state?.pendingActions || []).map((a) => a.id));
  const dropped = cancelJobs(world, (job) => {
    if (job.domainId !== domain.id) return false;
    if (job.kind === 'pressure_fire' || job.kind === 'threat_fire') {
      return job.payload?.plotId && !plots.has(job.payload.plotId);
    }
    if (job.kind === 'process_finish') return job.payload?.processId && !deeds.has(job.payload.processId);
    return false;
  });
  for (const job of dropped) {
    (log || getLogger()).warn('loop.job_orphan', {
      domainId: domain.id,
      kind: job.kind,
      dueDay: job.dueDay,
      payload: job.payload || null,
    });
  }
  return dropped;
}

/**
 * Завести шкалу, если её ещё нет, наполнить пул стадии и поставить день срабатывания.
 */
export async function ensurePlotObligations({
  runtime,
  domain,
  loreDomain = null,
  world,
  plot,
  day = 0,
  config = null,
  rng = Math.random,
  log,
} = {}) {
  if (!plot || !isStakedStory(plot) || plot.status === 'closed') return [];
  normalizePlotThreats(plot);
  ensurePressure(plot, day, config, rng);
  const created = await fillStageThreats({
    runtime,
    domain: loreDomain || domain,
    plot,
    day,
    config,
    rng,
    log,
  });
  schedulePressureJob(world, domain, plot);
  return created;
}

/**
 * Живые и поставленные на паузу дела этой истории отменяются вместе с ней.
 * Уже завершённое дело, которым история закрылась, не трогаем.
 * Дело может лежать на домене истории или на соседнем, если шло через проход.
 */
function cancelDeedsForClosedPlot(domains, world, plot, day) {
  const plotId = String(plot?.id || '');
  const related = new Set((plot?.relatedProcessIds || []).map(String));
  const seen = new Set();
  for (const board of domains) {
    if (!board) continue;
    for (const process of board.state?.pendingActions || []) {
      if (!process || seen.has(process.id)) continue;
      const linked =
        String(process.plotlineId || '') === plotId || related.has(String(process.id));
      if (!linked) continue;
      seen.add(process.id);
      if (!processIsLive(process)) continue;
      process.status = 'cancelled';
      process.cancelledDay = Math.round(Number(day) || 0);
      process.cancelReason = 'история закрыта';
      releaseOfficerProcess(board, process);
      if (world) cancelDeedJobs(world, process.id);
    }
  }
}

/** Закрыть нить и снять с очереди всё, что на неё было заведено. */
export function closePlotWithJobs(
  domain,
  world,
  plot,
  { day = 0, reason = '', fact = null, alsoDomains = [] } = {},
) {
  if (!plot) return null;
  for (const threat of liveThreats(plot)) {
    threat.status = 'cancelled';
    threat.cancelledDay = day;
    threat.cancelReason = 'история закрыта';
  }
  cancelDeedsForClosedPlot([domain, ...alsoDomains], world, plot, day);
  if (world) cancelJobsForPlot(world, plot.id);
  const closed = closePlotline(domain, plot.id, { tick: world?.tickIndex ?? null, reason });
  if (fact) markChroniclePlotClosed(fact, { reason });
  return closed;
}

// ───────────────────────────── исход дела ─────────────────────────────

function findProcess(domain, processId) {
  return (domain?.state?.pendingActions || []).find((a) => String(a.id) === String(processId)) || null;
}

function storyForProcess(domain, process, partner = null) {
  const local =
    plotsForProcess(domain, process?.id).find((p) => isStakedStory(p)) ||
    (process?.plotlineId ? findPlotline(domain, process.plotlineId) : null);
  if (local && isStakedStory(local)) return { plot: local, host: domain };
  if (partner) {
    const theirs =
      plotsForProcess(partner, process?.id).find((p) => isStakedStory(p)) ||
      (process?.plotlineId ? findPlotline(partner, process.plotlineId) : null);
    if (theirs && isStakedStory(theirs)) return { plot: theirs, host: partner };
  }
  return { plot: null, host: domain };
}

function isPairCrossingDeed(process, plot, partner) {
  if (!partner || !process) return false;
  if (process.crossIsland) return true;
  if (process.targetDomainId && String(process.targetDomainId) === String(partner.id)) return true;
  if (plot && String(plotHostId(plot) || '') === String(partner.id)) return true;
  return false;
}

/** Минус беды кидается один раз и остаётся на самой беде. */
function rememberWoundBudget(threat, plot, config, rng) {
  const have = Number(threat?.statBudget);
  if (Number.isFinite(have) && have > 0) return Math.round(have);
  const n = rollWoundStatBudget(firedThreatScale(plot, threat), config, rng);
  threat.statBudget = n;
  return n;
}

function deedChronicleAgent({ closesStory, plot }) {
  if (closesStory) return 'chronicleFinale';
  if (plot) return 'chronicleDeed';
  return 'errandChronicler';
}

/**
 * Дело дошло до срока: бросок, последствия на нити, разбор остального.
 * Возвращает описание для рассказчика или `null`, если рассказывать нечего.
 */
export async function resolveDeedEvent({
  config,
  runtime,
  domain,
  world,
  day = 0,
  processId,
  rng = Math.random,
  log: parentLog,
  conflux = null,
  partner = null,
  storage = null,
  forcedFinish = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.deed', domainId: domain?.id, processId });
  const process = findProcess(domain, processId);
  if (!process) return { skipped: 'not_found' };
  const forced = ['fail', 'ok', 'crit'].includes(String(forcedFinish || ''))
    ? String(forcedFinish)
    : null;
  if (process.status !== 'active' && !(forced && process.status === 'paused')) {
    return { skipped: `not_active:${process.status}` };
  }

  normalizeDeed(process);
  const rolled = forced
    ? {
        finish: forced,
        rolled: forced,
        blessed: false,
        impossible: false,
        margin: null,
        curveInput: null,
        paceRatio: 1,
        roll: null,
        weights: null,
        forced: true,
      }
    : rollDeedFinish(domain, process, { config, rng });
  finishDeed(process, { day, finish: rolled.finish, blessed: rolled.blessed });
  releaseOfficerProcess(domain, process);
  const outcome = deedOutcome(process, { finish: rolled.finish, day, roll: rolled.roll });

  const { plot, host: plotHost } = storyForProcess(domain, process, partner);
  const applied = plot
    ? applyDeedToPlot({ plot, process, finish: rolled.finish, day, rng, config })
    : { alignment: alignmentOf(process) || 'UNRELATED', closes: false, depthGain: 0 };

  let firedThreat = null;
  let fireRes = null;
  if (plot && applied.triggerThreat) {
    fireRes = fireThreat(plot, applied.triggerThreat, { day, firedBy: process.id, config });
    if (fireRes.ok) firedThreat = applied.triggerThreat;
  } else if (plot && applied.pressureFilled) {
    const picked = neutralEndingDue(plot, config)
      ? await pickNeutralThreat({
          runtime,
          domain: plotHost || domain,
          plot,
          log,
        })
      : await pickConsequenceThreat({
          runtime,
          domain: plotHost || domain,
          plot,
          deed: process,
          log,
        });
    if (picked) {
      fireRes = fireThreat(plot, picked, { day, firedBy: process.id, config });
      if (fireRes.ok) firedThreat = picked;
    } else {
      resetPressure(plot, day, config, rng);
    }
  }
  const woundBudget = firedThreat ? rememberWoundBudget(firedThreat, plot, config, rng) : 0;

  // Постоянный порядок — тоже обычное дело, только его след ложится не в
  // глубину истории, а в постоянные изменения города.
  const rule = applyRuleDeed(domain, process, { finish: rolled.finish, day, rng });

  // Запись хроники пишет хронист, а не движок: шаблон «дело кончилось успехом»
  // и был тем метагеймом, который жрец потом честно пересказывал.
  // Порядок города говорит сам за себя — там текст уже предметный.
  let text = rule?.text || null;
  let pairNarration = null;
  const closesStory = Boolean(applied.closes || fireRes?.closes) && Boolean(plot);
  const completionBudget = closesStory && (plot?.ending?.kind || applied.endingKind) === 'GOOD_ENDING'
    ? rollStoryCompletionBudget(plot, config, rng)
    : 0;
  const pairDeed = !rule && conflux?.status === 'docked' && isPairCrossingDeed(process, plot, partner);
  if (!text && pairDeed) {
    pairNarration = await narratePairDeed({
      runtime,
      world,
      conflux,
      actor: domain,
      partner,
      process,
      plot,
      host: plotHost,
      applied,
      day,
      log,
      config,
    });
    text = pairNarration?.fact?.text || null;
  }
  if (!text) {
    const tail = plotChronicleTail(plotHost || domain, plot?.id);
    // Провал, переполнивший шкалу, не пишет отдельную хронику дела.
    // Событие — выбранная беда, провал только причина, которая к ней привела.
    const failLed = Boolean(firedThreat) && rolled.finish === 'fail';
    let occasion = 'дело';
    let agentId = deedChronicleAgent({ closesStory, plot });
    let prompt;
    if (failLed && closesStory) {
      occasion = 'развязка';
      agentId = 'chronicleFinale';
      prompt = formatFinalePrompt({
        plot,
        ending: plot.ending || null,
        triggerLines: threatTriggerLines(firedThreat),
        causeLines: failedDeedCauseLines({ domain, process, applied }),
        chronicleTail: tail,
        config,
        scale: firedThreatScale(plot, firedThreat),
      });
    } else if (failLed) {
      occasion = 'угроза';
      agentId = 'chronicleThreat';
      prompt = formatThreatPrompt({
        plot,
        threat: firedThreat,
        causeLines: failedDeedCauseLines({ domain, process, applied }),
        chronicleTail: tail,
        config,
      });
    } else if (closesStory) {
      prompt = formatFinalePrompt({
        plot,
        ending: plot.ending || null,
        triggerLines: deedTriggerLines({ domain, process, applied }),
        chronicleTail: tail,
      });
    } else {
      prompt = formatDeedPrompt({
        domain,
        plot,
        process,
        applied,
        threat: firedThreat || (plot ? findThreat(plot, applied.threatId) : null),
        averted: applied.averted || [],
        linked: Boolean(firedThreat),
        closed: false,
        chronicleTail: tail,
        partnerName: process.crossIsland ? partner?.name || '' : '',
        passage: process.crossIsland && conflux ? formatPassageForPrompt(conflux) : '',
        pairArchive:
          process.crossIsland && conflux
            ? formatPairArchive(conflux, [domain, partner].filter(Boolean))
            : '',
      });
    }
    const written = await writeChronicle({
      runtime,
      domain,
      occasion,
      agentId,
      maxChars: closesStory || Boolean(process.crossIsland) ? CHRONICLE_FINALE_MAX : undefined,
      prompt,
      log,
    });
    text = written?.text || fallbackDeedEntry(process, rolled.finish, {
      actor: deedActor(domain, process),
      gender: deedActorGender(domain, process),
    });
  }

  const fact = pairNarration?.fact
    ? pairNarration.fact
    : appendEventFact(domain, world, {
        text,
        plotId: plot?.id || null,
        processId: process.id,
        day,
        author: rule ? 'engine:rule' : 'engine:deed',
        finish: rolled.finish,
        secret: Boolean(process.secret),
        secretForDomainId: process.secret ? domain.id : null,
        extra: {
          statPocket: closesStory ? 'ending' : firedThreat ? 'threat' : 'deed',
          endingKind: plot?.ending?.kind || fireRes?.endingKind || applied.endingKind || null,
          plotClosed: closesStory,
          woundBudget,
          depthGain: applied.depthGain,
          completionBudget,
        },
      });
  if (fact) {
    fact.statPocket = closesStory ? 'ending' : firedThreat ? 'threat' : 'deed';
    if (closesStory) fact.endingKind = plot?.ending?.kind || fireRes?.endingKind || applied.endingKind || null;
    if (closesStory) fact.plotClosed = true;
    if (woundBudget > 0) fact.woundBudget = woundBudget;
    if (Number(applied.depthGain) > 0) fact.depthGain = Number(applied.depthGain);
    if (completionBudget > 0) fact.completionBudget = completionBudget;
  }

  const pairSpread =
    process.secret || pairNarration
      ? pairNarration || null
      : await spreadChronicleToPair({
          runtime,
          world,
          conflux,
          domain,
          partner,
          plot,
          process,
          fact,
          day,
          log,
          storage,
          config,
        });

  let secretVictim = null;
  if (process.secret) {
    process.secretRevealed = true;
    const reveal = secretRevealTexts(process, rolled.finish);
    if (partner) {
      const victimFacts = await writePairChronicle({
        runtime,
        world,
        conflux,
        domains: [partner],
        event: confluxEvent({
          kind: reveal.ok ? 'sabotage_hidden' : 'sabotage_caught',
          day,
          actorDomainId: domain.id,
          targetDomainId: partner.id,
          outcome: reveal.ok ? 'secret_ok' : 'secret_fail',
          plotId: plot?.id || null,
          deed: { summary: process.summary },
          textHint: reveal.victim,
        }),
        log,
      });
      secretVictim = victimFacts[0] || { domainId: partner.id, fact: { text: reveal.victim } };
      if (storage) await storage.saveDomain(partner);
    }
  }
  if (process.passageGuard && conflux) {
    await releasePassageHold({ runtime, conflux, processId: process.id, log });
    if (storage) await storage.saveConflux(conflux);
  }

  let closed = null;
  const host = plotHost && plotHost.id !== domain.id ? plotHost : domain;
  if (plot && (applied.closes || fireRes?.closes)) {
    const endingKind = plot.ending?.kind || fireRes?.endingKind || applied.endingKind;
    closed = closePlotWithJobs(host, world, plot, {
      day,
      reason: endingKind === 'GOOD_ENDING' ? 'depth' : endingKind === 'NEUTRAL_ENDING' ? 'neutral' : 'lives',
      fact,
      alsoDomains: [domain, partner],
    });
    if (storage && host !== domain) await storage.saveDomain(host);
  } else if (plot) {
    if (fireRes?.ok) resetPressure(plot, day, config, rng);
    schedulePressureJob(world, host, plot);
    await reconcilePlot({ runtime, domain: host, plot, resolved: outcome, day, log });
    // Хроника дела уже лежит на домене актёра. Новый пул пишется после неё.
    await ensurePlotObligations({
      runtime,
      domain: host,
      loreDomain: domain,
      world,
      plot,
      day,
      config,
      rng,
      log,
    });
    if (storage && host !== domain) await storage.saveDomain(host);
  }

  if (!plot && !rule && !process.intel) {
    const seeded = offerErrandSeed(domain, {
      processId: process.id,
      summary: process.summary,
      goal: process.goal,
      detail: process.detail,
      objectiveMonths: process.objectiveMonths || process.expectedMonths,
      finish: rolled.finish,
    }, { day, config, rng });
    if (seeded) {
      scheduleJob(world, {
        domainId: domain.id,
        kind: 'seed_appear',
        dueDay: seeded.appearDay,
        payload: { requestId: seeded.id, source: 'errand' },
      });
    }
  }

  log.info('loop.deed_resolved', {
    summary: process.summary,
    finish: rolled.finish,
    alignment: applied.alignment,
    depthGain: applied.depthGain,
    closed: Boolean(closed),
    margin: Number.isFinite(rolled.margin) ? rolled.margin : 'impossible',
  });

  return {
    fact,
    plot: closed || plot,
    plotId: plot?.id || null,
    occasion: closed ? 'развязка' : 'дело',
    outcome,
    applied,
    rule,
    closed: Boolean(closed),
    actor: deedActor(domain, process),
    actorGender: deedActorGender(domain, process),
    secretVictim,
    pairSpread,
  };
}

// ──────────────────────────── угроза сработала ────────────────────────────

/**
 * Шкала дошла до ста, либо дело само вызвало беду.
 * Пустой пул ничего не делает: шкала просто начинается заново.
 */
export async function fireThreatEvent({
  runtime,
  domain,
  world,
  day = 0,
  plotId,
  threatId,
  rng = Math.random,
  log: parentLog,
  plot: givenPlot = null,
  conflux = null,
  partner = null,
  storage = null,
  config = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.threat', domainId: domain?.id, plotId });
  const plot = givenPlot || findPlotline(domain, plotId);
  if (!plot) return { skipped: 'plot_gone' };
  const threat = findThreat(plot, threatId);
  if (!threat || threat.status !== 'live') return { skipped: 'threat_not_live' };

  const tail = plotChronicleTail(domain, plot.id);
  const res = fireThreat(plot, threat, { day, config });
  if (!res.ok) return { skipped: res.reason };
  const woundBudget = rememberWoundBudget(threat, plot, config, rng);

  const closesStory = Boolean(res.closes);
  const occasion = closesStory ? 'развязка' : 'угроза';
  const written = await writeChronicle({
    runtime,
    domain,
    occasion,
    agentId: closesStory ? 'chronicleFinale' : 'chronicleThreat',
    maxChars: closesStory ? CHRONICLE_FINALE_MAX : undefined,
    prompt: closesStory
      ? formatFinalePrompt({
          plot,
          ending: plot.ending || null,
          triggerLines: threatTriggerLines(threat),
          chronicleTail: tail,
          dateLabel: gameDateFromDay(day).label,
          config,
          scale: firedThreatScale(plot, threat),
        })
      : formatThreatPrompt({
          plot,
          threat,
          closed: false,
          stage: res.stage,
          chronicleTail: tail,
          dateLabel: gameDateFromDay(day).label,
          config,
        }),
    log,
  });

  const fact = appendEventFact(domain, world, {
    text: written?.text || threat.text || 'В городе случилось то, чего боялись.',
    plotId: plot.id,
    day,
    author: 'engine:threat',
    importance: 'major',
    extra: {
      statPocket: closesStory ? 'ending' : 'threat',
      endingKind: plot.ending?.kind || (closesStory ? 'BAD_ENDING' : null),
      plotClosed: closesStory,
      woundBudget,
    },
  });

  const pairSpread = await spreadChronicleToPair({
    runtime,
    world,
    conflux,
    domain,
    partner,
    plot,
    fact,
    day,
    log,
    storage,
    config,
  });

  let closed = null;
  if (res.closes) {
    closed = closePlotWithJobs(domain, world, plot, {
      day,
      reason: res.endingKind === 'NEUTRAL_ENDING' ? 'neutral' : 'lives',
      fact,
      alsoDomains: [partner],
    });
  } else {
    resetPressure(plot, day, config, rng);
    schedulePressureJob(world, domain, plot);
    await reconcilePlot({ runtime, domain, plot, resolved: { summary: threat.text, kind: 'threat' }, day, log });
    // Запись о сработавшей беде уже в хронике. Следующий пул пишется по ней.
    await ensurePlotObligations({ runtime, domain, world, plot, day, config, rng, log });
  }

  log.info('loop.threat_fired', {
    title: plot.title,
    stage: res.stage,
    endingKind: res.endingKind || null,
    closed: Boolean(closed),
    livesLeft: res.livesLeft ?? null,
  });

  return {
    fact,
    plot: closed || plot,
    plotId: plot.id,
    occasion,
    closed: Boolean(closed),
    stage: res.stage || null,
    endingKind: res.endingKind || null,
    pairSpread,
  };
}

/**
 * Шкала сама дошла до ста.
 * Обычная беда берётся из пула жребием. Нейтральную концовку выбирает агент:
 * самую хорошую из плохих.
 */
export async function firePressureEvent(ctx) {
  const { domain, world, day = 0, plotId, config = null, rng = Math.random, plot: givenPlot = null } = ctx;
  const plot = givenPlot || findPlotline(domain, plotId);
  if (!plot || plot.status === 'closed') return { skipped: 'plot_gone' };
  ensurePressure(plot, day, config, rng);
  if (pressureAt(plot, day) < 100) {
    schedulePressureJob(world, domain, plot);
    return { skipped: 'not_full' };
  }
  const live = liveThreats(plot);
  if (!live.length) {
    resetPressure(plot, day, config, rng);
    schedulePressureJob(world, domain, plot);
    return { skipped: 'empty_pool' };
  }
  const threat = neutralEndingDue(plot, config)
    ? await pickNeutralThreat({
        runtime: ctx.runtime,
        domain,
        plot,
        log: ctx.log,
      })
    : live[Math.floor(rng() * live.length)];
  if (!threat) {
    resetPressure(plot, day, config, rng);
    schedulePressureJob(world, domain, plot);
    return { skipped: 'empty_pool' };
  }
  return fireThreatEvent({ ...ctx, plot, threatId: threat.id });
}

// ──────────────────────────────── посев ────────────────────────────────

/**
 * Попытка посева. Сама попытка ничего не рассказывает: она только решает,
 * появится ли история, и когда. Появление — отдельное событие.
 */
export function seedAttemptEvent({ config, domain, world, day = 0, rng = Math.random, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.seed', domainId: domain?.id });
  const decision = decideSeedAttempt(domain, { day, world, config, rng });

  if (decision.seed) {
    const chronicle = yearChronicleGrain(domain, world, { day });
    const seedText = decision.source === 'chronicle' ? formatChronicleGrain(chronicle) : '';
    const request = enqueueSeedRequest(domain, {
      source: decision.source === 'chronicle' ? 'chronicle' : 'void',
      grain: decision.source,
      gravity: decision.gravity,
      seedText,
      day,
      delayDays: 0,
      rng,
    });
    scheduleJob(world, {
      domainId: domain.id,
      kind: 'seed_appear',
      dueDay: request.appearDay,
      payload: { requestId: request.id, source: request.source },
    });
  }

  const nextDay = scheduleNextAttempt(domain, day, rng);
  scheduleJob(world, {
    domainId: domain.id,
    kind: 'seed_attempt',
    dueDay: nextDay,
    payload: {},
  });
  log.info('loop.seed_attempt', {
    seed: decision.seed,
    source: decision.source || null,
    reason: decision.reason || null,
    nextDay,
  });
  return decision;
}

/**
 * Отложенный посев дошёл до дня появления. Текст истории рождается только
 * здесь: заявка хранила ссылку на зерно, чтобы не устареть в ожидании.
 */
export async function seedAppearEvent({
  config,
  runtime,
  domain,
  world,
  day = 0,
  requestId,
  rng = Math.random,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.seed_appear', domainId: domain?.id });
  const request = dueSeedRequests(domain, day).find((r) => r.id === requestId);
  if (!request) return { skipped: 'gone' };

  const maxOpen = plotConfig(config).board.maxOpen;
  const boardFull = countOpen(domain).stories >= maxOpen;
  const fresh = checkSeedFreshness(domain, request, { day, boardFull });
  if (!fresh.fresh) {
    if (fresh.postpone) {
      postponeSeedRequest(request, day, rng);
      scheduleJob(world, {
        domainId: domain.id,
        kind: 'seed_appear',
        dueDay: request.appearDay,
        payload: { requestId: request.id, source: request.source },
      });
      log.info('loop.seed_postponed', { reason: fresh.reason, appearDay: request.appearDay });
      return { skipped: fresh.reason, postponed: true };
    }
    dropSeedRequest(domain, request.id);
    log.info('loop.seed_stale', { reason: fresh.reason });
    return { skipped: fresh.reason };
  }

  // Текст зерна собирается сейчас, а не в момент постановки заявки:
  // за задержку мир успел измениться, и старый текст противоречил бы хронике.
  const grain = request.grain === 'errand'
    ? { seedText: request.seedText || '', gravity: request.gravity, fromVoid: false, fromGenesis: false }
    : request.grain === 'genesis'
      ? (openingGrain(domain, { gravity: request.gravity }) || openingVoidGrain({ gravity: request.gravity }))
      : request.grain === 'void'
        ? openingVoidGrain({ gravity: request.gravity })
        : request.grain === 'chronicle'
          ? {
              seedText: request.seedText || formatChronicleGrain(yearChronicleGrain(domain, world, { day })),
              gravity: request.gravity,
              fromVoid: false,
              fromGenesis: false,
            }
          : (
            (request.grain === 'genesis' && openingGrain(domain, { gravity: request.gravity, rng })) ||
            grainForSource({ domain, world, config, source: request.source, rng })
          );
  const planted = await plantStakedStory({
    config,
    runtime,
    domain,
    world,
    seedText: grain.seedText,
    gravity: grain.gravity,
    fromVoid: grain.fromVoid,
    fromGenesis: grain.fromGenesis,
    day,
    log,
  });
  dropSeedRequest(domain, request.id);
  if (!planted?.plot) {
    log.warn('loop.seed_failed', { source: request.source });
    return { skipped: 'plant_failed' };
  }

  const plot = planted.plot;
  if (request.seedFactId) plot.seedFactId = request.seedFactId;
  if (planted.fact) planted.fact.sourcePlotId = plot.id;
  await ensurePlotObligations({ runtime, domain, world, plot, day, rng, log });

  log.info('loop.seed_planted', { title: plot.title, gravity: plot.gravity, source: request.source });
  return {
    fact: planted.fact,
    plot,
    plotId: plot.id,
    occasion: 'новая история',
  };
}

// ──────────────────────────────── доклад ────────────────────────────────

/**
 * Наказ жреца едет попутно с событием, а не по расписанию: расписание
 * приходилось бы угадывать, и любой промах игрок читает как поломку.
 * Здесь событие уже есть — к нему и добавляется строка о теме наказа.
 */
export function attachReport(domain, event, { day = 0 } = {}) {
  if (!event || event.occasion === 'доклад') return event;
  countEvent(domain);
  const order = pickReportSubject(domain, {
    texts: [event.fact?.text, event.plot?.title, event.plot?.synopsis],
  });
  if (!order) return event;
  markReported(domain, order, { day });
  event.reportSubject = order.subject;
  event.reportOrderId = order.id;
  return event;
}

// ──────────────────────────── один шаг домена ────────────────────────────

const HANDLERS = {
  async process_finish(ctx, job) {
    return resolveDeedEvent({ ...ctx, processId: job.payload?.processId });
  },
  async pressure_fire(ctx, job) {
    return firePressureEvent({ ...ctx, plotId: job.payload?.plotId });
  },
  async seed_attempt(ctx) {
    seedAttemptEvent(ctx);
    return { skipped: 'no_story' };
  },
  async seed_appear(ctx, job) {
    return seedAppearEvent({ ...ctx, requestId: job.payload?.requestId });
  },
};

/**
 * Разобрать все просроченные события домена. Возвращает список того,
 * о чём нужно рассказать: движок посчитал, говорить будет рассказчик.
 */
export async function drainDomainJobs({
  config,
  runtime,
  domain,
  world,
  day = 0,
  rng = Math.random,
  limit = 24,
  log: parentLog,
  conflux = null,
  partner = null,
  storage = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop', domainId: domain?.id });
  normalizeDomainProcesses(domain, config);
  accrueMana(domain, day);
  expirePauses(domain?.state?.pendingActions || [], day);

  const events = [];
  let guard = 0;
  while (guard < limit) {
    guard += 1;
    const [job] = dueJobs(world, day, { domainId: domain.id });
    if (!job) break;
    if (!claimJob(job)) break;
    const handler = HANDLERS[job.kind];
    if (!handler) {
      completeJob(job, 'unknown_kind');
      continue;
    }
    try {
      const result = await handler(
        { config, runtime, domain, world, day, rng, log, conflux, partner, storage },
        job,
      );
      completeJob(job, result?.skipped || 'ok');
      if (result && !result.skipped) events.push(result);
    } catch (err) {
      failJob(job, err.message);
      log.warn('loop.job_failed', { kind: job.kind, error: err.message });
    }
  }

  return events;
}

/**
 * Что жрец просит в конце сообщения. Считает движок: если это решает
 * настроение модели, вопрос будет в каждом сообщении и перестанет значить хоть что-то.
 */
export function askForEvent(domain, event, config = null) {
  const plot = event?.plot;
  const closable =
    plot && !event.closed && Number(plot.maxDepth) > 0 && Number(plot.depth) >= Number(plot.maxDepth) * 0.75;
  return decideAsk({
    plotClosable: Boolean(closable),
    needsHelp: false,
  });
}

/** Первичная заводка домена на непрерывное время: попытка посева и обязательства. */
export async function armDomainSchedule({ runtime, domain, world, day = 0, rng = Math.random, log } = {}) {
  if (!world || !domain) return;
  normalizePlotlines(domain);
  const hasAttempt = (world.jobs || []).some(
    (j) => j.state === 'pending' && j.kind === 'seed_attempt' && j.domainId === domain.id,
  );
  if (!hasAttempt) {
    const nextDay = scheduleNextAttempt(domain, day, rng);
    scheduleJob(world, { domainId: domain.id, kind: 'seed_attempt', dueDay: nextDay, payload: {} });
  }
  for (const plot of domain.plotlines || []) {
    if (!isStakedStory(plot)) continue;
    await ensurePlotObligations({ runtime, domain, world, plot, day, rng, log });
  }
}

/** Снять с очереди дело, которое отменили или запаузили. */
export function cancelDeedJobs(world, processId) {
  if (!world || !processId) return [];
  return cancelJobs(world, (j) => j.kind === 'process_finish' && j.payload?.processId === processId);
}

/** Поставить дело на календарь: один job на день срока. */
export function scheduleDeedJob(world, domain, process) {
  if (!world || !process?.dueDay) return null;
  cancelDeedJobs(world, process.id);
  return scheduleJob(world, {
    domainId: domain?.id || null,
    kind: 'process_finish',
    dueDay: process.dueDay,
    payload: { processId: process.id },
  });
}
