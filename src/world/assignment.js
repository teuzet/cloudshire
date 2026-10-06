/**
 * Поручение сановника на фронт. Чисел здесь нет: направление и сила — полосы.
 */

import { newId } from '../game/ids.js';
import { toolFail } from '../agents/toolResult.js';
import { getLogger } from '../log.js';
import {
  efficiencyLevels,
  evaluatorCandidateLimit,
  frontScales,
} from './scales.js';

const DIRECTIONS = ['forward', 'backward', 'none'];
const STOP_WHEN = ['next_result', 'stake', 'cancelled'];
const STATUSES = ['active', 'done', 'cancelled'];

function clip(raw) {
  return String(raw || '').trim();
}

export function normalizeAssignment(raw, config = null) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clip(raw.text || raw.summary);
  if (!text) return null;
  const knownEfficiency = config ? efficiencyLevels(config) : null;
  let efficiency = clip(raw.efficiency) || 'normal';
  if (knownEfficiency && !knownEfficiency.includes(efficiency)) efficiency = knownEfficiency.includes('normal') ? 'normal' : knownEfficiency[0];
  return {
    id: clip(raw.id) || newId('asg'),
    frontId: clip(raw.frontId) || null,
    officerId: clip(raw.officerId) || null,
    office: clip(raw.office) || null,
    text,
    summary: text,
    direction: DIRECTIONS.includes(raw.direction) ? raw.direction : 'none',
    efficiency,
    blocks: [...new Set((Array.isArray(raw.blocks) ? raw.blocks : []).map((id) => clip(id)).filter(Boolean))],
    stopWhen: STOP_WHEN.includes(raw.stopWhen || raw.stop_when) ? (raw.stopWhen || raw.stop_when) : 'stake',
    risk: clip(raw.risk) || null,
    status: STATUSES.includes(raw.status) ? raw.status : 'active',
    startDay: Math.max(0, Math.round(Number(raw.startDay) || 0)),
    endDay: raw.endDay == null ? null : Math.max(0, Math.round(Number(raw.endDay) || 0)),
    effortDone: Math.max(0, Number(raw.effortDone) || 0),
    effortDay: raw.effortDay == null ? null : Math.max(0, Math.round(Number(raw.effortDay) || 0)),
  };
}

export function normalizeAssignments(list, config = null) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => normalizeAssignment(item, config)).filter(Boolean);
}

export function createAssignment({
  frontId = null,
  officerId = null,
  office = null,
  text,
  direction = 'none',
  efficiency = 'normal',
  blocks = [],
  stopWhen = 'stake',
  risk = null,
  day = 0,
} = {}) {
  return normalizeAssignment({
    frontId,
    officerId,
    office,
    text,
    direction,
    efficiency,
    blocks,
    stopWhen,
    risk,
    status: 'active',
    startDay: day,
    effortDone: 0,
    effortDay: day,
  });
}

export function activeAssignmentsForFront(domain, frontId) {
  const needle = String(frontId || '');
  return (domain?.assignments || []).filter(
    (item) => item && item.status === 'active' && String(item.frontId || '') === needle,
  );
}

export function closeAssignment(domain, id, day, reason = 'done') {
  const assignment = (domain?.assignments || []).find((item) => item && String(item.id) === String(id));
  if (!assignment) return null;
  assignment.status = reason === 'cancelled' ? 'cancelled' : 'done';
  assignment.endDay = Math.max(0, Math.round(Number(day) || 0));
  const officer = (domain?.officers || []).find((item) => item && String(item.processId) === String(assignment.id));
  if (officer) officer.processId = null;
  return assignment;
}

function efficiencyOf(config, level) {
  return frontScales(config).assignment.efficiency[level] || 0;
}

export async function evaluateAssignment({
  runtime,
  config,
  front,
  text,
  officer,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'assignment_eval' });
  const liveEvents = (front?.events || []).filter((event) => event.status !== 'fired');
  const allowed = new Set(liveEvents.map((event) => event.id));
  const draft = { data: null };
  if (!runtime) return { direction: 'none', efficiency: 'normal', blocks: [], stopWhen: 'stake' };
  await runtime.run({
    agentId: 'assignmentEvaluator',
    tools: [
      {
        name: 'submit_assignment_eval',
        description: 'Как поручение относится к фронту.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['direction', 'efficiency', 'blocks', 'stop_when'],
          properties: {
            direction: { type: 'string', enum: DIRECTIONS },
            efficiency: { type: 'string', enum: efficiencyLevels(config) },
            blocks: { type: 'array', items: { type: 'string' } },
            stop_when: { type: 'string', enum: STOP_WHEN },
          },
        },
        handler: async (args) => {
          const blocks = (Array.isArray(args?.blocks) ? args.blocks : []).map((id) => String(id || '').trim()).filter(Boolean);
          const foreign = blocks.filter((id) => !allowed.has(id));
          if (foreign.length) {
            return toolFail('unknown_block', `Нет таких событий: ${foreign.join(', ')}.`);
          }
          if (!DIRECTIONS.includes(args?.direction)) return toolFail('direction', 'direction: forward, backward или none.');
          if (!efficiencyLevels(config).includes(args?.efficiency)) return toolFail('efficiency', 'Неизвестная степень.');
          if (!STOP_WHEN.includes(args?.stop_when)) return toolFail('stop_when', 'stop_when: next_result, stake или cancelled.');
          draft.data = {
            direction: args.direction,
            efficiency: args.efficiency,
            blocks,
            stopWhen: args.stop_when,
          };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_assignment_eval' } },
    log,
    scene: 'assignment_eval',
    extraSystem: [
      front?.description ? `Фронт: ${front.description}` : '',
      front?.alignment ? `Скрытая логика фронта:\n${front.alignment}` : '',
      liveEvents.length
        ? `События:\n${liveEvents.map((event) => `- ${event.id}: ${event.description}`).join('\n')}`
        : 'Событий нет.',
      officer ? `Сановник: ${officer.title || officer.office || 'сановник'} ${officer.name || ''}`.trim() : '',
      text ? `Поручение: ${text}` : '',
    ].filter(Boolean).join('\n\n'),
    userMessages: [{ role: 'user', content: String(text || '') }],
  });
  return draft.data || { direction: 'none', efficiency: 'normal', blocks: [], stopWhen: 'stake' };
}

/**
 * Если в городе есть живые фронты, поручение садится на лучший из них.
 * Нет фронтов — null, и вызывающий остаётся на прежнем пути дел.
 */
export async function assignToFront({
  runtime,
  config,
  domain,
  officer,
  text,
  day = 0,
  log,
} = {}) {
  const fronts = (domain?.fronts || [])
    .filter((front) => front && front.status === 'active')
    .sort((a, b) => (b.createdDay || 0) - (a.createdDay || 0))
    .slice(0, Math.max(1, Math.round(evaluatorCandidateLimit(config))));
  if (!fronts.length) return null;

  let best = null;
  let bestFront = null;
  for (const front of fronts) {
    const verdict = await evaluateAssignment({ runtime, config, front, text, officer, log });
    if (verdict.direction === 'none') {
      if (!best) best = { ...verdict, front: null };
      continue;
    }
    const rank = efficiencyOf(config, verdict.efficiency);
    if (!best || best.direction === 'none' || rank > efficiencyOf(config, best.efficiency)) {
      best = verdict;
      bestFront = front;
    }
  }
  const verdict = best || { direction: 'none', efficiency: 'normal', blocks: [], stopWhen: 'stake' };
  const assignment = createAssignment({
    frontId: bestFront?.id || null,
    officerId: officer?.id || null,
    office: officer?.office || null,
    text,
    direction: verdict.direction,
    efficiency: verdict.efficiency,
    blocks: verdict.blocks,
    stopWhen: verdict.stopWhen,
    day,
  });
  if (!Array.isArray(domain.assignments)) domain.assignments = [];
  domain.assignments.push(assignment);
  if (officer) officer.processId = assignment.id;
  return { assignment, front: bestFront, verdict };
}
