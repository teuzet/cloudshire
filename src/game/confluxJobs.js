/**
 * Задания пары: стыковка, расстыковка, касание, ход контейнера.
 * Берутся из общей очереди мира; handler грузит оба домена.
 */

import { dueJobs, claimJob, completeJob, failJob } from './scheduler.js';
import { findActiveConfluxForDomain, dockConfluxNow, undockConfluxNow } from './conflux.js';
import { normalizeDomain } from './models.js';
import { writePairChronicle, confluxEvent } from './confluxCanon.js';
import { ensurePlotStatBudget } from './plotlines.js';
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

function recordTouch(conflux, { day, domainId, kind, deedId = null }) {
  conflux.touches = Array.isArray(conflux.touches) ? conflux.touches : [];
  conflux.touches.push({
    day: Math.round(Number(day) || 0),
    domainId: domainId ? String(domainId) : null,
    kind: String(kind || 'touch'),
    deedId: deedId || null,
  });
  return conflux.touches;
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
              (conflux.touches || []).length
                ? `Касания:\n${(conflux.touches || []).map((t) => `- день ${t.day}: ${t.kind}`).join('\n')}`
                : 'Касаний от игроков не было — посей первое столкновение сам.',
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
  plot.endings = (draft.endings.length ? draft.endings : ['мирный разъезд', 'ссора у прохода', 'общий убыток']).map(
    (text, i) => ({
      id: `end_${i}`,
      kind: i === 0 ? 'GOOD_ENDING' : i === 1 ? 'NEUTRAL_ENDING' : 'BAD_ENDING',
      text,
    }),
  );
  plot.threats = (draft.threats.length ? draft.threats : ['проход потребует крови или платы']).map((text, i) => ({
    id: `thr_${i}`,
    text,
    known: true,
    dueDay: day + 30,
  }));
  if (plot.stats && typeof plot.stats === 'object') {
    delete plot.stats.budget;
    delete plot.stats.remaining;
  }
  ensurePlotStatBudget(plot);
  void world;
  return plot;
}

export async function maybeCrystallizeFromTouch({
  runtime,
  conflux,
  domains,
  world,
  day,
  log,
  touch,
} = {}) {
  if (!conflux || conflux.status !== 'docked') return null;
  recordTouch(conflux, touch || { day, kind: 'deed' });
  if (conflux.container && !conflux.container.crystallized) {
    await crystallizeContainer({ runtime, conflux, domains, world, day, log });
  }
  return conflux.container;
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
    if ((conflux.touches || []).length) return { skipped: 'already_touched' };
    recordTouch(conflux, { day: ctx.day, kind: 'seed' });
    await crystallizeContainer({
      runtime: ctx.runtime,
      conflux,
      domains,
      world: ctx.world,
      day: ctx.day,
      log: ctx.log,
    });
    const facts = await writePairChronicle({
      runtime: ctx.runtime,
      world: ctx.world,
      conflux,
      domains,
      event: confluxEvent({
        kind: 'contact_seed',
        day: ctx.day,
        plotId: conflux.container?.id,
        textHint: 'На проходе случилось первое столкновение без приказа с берегов.',
      }),
      log: ctx.log,
    });
    await savePair(ctx.storage, conflux, domains);
    return { occasion: 'касание', confluxId: conflux.id, domains, facts, plotId: conflux.container?.id };
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
  for (const job of due) {
    if (!claimJob(job)) continue;
    const handler = HANDLERS[job.kind];
    if (!handler) {
      completeJob(job, 'unknown_kind');
      continue;
    }
    try {
      const result = await handler({ config, runtime, storage, world, day, rng, log, job });
      completeJob(job, result?.skipped || 'ok');
      if (result && !result.skipped) events.push(result);
    } catch (err) {
      failJob(job, err.message);
      log.warn('conflux.job_failed', { kind: job.kind, error: err.message });
    }
  }
  return events;
}

export { recordTouch };

export async function activeConfluxOf(storage, domainId) {
  return findActiveConfluxForDomain(storage, domainId);
}
