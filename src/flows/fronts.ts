/**
 * Операции над фронтами загруженного города: пересчитать скорость и задание,
 * посадить поручение, открыть волю игрока как фронт, снять поручение.
 * Город меняется в памяти; сохраняет вызывающий.
 */

import type { City, Front, Officer } from '../core/city.js';
import type { Office } from '../core/rules.js';
import { scheduleFrontJob } from '../core/jobs.js';
import { activeAssignmentsForFront, closeAssignment, createAssignment, findAssignment, NO_EFFECT, type AssignmentVerdict } from '../core/world/assignments.js';
import { activeFronts, findFront, recomputeRate } from '../core/world/fronts.js';
import { buildMutationFront, consequenceAsk, type MutationDraft } from '../core/world/mutation.js';
import { efficiencyMultiplier } from '../core/world/scales.js';
import { findOfficer } from '../core/officers.js';
import { evaluateAssignment } from '../agents/assignment-evaluator/run.js';
import { draftMutation } from '../agents/mutation-drafter/run.js';
import { judgeFeasibility, type Feasibility } from '../agents/feasibility-judge/run.js';
import { judgeImpact } from '../agents/impact-judge/run.js';
import { generateConsequences } from '../agents/consequences-generator/run.js';
import { judgeConsequence } from '../agents/consequence-judge/run.js';
import { newId, tryAgent, type FlowDeps } from './context.js';

/** Скорость фронта изменилась — пересчитать её и переставить задание. */
export function refreshFront(deps: FlowDeps, city: City, front: Front, day: number): void {
  if (front.status === 'active') recomputeRate(deps.rules, city, front, day);
  scheduleFrontJob(city, front, () => newId(deps, 'job'));
}

/** Статы изменились — у всех фронтов могла поменяться скорость сановников. */
export function refreshAllFronts(deps: FlowDeps, city: City, day: number): void {
  for (const front of city.fronts) {
    if (front.status === 'active' || city.jobs.some((j) => j.state === 'pending' && j.payload.frontId === front.id)) {
      refreshFront(deps, city, front, day);
    }
  }
}

/** Фронт закрылся каскадом — его поручения тоже кончаются, сановники свободны. */
export function releaseDeadFronts(city: City, day: number): void {
  for (const front of city.fronts) {
    if (front.status === 'active') continue;
    for (const a of activeAssignmentsForFront(city, front.id)) closeAssignment(city, a.id, day, 'done');
  }
}

export type OfficerCheck = { ok: true; officer: Officer } | { ok: false; error: 'no_officer' | 'officer_busy'; busyWith: string | null };

export function freeOfficer(city: City, office: Office): OfficerCheck {
  const officer = findOfficer(city, office);
  if (!officer) return { ok: false, error: 'no_officer', busyWith: null };
  if (officer.assignmentId) {
    const a = findAssignment(city, officer.assignmentId);
    if (a && a.status === 'active') return { ok: false, error: 'officer_busy', busyWith: a.text };
    officer.assignmentId = null;
  }
  return { ok: true, officer };
}

function attach(city: City, officer: Officer, front: Front | null, text: string, verdict: AssignmentVerdict, deps: FlowDeps, day: number) {
  const assignment = createAssignment({ id: newId(deps, 'asg'), frontId: front?.id ?? null, office: officer.office, text, verdict, day });
  city.assignments.push(assignment);
  officer.assignmentId = assignment.id;
  if (front) refreshFront(deps, city, front, day);
  return assignment;
}

/**
 * Поручение садится на лучший из последних фронтов. Ни один не двигается —
 * сановник всё равно занят делом, но историю оно не сдвинет.
 */
export async function placeAssignment(deps: FlowDeps, city: City, officer: Officer, text: string, day: number) {
  const candidates = activeFronts(city)
    .slice()
    .sort((a, b) => b.createdDay - a.createdDay)
    .slice(0, deps.rules.fronts.assignment.evaluatorCandidates);
  let best: { front: Front; verdict: AssignmentVerdict } | null = null;
  for (const front of candidates) {
    const verdict = await tryAgent(deps, 'assignment-evaluator', () => evaluateAssignment(deps.agents, { front, officer, text }), NO_EFFECT);
    if (verdict.direction === 'none') continue;
    if (!best || efficiencyMultiplier(deps.rules, verdict.efficiency) > efficiencyMultiplier(deps.rules, best.verdict.efficiency)) {
      best = { front, verdict };
    }
  }
  const assignment = attach(city, officer, best?.front ?? null, text, best?.verdict ?? NO_EFFECT, deps, day);
  return { assignment, front: best?.front ?? null };
}

export type MutationOutcome =
  | { kind: 'opened'; front: Front; draft: MutationDraft; consequences: number }
  | { kind: 'blocked'; feasibility: Exclude<Feasibility, { verdict: 'FEASIBLE' }> }
  | { kind: 'failed' };

/**
 * Воля игрока: черновик → можно ли → масштаб → последствия → фронт стройки,
 * на который сразу встаёт названный сановник.
 */
export async function openMutation(deps: FlowDeps, city: City, officer: Officer, intent: string, day: number): Promise<MutationOutcome> {
  const objects = city.objects.filter((o) => o.status === 'active');
  let draft: MutationDraft;
  try {
    draft = await draftMutation(deps.agents, { rules: deps.rules, intent, objects });
  } catch (err) {
    deps.log?.warn('agent_failed', { what: 'mutation-drafter', error: String(err) });
    return { kind: 'failed' };
  }
  const feasibility = await tryAgent(deps, 'feasibility-judge', () => judgeFeasibility(deps.agents, { draft, objects }), { verdict: 'FEASIBLE' } as Feasibility);
  if (feasibility.verdict !== 'FEASIBLE') return { kind: 'blocked', feasibility };

  const assessment = await tryAgent(deps, 'impact-judge', () => judgeImpact(deps.agents, { draft, objects }), null);
  if (!assessment) return { kind: 'failed' };

  const { budget, ask } = consequenceAsk(deps.rules, assessment.impact);
  const candidates = await tryAgent(deps, 'consequences-generator', () => generateConsequences(deps.agents, { draft, objects, count: ask }), []);
  const consequences = [];
  for (const candidate of candidates) {
    if (consequences.length >= budget) break;
    const ok = await tryAgent(deps, 'consequence-judge', () => judgeConsequence(deps.agents, { draft, objects, candidate }), false);
    if (ok) consequences.push(candidate);
  }

  const front = buildMutationFront(deps.rules, {
    id: newId(deps, 'front'),
    intent,
    draft,
    assessment,
    consequences,
    alignment: `Фронт двигает прямая работа над этим: ${draft.description}`,
    day,
  });
  city.fronts.push(front);
  attach(city, officer, front, intent, { direction: 'forward', efficiency: 'normal', blocks: [], stopWhen: 'stake' }, deps, day);
  return { kind: 'opened', front, draft, consequences: consequences.length };
}

/** Снять сановника с дела. */
export function withdrawOfficer(deps: FlowDeps, city: City, office: Office, day: number): { ok: boolean; text: string | null } {
  const officer = findOfficer(city, office);
  const assignment = officer?.assignmentId ? findAssignment(city, officer.assignmentId) : null;
  if (!officer || !assignment || assignment.status !== 'active') return { ok: false, text: null };
  closeAssignment(city, assignment.id, day, 'cancelled');
  const front = assignment.frontId ? findFront(city, assignment.frontId) : null;
  if (front) refreshFront(deps, city, front, day);
  return { ok: true, text: assignment.text };
}
