/**
 * Задания пары: стыковка, расстыковка, касание, ход контейнера.
 * Берутся из общей очереди мира; handler грузит оба домена.
 */

import { dueJobs, claimJob, completeJob, failJob, LockSet } from './scheduler.js';
import { findActiveConfluxForDomain, dockConfluxNow, undockConfluxNow } from './conflux.js';
import { normalizeDomain } from './models.js';
import { writePairChronicle, confluxEvent } from './confluxCanon.js';
import { attemptPairSilence } from './confluxForecast.js';
import { ensurePlotStatBudget } from './plotlines.js';
import { createThreat, attachThreat } from './threats.js';
import { resyncThreatJobs } from './worldLoop.js';
import { pairPrimaryId } from './confluxTime.js';
import { PARTING_ENDING_ID } from './confluxBoard.js';
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

export async function crystallizeContainer({ runtime, conflux, domains, world, day, log }) {
  const plot = conflux?.container;
  if (!plot || plot.crystallized) return plot;
  const draft = { gravity: 'CRISIS', synopsis: '', endings: [], threats: [] };
  if (runtime) {
    try {
      await runtime.run({
        agentId: 'confluxCrystal',
        scene: 'conflux_crystal',
        log,
        maxTurns: 2,
        toolChoice: { type: 'function', function: { name: 'submit_crystal' } },
        tools: [
          {
            name: 'submit_crystal',
            description: 'Исходы, помехи и первое развитие общей нити сопряжения.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['synopsis', 'gravity'],
              properties: {
                synopsis: { type: 'string' },
                gravity: { type: 'string', enum: ['CRISIS', 'RUPTURE'] },
                endings: { type: 'array', items: { type: 'string' } },
                threats: { type: 'array', items: { type: 'string' } },
              },
            },
            handler: async (args) => {
              draft.synopsis = String(args?.synopsis || '').trim();
              draft.gravity = args?.gravity === 'RUPTURE' ? 'RUPTURE' : 'CRISIS';
              draft.endings = Array.isArray(args?.endings) ? args.endings.map(String) : [];
              draft.threats = Array.isArray(args?.threats) ? args.threats.map(String) : [];
              return { ok: true };
            },
          },
        ],
        extraSystem:
          'Ты кристаллизуешь пустую нить сопряжения двух городов в историю. ' +
          'Не бойся решительно менять расстановку сил: сюжета ещё нет, его пишут игроки. ' +
          'Верни submit_crystal.',
        userMessages: [
          {
            role: 'user',
            content: [
              `Города: ${domains.map((d) => d.name).join(' и ')}`,
              conflux.passage?.text ? `Проход: ${conflux.passage.text}` : '',
              'Контейнер пары ещё пуст: напиши первое развитие отношений, если игроки молчат.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });
    } catch (err) {
      log?.warn?.('conflux.crystal_failed', { error: err.message });
    }
  }
  plot.crystallized = true;
  plot.gravity = draft.gravity;
  plot.maxDepth = 2;
  if (draft.synopsis) plot.synopsis = draft.synopsis;
  const keptEndings = (plot.endings || []).filter((e) => e.id === PARTING_ENDING_ID);
  const extraTexts = (draft.endings.length ? draft.endings : ['ссора у прохода', 'общий убыток']).slice(0, 3);
  plot.endings = [
    ...keptEndings,
    ...extraTexts.map((text, i) => ({
      id: `end_${i}`,
      kind: i === 0 ? 'GOOD_ENDING' : 'BAD_ENDING',
      text,
    })),
  ];
  const keptThreats = (plot.threats || []).filter(
    (t) => t.endingId === PARTING_ENDING_ID || t.eventKind === 'dock_meet',
  );
  plot.threats = keptThreats;
  const threatTexts = (draft.threats.length ? draft.threats : ['проход потребует крови или платы', 'на берегу назреет ссора']).slice(
    0,
    3,
  );
  while (threatTexts.length < 2) threatTexts.push('на проходе случится столкновение');
  for (const text of threatTexts) {
    attachThreat(
      plot,
      createThreat({
        plot,
        text,
        outcome: 'harm',
        valence: 'bad',
        known: true,
        day,
        band: 'SEASON',
      }),
    );
  }
  if (plot.stats && typeof plot.stats === 'object') {
    delete plot.stats.budget;
    delete plot.stats.remaining;
  }
  ensurePlotStatBudget(plot);
  if (world && domains?.length) {
    const primary = domains.find((d) => d.id === pairPrimaryId(conflux)) || domains[0];
    resyncThreatJobs(world, primary, plot);
  }
  return plot;
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
    if (out.threat && ctx.world && domains.length) {
      const primary = domains.find((d) => d.id === pairPrimaryId(conflux)) || domains[0];
      resyncThreatJobs(ctx.world, primary, conflux.container);
    }
    await savePair(ctx.storage, conflux, domains);
    if (out.skipped) return { skipped: out.skipped, nextAttemptDay: out.nextAttemptDay || null };
    return { occasion: 'сопряжение', confluxId: conflux.id, domains, threatId: out.threat?.id || null };
  },
  async conflux_beat(ctx) {
    const loaded = await loadPair(ctx.storage, ctx.job.payload?.confluxId);
    if (!loaded) return { skipped: 'gone' };
    const { conflux, domains } = loaded;
    if (conflux.status !== 'docked') return { skipped: 'not_docked' };
    if (!conflux.container?.crystallized) return { skipped: 'empty' };
    const facts = await writePairChronicle({
      runtime: ctx.runtime,
      world: ctx.world,
      conflux,
      domains,
      event: confluxEvent({
        kind: 'beat',
        day: ctx.day,
        plotId: conflux.container.id,
        textHint: conflux.container.synopsis || 'Общая нить сопряжения сдвинулась.',
      }),
      log: ctx.log,
    });
    await savePair(ctx.storage, conflux, domains);
    return { occasion: 'сопряжение', confluxId: conflux.id, domains, facts, plotId: conflux.container.id };
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
