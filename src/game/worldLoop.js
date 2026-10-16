/**
 * Непрерывный ход мира: задания на день.
 * Нити, дела и шкалы давления сняты. Живые события — бит и ставка фронта,
 * плюс появление зерна сценария, если заявка его несёт.
 */

import { newId } from './ids.js';
import { createLoreFact } from './models.js';
import { gameDateFromDay } from './gameClock.js';
import { scheduleJob, cancelJobs, dueJobs, claimJob, completeJob, failJob } from './scheduler.js';
import { normalizeDomainProcesses } from './processes.js';
import { accrueMana } from './mana.js';
import { countEvent, markReported, pickReportSubject } from './priestOrders.js';
import { decideAsk } from './herald.js';
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
  domain.lore = Array.isArray(domain.lore) ? domain.lore : [];
  domain.lore.push(fact);
  return fact;
}

/**
 * Снять задания, которым не на что срабатывать.
 * Старые виды (дела, давление, угрозы) гасятся целиком: этого контура больше нет.
 */
export function sweepOrphanJobs(world, domain, { log = null } = {}) {
  if (!world || !domain) return [];
  const fronts = new Set(
    (domain.fronts || []).filter((front) => front && front.status === 'active').map((front) => front.id),
  );
  const dropped = cancelJobs(world, (job) => {
    if (job.domainId !== domain.id) return false;
    if (job.kind === 'pressure_fire' || job.kind === 'threat_fire' || job.kind === 'process_finish') return true;
    if (job.kind === 'front_beat' || job.kind === 'front_stake') {
      return Boolean(job.payload?.frontId) && !fronts.has(job.payload.frontId);
    }
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

function dueScenarioRequest(domain, day, requestId) {
  const list = Array.isArray(domain?.seedQueue) ? domain.seedQueue : domain?.state?.seedQueue;
  const queue = Array.isArray(list) ? list : [];
  return queue.find((request) => request && request.id === requestId && Number(request.appearDay) <= Number(day));
}

function dropScenarioRequest(domain, requestId) {
  for (const key of ['seedQueue']) {
    if (Array.isArray(domain?.[key])) {
      domain[key] = domain[key].filter((request) => request?.id !== requestId);
    }
    if (Array.isArray(domain?.state?.[key])) {
      domain.state[key] = domain.state[key].filter((request) => request?.id !== requestId);
    }
  }
}

/** Старый посев нитей выключен. Заявка без сценария просто снимается. */
export async function seedAppearEvent({
  config,
  runtime,
  domain,
  world,
  day = 0,
  requestId,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'loop.seed_appear', domainId: domain?.id });
  const request = dueScenarioRequest(domain, day, requestId);
  if (!request) return { skipped: 'gone' };
  if (!request.scenario) {
    dropScenarioRequest(domain, request.id);
    log.info('loop.seed_retired', { requestId: request.id });
    return { skipped: 'retired' };
  }
  const { initializeScenario, loadScenarioSeed } = await import('../world/scenario.js');
  const seed = typeof request.scenario === 'string' ? loadScenarioSeed(request.scenario) : request.scenario;
  const planted = await initializeScenario({ config, runtime, domain, seed, day, log });
  dropScenarioRequest(domain, request.id);
  if (planted?.fronts?.length) {
    const { armFrontSchedule } = await import('../world/frontJobs.js');
    armFrontSchedule(config, domain, world, day);
  }
  log.info('loop.seed_fronts', { fronts: planted?.fronts?.length || 0 });
  return {
    fronts: planted?.fronts,
    occasion: 'новая история',
    ...(planted?.fronts?.length ? {} : { skipped: 'plant_failed' }),
  };
}

export function attachReport(domain, event, { day = 0 } = {}) {
  if (!event || event.occasion === 'доклад') return event;
  countEvent(domain);
  const order = pickReportSubject(domain, {
    texts: [event.fact?.text, event.front?.description],
  });
  if (!order) return event;
  markReported(domain, order, { day });
  event.reportSubject = order.subject;
  event.reportOrderId = order.id;
  return event;
}

const HANDLERS = {
  async seed_attempt() {
    return { skipped: 'retired' };
  },
  async seed_appear(ctx, job) {
    return seedAppearEvent({ ...ctx, requestId: job.payload?.requestId });
  },
  async front_beat(ctx, job) {
    const { resolveFrontBeat } = await import('../world/beats.js');
    return resolveFrontBeat({ ...ctx, frontId: job.payload?.frontId });
  },
  async front_stake(ctx, job) {
    const { resolveFrontStake } = await import('../world/stake.js');
    return resolveFrontStake({ ...ctx, frontId: job.payload?.frontId });
  },
};

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

export function askForEvent(domain, event) {
  const front = event?.front;
  const effort = Number(front?.effort) || 0;
  const progress = Number(front?.progress) || 0;
  const closable = Boolean(front && effort > 0 && progress >= effort * 0.75);
  return decideAsk({
    plotClosable: closable,
    needsHelp: false,
  });
}

/** Поставить появление зерна сценария. Обычный посев нитей больше не заводится. */
export function scheduleScenarioSeed(world, domain, request) {
  if (!world || !domain || !request?.id) return null;
  return scheduleJob(world, {
    domainId: domain.id,
    kind: 'seed_appear',
    dueDay: request.appearDay,
    payload: { requestId: request.id, source: request.source || 'scenario' },
  });
}
