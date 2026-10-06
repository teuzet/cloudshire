/**
 * Порог фронта: выбор заранее заготовленного события или улики и одна хроника.
 */

import { appendEventFact } from '../game/worldLoop.js';
import { toolFail } from '../agents/toolResult.js';
import { getLogger } from '../log.js';
import { closeAssignment, activeAssignmentsForFront } from './assignment.js';
import { beatThresholds, officerRate } from './scales.js';
import { findFront, settleProgress } from './front.js';
import { scheduleFrontJob } from './frontJobs.js';
import { releaseNextConsequence } from './mutation.js';
import { maybeComplication } from './risk.js';

function crossedIndex(front) {
  const thresholds = beatThresholds(front.effort, front.beatCount);
  const fired = new Set(front.beatsFired || []);
  for (let i = 0; i < thresholds.length; i += 1) {
    if (fired.has(i)) continue;
    if (front.progress + 1e-9 >= thresholds[i]) return i;
  }
  return null;
}

export function applyBlocks(front, domain) {
  if (!front) return [];
  const blocked = [];
  for (const assignment of activeAssignmentsForFront(domain, front.id)) {
    if ((Number(assignment.effortDone) || 0) < 1) continue;
    for (const id of assignment.blocks || []) {
      const event = (front.events || []).find((item) => item.id === id);
      if (event && event.status === 'live') {
        event.status = 'blocked';
        blocked.push(event.id);
      }
    }
  }
  return blocked;
}

export function accrueAssignmentEffort(config, domain, day, { officerRate }) {
  const current = Math.max(0, Math.round(Number(day) || 0));
  for (const assignment of domain?.assignments || []) {
    if (!assignment || assignment.status !== 'active') continue;
    const from = assignment.effortDay == null ? assignment.startDay : assignment.effortDay;
    const elapsed = Math.max(0, current - Math.round(Number(from) || 0));
    const officer = (domain.officers || []).find((item) => String(item.id) === String(assignment.officerId));
    const stat = officer?.statId ? Number(domain.stats?.[officer.statId]) || 0 : 0;
    const rate = Math.abs(officerRate(config, {
      stat,
      efficiency: assignment.efficiency,
      direction: assignment.direction === 'none' ? 'none' : 'forward',
    }));
    assignment.effortDone = (Number(assignment.effortDone) || 0) + rate * elapsed;
    assignment.effortDay = current;
  }
}

async function askPicker({ runtime, front, log }) {
  const events = (front.events || []).filter((event) => event.status !== 'fired');
  const clues = (front.clues || []).filter((clue) => clue.status === 'hidden');
  const ids = new Set([...events.map((event) => event.id), ...clues.map((clue) => clue.id)]);
  if (!ids.size) return {};
  const draft = { data: null };
  await runtime.run({
    agentId: 'beatResolver',
    tools: [
      {
        name: 'submit_beat_pick',
        description: 'Одно событие или одна улика.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            event_id: { type: 'string' },
            clue_id: { type: 'string' },
          },
        },
        handler: async (args) => {
          const eventId = String(args?.event_id || '').trim();
          const clueId = String(args?.clue_id || '').trim();
          if (eventId && !ids.has(eventId)) return toolFail('unknown_event', 'Такого события нет.');
          if (clueId && !ids.has(clueId)) return toolFail('unknown_clue', 'Такой улики нет.');
          if (!eventId && !clueId) return toolFail('empty', 'Нужен event_id или clue_id.');
          draft.data = { eventId: eventId || null, clueId: clueId || null };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_beat_pick' } },
    log,
    scene: 'front_beat',
    extraSystem: [
      front.description,
      events.length ? `События:\n${events.map((event) => `- ${event.id} [${event.status}]: ${event.description}`).join('\n')}` : '',
      clues.length ? `Улики:\n${clues.map((clue) => `- ${clue.id}: ${clue.fact}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
    userMessages: [{ role: 'user', content: front.description }],
  });
  return draft.data || {};
}

async function writeChronicle({ runtime, domain, world, day, factText, log }) {
  let text = factText;
  if (runtime) {
    const draft = { text: null };
    await runtime.run({
      agentId: 'frontChronicle',
      tools: [
        {
          name: 'submit_chronicle',
          description: 'Текст одной записи хроники.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: { text: { type: 'string' } },
          },
          handler: async (args) => {
            const next = String(args?.text || '').trim();
            if (!next) return toolFail('empty', 'Пустая хроника.');
            draft.text = next;
            return { ok: true };
          },
        },
      ],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_chronicle' } },
      log,
      scene: 'front_chronicle',
      extraSystem: factText,
      userMessages: [{ role: 'user', content: factText }],
    });
    if (draft.text) text = draft.text;
  }
  return appendEventFact(domain, world || { gameDate: null, tickIndex: 0 }, {
    text,
    day,
    author: 'front',
    tags: ['chronicle'],
  });
}

export async function resolveFrontBeat({
  config,
  runtime = null,
  domain,
  world = null,
  front = null,
  frontId = null,
  day = 0,
  rng = Math.random,
  pick = null,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'front_beat' });
  const target = front || findFront(domain, frontId);
  if (!target || target.status !== 'active') return { skipped: 'gone' };
  accrueAssignmentEffort(config, domain, day, { officerRate });
  applyBlocks(target, domain);
  settleProgress(target, day);
  const index = crossedIndex(target);
  if (index == null) return { skipped: 'no_beat' };
  target.beatsFired = [...(target.beatsFired || []), index];

  const events = (target.events || []).filter((event) => event.status !== 'fired');
  const clues = (target.clues || []).filter((clue) => clue.status === 'hidden');
  const choice = pick
    ? await pick({ events, clues, front: target })
    : runtime
      ? await askPicker({ runtime, front: target, log })
      : {
          eventId: events[0]?.id || null,
          clueId: events.length ? null : clues[0]?.id || null,
        };

  let event = null;
  let clue = null;
  let averted = false;
  if (choice?.eventId) {
    event = (target.events || []).find((item) => item.id === choice.eventId) || null;
    if (event) {
      averted = event.status === 'blocked';
      event.status = 'fired';
    }
  } else if (choice?.clueId) {
    clue = (target.clues || []).find((item) => item.id === choice.clueId) || null;
    if (clue) clue.status = 'revealed';
  }

  const factText = clue
    ? clue.fact
    : event
      ? (averted ? `Подготовка сдержала удар: ${event.description}` : event.description)
      : target.description;
  const fact = await writeChronicle({ runtime: pick ? null : runtime, domain, world, day, factText, log });

  for (const assignment of activeAssignmentsForFront(domain, target.id)) {
    if (assignment.stopWhen === 'next_result') closeAssignment(domain, assignment.id, day, 'done');
  }
  await maybeComplication({ config, runtime, domain, front: target, day, rng, log });
  releaseNextConsequence(config, domain, target, day);
  if (world) scheduleFrontJob(world, domain, target);
  return { fact, front: target, frontId: target.id, event, clue, averted, occasion: 'фронт' };
}
