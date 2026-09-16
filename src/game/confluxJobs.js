/**
 * Задания пары: стыковка, расстыковка, касание.
 * Берутся из общей очереди мира; handler грузит оба домена.
 */

import { dueJobs, claimJob, completeJob, failJob, LockSet } from './scheduler.js';
import { findActiveConfluxForDomain, dockConfluxNow, undockConfluxNow } from './conflux.js';
import { normalizeDomain } from './models.js';
import { attemptPairSilence } from './confluxForecast.js';
import { maybeNudgeProxy } from './proxyJudge.js';
import { getLogger } from '../log.js';

export const PAIR_JOB_KINDS = [
  'conflux_dock',
  'conflux_undock',
  'conflux_beat',
  'conflux_contact',
  'conflux_transfer',
];

async function loadPair(storage, confluxId) {
  const conflux = await storage.getConflux(confluxId);
  if (!conflux) return null;
  const domains = [];
  for (const id of conflux.domainIds || []) {
    const d = await storage.getDomain(id);
    if (d) {
      normalizeDomain(d);
      domains.push(d);
    }
  }
  return { conflux, domains };
}

async function savePair(storage, conflux, domains) {
  for (const d of domains) await storage.saveDomain(d);
  await storage.saveConflux(conflux);
}

/** Сопряжение не нить: кристаллизации контейнера больше нет. */
export async function crystallizeContainer() {
  return null;
}

const HANDLERS = {
  async conflux_dock(ctx) {
    const loaded = await loadPair(ctx.storage, ctx.job.payload?.confluxId);
    if (!loaded) return { skipped: 'gone' };
    const { conflux, domains } = loaded;
    const out = await dockConfluxNow({
      config: ctx.config,
      runtime: ctx.runtime,
      conflux,
      domains,
      world: ctx.world,
      day: ctx.day,
      log: ctx.log,
    });
    const facts = domains.map((d) => ({
      domainId: d.id,
      fact: (d.lore || []).slice(-1)[0] || { text: out.contact?.description || 'Острова сошлись.' },
    }));
    await maybeNudgeProxy({
      runtime: ctx.runtime,
      config: ctx.config,
      world: ctx.world,
      day: ctx.day,
      domains,
      trigger: 'dock',
      context: out.contact?.description || 'Острова сошлись.',
      rng: ctx.rng,
      log: ctx.log,
    });
    await savePair(ctx.storage, conflux, domains);
    return { occasion: 'сопряжение', confluxId: conflux.id, contact: out.contact, domains, facts };
  },
  async conflux_undock(ctx) {
    const loaded = await loadPair(ctx.storage, ctx.job.payload?.confluxId);
    if (!loaded) return { skipped: 'gone' };
    const { conflux, domains } = loaded;
    await undockConfluxNow({
      runtime: ctx.runtime,
      conflux,
      domains,
      world: ctx.world,
      day: ctx.day,
      config: ctx.config,
      log: ctx.log,
      rng: ctx.rng,
    });
    const facts = domains.map((d) => ({
      domainId: d.id,
      fact: (d.lore || []).filter((f) => (f.tags || []).includes('conflux')).slice(-1)[0] || {
        text: `Острова разошлись в небе.`,
      },
    }));
    await savePair(ctx.storage, conflux, domains);
    return { occasion: 'расстыковка', confluxId: conflux.id, domains, facts };
  },
  async conflux_contact(ctx) {
    const loaded = await loadPair(ctx.storage, ctx.job.payload?.confluxId);
    if (!loaded) return { skipped: 'gone' };
    const { conflux, domains } = loaded;
    if (conflux.status !== 'docked') return { skipped: 'not_docked' };
    const out = attemptPairSilence({
      conflux,
      world: ctx.world,
      day: ctx.day,
      config: ctx.config,
      rng: ctx.rng,
      log: ctx.log,
    });
    await savePair(ctx.storage, conflux, domains);
    if (out.skipped) return { skipped: out.skipped, nextAttemptDay: out.nextAttemptDay || null };
    return { occasion: 'сопряжение', confluxId: conflux.id, domains };
  },
  async conflux_beat() {
    return { skipped: 'retired' };
  },
  async conflux_transfer(ctx) {
    return HANDLERS.conflux_undock(ctx);
  },
};

export async function drainConfluxJobs({
  config,
  runtime,
  storage,
  world,
  day = 0,
  rng = Math.random,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'conflux.jobs' });
  const kinds = new Set(PAIR_JOB_KINDS);
  const due = dueJobs(world, day).filter((j) => kinds.has(j.kind));
  const events = [];
  const locks = new LockSet();
  for (const job of due) {
    if (!claimJob(job)) continue;
    const handler = HANDLERS[job.kind];
    if (!handler) {
      completeJob(job, 'unknown_kind');
      continue;
    }
    const loaded = await loadPair(storage, job.payload?.confluxId);
    const keys = [
      ...((loaded?.conflux?.domainIds || []).map(String)),
      job.payload?.confluxId ? `pair:${job.payload.confluxId}` : `job:${job.id}`,
    ];
    const release = await locks.acquire(keys);
    try {
      const result = await handler({ config, runtime, storage, world, day, rng, log, job });
      completeJob(job, result?.skipped || 'ok');
      if (result && !result.skipped) events.push(result);
    } catch (err) {
      failJob(job, err.message);
      log.warn('conflux.job_failed', { kind: job.kind, error: err.message });
    } finally {
      release();
    }
  }
  return events;
}

export async function activeConfluxOf(storage, domainId) {
  return findActiveConfluxForDomain(storage, domainId);
}
