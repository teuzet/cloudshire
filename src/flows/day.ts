/**
 * День города: разобрать задания, чей срок наступил, в порядке наступления.
 *
 *   front_beat  — фронт дошёл до порога: последствие стройки или событие/улика;
 *   front_stake — фронт дошёл до конца: ставка, каскад по refs, развязка;
 *   seed        — проверить, хватает ли городу живых историй.
 *
 * Время не тикает: задание стоит на дне, когда фронт дойдёт до порога при
 * нынешней скорости. Скорость меняется — задание переставляется.
 */

import type { City, Job, World } from '../core/city.js';
import { claimJob, completeJob, dueJobs, failJob, pruneJobs, recoverRunningJobs } from '../core/jobs.js';
import { accrueMana } from '../core/mana.js';
import { findOfficer } from '../core/officers.js';
import { accrueEffort, activeAssignmentsForFront } from '../core/world/assignments.js';
import { applyBeatPick, beginBeat, closeNextResultAssignments, defaultBeatPick } from '../core/world/beats.js';
import { runCascade, type CascadeChange } from '../core/world/cascade.js';
import { findFront, settleProgress, stakeReached } from '../core/world/fronts.js';
import { releaseNextConsequence } from '../core/world/mutation.js';
import { findObject } from '../core/world/objects.js';
import { applyStake, finishFront, stakeFact, stakeNeedsVersion } from '../core/world/stake.js';
import { recomputeStats } from '../core/world/stats.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { resolveBeat } from '../agents/beat-resolver/run.js';
import { judgeLocalUpdate } from '../agents/local-world-updater/run.js';
import { writeObjectVersion } from '../agents/object-version-writer/run.js';
import { record } from './chronicle.js';
import { newId, requireWorld, sendAll, today, tryAgent, type FlowDeps } from './context.js';
import { refreshAllFronts, refreshFront, releaseDeadFronts } from './fronts.js';
import { seedStories } from './seeding.js';

/** Сколько заданий разбирать за один проход, чтобы проход не тянулся вечно. */
const MAX_JOBS_PER_PASS = 50;

function officerOn(city: City, frontId: string) {
  const a = activeAssignmentsForFront(city, frontId)[0];
  return a ? findOfficer(city, a.office) : null;
}

async function beatJob(deps: FlowDeps, city: City, job: Job, out: OutboundMessage[]): Promise<void> {
  const front = job.payload.frontId ? findFront(city, job.payload.frontId) : null;
  if (!front || front.status !== 'active') return;
  const day = job.dueDay;
  const start = beginBeat(deps.rules, city, front, day);
  if (!start) return refreshFront(deps, city, front, day);

  if (front.pendingConsequences.length) {
    const side = releaseNextConsequence(deps.rules, city, front, { id: newId(deps, 'front'), day });
    if (side) {
      refreshFront(deps, city, side, day);
      const msg = await record(deps, city, { fact: side.description, source: 'mutation', frontId: side.id, day, kind: 'beat', officer: null, announce: true });
      if (msg) out.push(msg);
    }
  } else if (start.events.length || start.clues.length) {
    const officer = officerOn(city, front.id);
    const history = city.chronicle.filter((e) => e.frontId === front.id).slice(-5);
    const pick = await tryAgent(deps, 'beat-resolver', () => resolveBeat(deps.agents, { front, start, history }), defaultBeatPick(start));
    const outcome = applyBeatPick(front, pick);
    closeNextResultAssignments(city, front, day);
    const msg = await record(deps, city, { fact: outcome.fact, source: 'beat', frontId: front.id, day, kind: 'beat', officer, announce: true });
    if (msg) out.push(msg);
  }
  refreshFront(deps, city, front, day);
}

async function stakeJob(deps: FlowDeps, city: City, job: Job, out: OutboundMessage[]): Promise<void> {
  const front = job.payload.frontId ? findFront(city, job.payload.frontId) : null;
  if (!front || front.status !== 'active') return;
  const day = job.dueDay;
  accrueEffort(deps.rules, city, day);
  settleProgress(front, day);
  if (!stakeReached(front)) return refreshFront(deps, city, front, day);

  const officer = officerOn(city, front.id);
  // Недоигранные последствия стройки открываются все разом: дело кончилось, хвосты остались.
  while (front.pendingConsequences.length) {
    const side = releaseNextConsequence(deps.rules, city, front, { id: newId(deps, 'front'), day });
    if (side) refreshFront(deps, city, side, day);
  }

  const need = stakeNeedsVersion(front);
  let version = null;
  if (need) {
    const target = findObject(city, need.target);
    version = target
      ? await tryAgent(
          deps,
          'object-version-writer',
          () => writeObjectVersion(deps.agents, { rules: deps.rules, object: target, change: [front.description, need.intent].filter(Boolean).join('. ') }),
          null,
        )
      : null;
    if (!version) {
      finishFront(city, front, day, 'invalid');
      refreshAllFronts(deps, city, day);
      return;
    }
  }

  const result = applyStake(deps.rules, city, front, { day, newObjectId: () => newId(deps, 'obj'), version });
  const start: CascadeChange[] = [{ id: front.id, kind: result.invalid ? 'invalid' : 'resolved' }];
  for (const c of result.changes) {
    if (c.kind === 'created' || c.kind === 'modified' || c.kind === 'deleted') start.push({ id: c.id, kind: c.kind });
  }
  await runCascade(city, start, {
    day,
    maxSteps: deps.rules.fronts.cascade.maxSteps,
    judge: (change, target) => tryAgent(deps, 'local-world-updater', () => judgeLocalUpdate(deps.agents, { city, change, target }), { verdict: 'unchanged' as const }),
  });
  recomputeStats(city);
  releaseDeadFronts(city, day);
  refreshAllFronts(deps, city, day);

  const fact = result.invalid ? `Дело оборвалось: ${front.description}` : stakeFact(city, result);
  const msg = await record(deps, city, { fact, source: 'stake', frontId: front.id, day, kind: result.invalid ? 'beat' : 'resolution', officer, announce: true });
  if (msg) out.push(msg);
}

async function handle(deps: FlowDeps, city: City, job: Job, out: OutboundMessage[]): Promise<void> {
  if (job.kind === 'front_beat') return beatJob(deps, city, job, out);
  if (job.kind === 'front_stake') return stakeJob(deps, city, job, out);
  out.push(...(await seedStories(deps, city, job.dueDay)));
}

/**
 * Разобрать наступившие задания уже загруженного города. Город меняется
 * в памяти; вести возвращаются, чтобы отправить их после сохранения.
 */
export async function processDue(deps: FlowDeps, world: World, city: City): Promise<OutboundMessage[]> {
  const now = today(deps, world);
  const out: OutboundMessage[] = [];
  recoverRunningJobs(city);
  for (let n = 0; n < MAX_JOBS_PER_PASS; n++) {
    const job = dueJobs(city, now)[0];
    if (!job || !claimJob(job)) break;
    try {
      await handle(deps, city, job, out);
      completeJob(job);
    } catch (err) {
      failJob(job, String(err));
      deps.log?.warn('job_failed', { cityId: city.id, job: job.kind, error: String(err) });
    }
  }
  accrueMana(deps.rules, city, now);
  pruneJobs(city);
  return out;
}

/** Догнать город до текущего дня, сохранить и разослать вести. */
export async function advanceCity(deps: FlowDeps, cityId: string): Promise<number> {
  const world = await requireWorld(deps);
  const city = await deps.storage.getCity(cityId);
  if (!city) return 0;
  const out = await processDue(deps, world, city);
  await deps.storage.saveCity(city);
  await sendAll(deps, out);
  return out.length;
}
