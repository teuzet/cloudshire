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
  cancelJobsForThreat,
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
} from './plotlines.js';
import { activeProcesses, normalizeDomainProcesses } from './processes.js';
import { releaseOfficerProcess } from './officers.js';
import { normalizeDeed, rollDeedFinish, finishDeed, deedOutcome } from './deeds.js';
import { applyDeedToPlot } from './deedResolve.js';
import { alignmentOf } from './deedAlign.js';
import {
  liveThreats,
  findThreat,
  fireThreat,
  surfaceOverdueThreats,
  normalizePlotThreats,
} from './threats.js';
import { replenishPlotThreats } from './threatSmith.js';
import {
  fallbackDeedEntry,
  formatDeedPrompt,
  formatThreatPrompt,
  plotChronicleTail,
  writeChronicle,
} from './chronicler.js';
import { reconcilePlot } from './reconciler.js';
import { expirePauses } from './reconcile.js';
import {
  decideSeedAttempt,
  scheduleNextAttempt,
  applySeedCooldown,
  enqueueSeedRequest,
  dueSeedRequests,
  dropSeedRequest,
  checkSeedFreshness,
  postponeSeedRequest,
} from './seedSchedule.js';
import { applyMonthSeedTemps, grainForSource, openingGrain, openingVoidGrain } from './seedChannels.js';
import { applyRuleDeed } from './cityRules.js';
import { plantStakedStory } from './storyteller.js';
import { accrueMana } from './mana.js';
import { countEvent, markReported, pickReportSubject } from './priestOrders.js';
import { decideAsk } from './herald.js';
import { getLogger } from '../log.js';

/** Запись хроники события. День обязателен: по нему живёт вся новая механика. */
export function appendEventFact(
  domain,
  world,
  { text, plotId = null, processId = null, day = 0, author = 'engine', importance = 'major', tags = ['chronicle'], finish = null },
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
  });
  domain.lore = Array.isArray(domain.lore) ? domain.lore : [];
  domain.lore.push(fact);
  if (plotId) attachChronicleToPlotlines(domain, fact.id, [plotId]);
  return fact;
}

/** Поставить срабатывание угрозы в очередь. Один job на угрозу. */
export function scheduleThreatJob(world, domain, threat) {
  if (!world || !threat) return null;
  return scheduleJob(world, {
    domainId: domain?.id || null,
    kind: 'threat_fire',
    dueDay: threat.dueDay,
    payload: { plotId: threat.plotId, threatId: threat.id, outcome: threat.outcome },
  });
}

/** Переставить job под изменившийся срок угрозы (отсрочка, ускорение, разбор). */
export function resyncThreatJobs(world, domain, plot) {
  if (!world || !plot) return [];
  const out = [];
  for (const threat of liveThreats(plot)) {
    const job = (world.jobs || []).find(
      (j) => j.state === 'pending' && j.kind === 'threat_fire' && j.payload?.threatId === threat.id,
    );
    if (!job) {
      out.push(scheduleThreatJob(world, domain, threat));
      continue;
    }
    if (job.dueDay !== threat.dueDay) {
      job.dueDay = threat.dueDay;
      out.push(job);
    }
  }
  // Угрозы, которые больше не живы, снимаются с очереди.
  for (const job of world.jobs || []) {
    if (job.state !== 'pending' || job.kind !== 'threat_fire') continue;
    if (job.payload?.plotId !== plot.id) continue;
    const threat = findThreat(plot, job.payload?.threatId);
    if (!threat || threat.status !== 'live') {
      job.state = 'failed';
      job.cancelled = true;
    }
  }
  return out.filter(Boolean);
}

/**
 * Дозаполнить обязательства нити и поставить их в очередь.
 * Живая история без счётчика — история, которая никогда ничего не породит.
 */
export async function ensurePlotObligations({
  runtime,
  domain,
  world,
  plot,
  day = 0,
  rng = Math.random,
  log,
} = {}) {
  if (!plot || !isStakedStory(plot)) return [];
  normalizePlotThreats(plot);
  const created = await replenishPlotThreats({ runtime, domain, plot, day, rng, log });
  for (const threat of created) scheduleThreatJob(world, domain, threat);
  return created;
}

/** Закрыть нить и снять с очереди всё, что на неё было заведено. */
export function closePlotWithJobs(domain, world, plot, { day = 0, reason = '', fact = null } = {}) {
  if (!plot) return null;
  for (const threat of liveThreats(plot)) {
    threat.status = 'cancelled';
    threat.cancelledDay = day;
    threat.cancelReason = 'история закрыта';
  }
  if (world) cancelJobsForPlot(world, plot.id);
  const closed = closePlotline(domain, plot.id, { tick: world?.tickIndex ?? null, reason });
  if (fact) markChroniclePlotClosed(fact, { reason });
  return closed;
}

// ───────────────────────────── исход дела ─────────────────────────────

function findProcess(domain, processId) {
  return (domain?.state?.pendingActions || []).find((a) => String(a.id) === String(processId)) || null;
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
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.deed', domainId: domain?.id, processId });
  const process = findProcess(domain, processId);
  if (!process) return { skipped: 'not_found' };
  if (process.status !== 'active') return { skipped: `not_active:${process.status}` };

  normalizeDeed(process);
  const rolled = rollDeedFinish(domain, process, { config, rng });
  finishDeed(process, { day, finish: rolled.finish, blessed: rolled.blessed });
  releaseOfficerProcess(domain, process);
  const outcome = deedOutcome(process, { finish: rolled.finish, day, roll: rolled.roll });

  const plot = plotsForProcess(domain, process.id).find((p) => isStakedStory(p)) || null;
  const applied = plot
    ? applyDeedToPlot({ plot, process, finish: rolled.finish, day, rng })
    : { alignment: alignmentOf(process) || 'UNRELATED', closes: false, depthGain: 0 };

  // Постоянный порядок — тоже обычное дело, только его след ложится не в
  // глубину истории, а в постоянные изменения города.
  const rule = applyRuleDeed(domain, process, { finish: rolled.finish, day, rng });

  // Запись хроники пишет хронист, а не движок: шаблон «дело кончилось успехом»
  // и был тем метагеймом, который жрец потом честно пересказывал.
  // Порядок города говорит сам за себя — там текст уже предметный.
  let text = rule?.text || null;
  if (!text) {
    const written = await writeChronicle({
      runtime,
      domain,
      occasion: 'дело',
      prompt: formatDeedPrompt({
        domain,
        plot,
        process,
        applied,
        threat: plot ? findThreat(plot, applied.threatId) : null,
        closed: Boolean(applied.closes),
        ending: plot?.ending || null,
        chronicleTail: plotChronicleTail(domain, plot?.id),
        dateLabel: gameDateFromDay(day).label,
      }),
      log,
    });
    text = written?.text || fallbackDeedEntry(process, rolled.finish);
  }

  const fact = appendEventFact(domain, world, {
    text,
    plotId: plot?.id || null,
    processId: process.id,
    day,
    author: rule ? 'engine:rule' : 'engine:deed',
    finish: rolled.finish,
  });

  let closed = null;
  if (plot && applied.closes) {
    closed = closePlotWithJobs(domain, world, plot, {
      day,
      reason: applied.endingKind === 'GOOD_ENDING' ? 'depth' : 'lives',
      fact,
    });
  } else if (plot) {
    resyncThreatJobs(world, domain, plot);
    await reconcilePlot({ runtime, domain, plot, resolved: outcome, day, log });
    resyncThreatJobs(world, domain, plot);
    await ensurePlotObligations({ runtime, domain, world, plot, day, rng, log });
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
    occasion: 'дело',
    outcome,
    applied,
    rule,
    closed: Boolean(closed),
    officerFreed: Boolean(process.officerId),
  };
}

// ──────────────────────────── угроза сработала ────────────────────────────

/**
 * Обязательство мира дошло до срока. Это и есть бывший автотик: новая запись
 * в хронике появляется потому, что город не успел, а не потому, что «был месяц».
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
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.threat', domainId: domain?.id, plotId });
  const plot = findPlotline(domain, plotId);
  if (!plot) return { skipped: 'plot_gone' };
  const threat = findThreat(plot, threatId);
  if (!threat || threat.status !== 'live') return { skipped: 'threat_not_live' };

  const tail = plotChronicleTail(domain, plot.id);
  const res = fireThreat(plot, threat, { day });
  if (!res.ok) return { skipped: res.reason };

  // Текст угрозы написан в будущем времени: это предсказание, которое движок
  // держал до срока. В летопись оно должно лечь уже случившимся.
  const occasion = res.kind === 'resolution' ? 'разрешение' : 'угроза';
  const written = await writeChronicle({
    runtime,
    domain,
    occasion,
    prompt: formatThreatPrompt({
      plot,
      threat,
      kind: res.kind,
      closed: Boolean(res.closes),
      severity: res.severity,
      chronicleTail: tail,
      dateLabel: gameDateFromDay(day).label,
    }),
    log,
  });

  const fact = appendEventFact(domain, world, {
    text: written?.text || threat.text || 'В городе случилось то, чего боялись.',
    plotId: plot.id,
    day,
    author: res.kind === 'resolution' ? 'engine:resolution' : 'engine:threat',
    importance: 'major',
  });

  let closed = null;
  if (res.closes) {
    closed = closePlotWithJobs(domain, world, plot, {
      day,
      reason: res.kind === 'resolution' ? 'neutral' : 'lives',
      fact,
    });
  } else {
    resyncThreatJobs(world, domain, plot);
    await reconcilePlot({ runtime, domain, plot, resolved: { summary: threat.text, kind: 'threat' }, day, log });
    resyncThreatJobs(world, domain, plot);
    await ensurePlotObligations({ runtime, domain, world, plot, day, rng, log });
  }

  log.info('loop.threat_fired', {
    title: plot.title,
    kind: res.kind,
    severity: res.severity,
    closed: Boolean(closed),
    livesLeft: res.livesLeft ?? null,
  });

  return {
    fact,
    plot: closed || plot,
    plotId: plot.id,
    occasion,
    closed: Boolean(closed),
    severity: res.severity,
  };
}

// ──────────────────────────────── посев ────────────────────────────────

/**
 * Попытка посева. Сама попытка ничего не рассказывает: она только решает,
 * появится ли история, и когда. Появление — отдельное событие.
 */
export function seedAttemptEvent({ config, domain, world, day = 0, rng = Math.random, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.seed', domainId: domain?.id });
  const decision = decideSeedAttempt(domain, { day, config, rng });

  if (decision.seed) {
    const request = enqueueSeedRequest(domain, { source: decision.source, day, rng });
    scheduleJob(world, {
      domainId: domain.id,
      kind: 'seed_appear',
      dueDay: request.appearDay,
      payload: { requestId: request.id, source: request.source },
    });
    applySeedCooldown(domain, day, rng);
    applyMonthSeedTemps(domain, { [decision.source]: 'seed' }, config);
  } else if (decision.reason === 'roll' || decision.reason === 'cold') {
    applyMonthSeedTemps(domain, { chronicle: 'idle', void: 'idle', errand: 'idle' }, config);
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
  const grain =
    (request.grain === 'genesis' && openingGrain(domain, { gravity: request.gravity, rng })) ||
    (request.grain === 'void' && openingVoidGrain({ gravity: request.gravity })) ||
    grainForSource({ domain, world, config, source: request.source, rng });
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
  async threat_fire(ctx, job) {
    return fireThreatEvent({ ...ctx, plotId: job.payload?.plotId, threatId: job.payload?.threatId });
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
      const result = await handler({ config, runtime, domain, world, day, rng, log }, job);
      completeJob(job, result?.skipped || 'ok');
      if (result && !result.skipped) events.push(result);
    } catch (err) {
      failJob(job, err.message);
      log.warn('loop.job_failed', { kind: job.kind, error: err.message });
    }
  }

  // Скрытые угрозы всплывают сами, когда до срока осталась четверть пути.
  for (const plot of domain.plotlines || []) {
    if (!isStakedStory(plot)) continue;
    for (const threat of surfaceOverdueThreats(plot, day)) {
      events.push({ occasion: 'угроза', plot, plotId: plot.id, surfaced: threat });
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
    plot && !event.closed && Number(plot.depth) >= Number(plot.maxDepth) * 0.75 && !liveThreats(plot).length;
  return decideAsk({
    plotClosable: Boolean(closable),
    officerFreed: Boolean(event?.officerFreed) && canTakeMore(domain, config),
    needsHelp: Boolean(plot) && !event.closed && liveThreats(plot).some((t) => t.known),
  });
}

function canTakeMore(domain, config) {
  const officers = (domain?.officers || []).length;
  const busy = activeProcesses(domain, config).length;
  return officers ? busy < officers : busy < 4;
}

/** Первичная заводка домена на непрерывное время: попытка посева и обязательства. */
export async function armDomainSchedule({ runtime, domain, world, day = 0, rng = Math.random, log } = {}) {
  if (!world || !domain) return;
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

export { cancelJobsForThreat };
