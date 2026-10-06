/**
 * Свободное намерение игрока становится фронтом.
 * Количество побочных фронтов задаёт код, не модель.
 */

import { toolFail } from '../agents/toolResult.js';
import { getLogger } from '../log.js';
import { createFront } from './front.js';
import { objectContribution } from './genesisObjects.js';
import {
  consequenceBudget,
  consequenceOverdraft,
  impactEffort,
  impactLevels,
  parseDriftBand,
  parseImpact,
} from './scales.js';

const VERDICTS = ['FEASIBLE', 'LOCKED', 'IMPOSSIBLE'];
const MUTATIONS = ['create', 'modify', 'delete'];

function blankProfile(config) {
  const ids = (config?.stats || []).map((def) => def.id);
  return Object.fromEntries(ids.map((id) => [id, 0]));
}

export async function openPlayerMutation({
  config,
  runtime = null,
  domain,
  intent,
  day = 0,
  judges = null,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'mutation' });
  const mutate = judges?.mutate || ((text) => askMutation(runtime, text, log));
  const feasibility = judges?.feasibility || ((mutation) => askFeasibility(runtime, config, mutation, log));
  const impact = judges?.impact || ((mutation) => askImpact(runtime, config, mutation, log));
  const consequences = judges?.consequences || ((mutation, count) => askConsequences(runtime, mutation, count, log));
  const judge = judges?.judge || ((candidate) => askConsequenceJudge(runtime, candidate, log));

  const mutation = await mutate(intent);
  if (!mutation) return { status: 'empty', front: null };
  const gate = await feasibility(mutation);
  if (gate?.verdict === 'IMPOSSIBLE') return { status: 'impossible', front: null, reason: gate.reason || null };
  if (gate?.verdict === 'LOCKED') return { status: 'locked', front: null, missing: gate.missing || null };

  const weighed = await impact(mutation);
  const level = parseImpact(config, weighed?.impact) || 'MINOR';
  const effort = impactEffort(config, level);
  const profile = weighed?.stat_profile || weighed?.statProfile || blankProfile(config);
  const effect = objectContribution(config, level === 'NONE' ? 'MINOR' : level, profile);
  const budget = consequenceBudget(config, level);
  const asked = budget + Math.max(0, Math.round(consequenceOverdraft(config)));
  const proposed = budget > 0 ? await consequences(mutation, asked) : [];
  const accepted = [];
  for (const candidate of proposed || []) {
    if (accepted.length >= budget) break;
    const verdict = await judge(candidate);
    if (verdict?.ok) accepted.push(candidate);
  }

  const front = createFront(config, {
    description: mutation.description || intent,
    stake: stakeOf(mutation, effect),
    effort,
    driftBand: 'NONE',
    beatCount: Math.max(0, accepted.length),
    alignment: mutation.alignment || '',
    pendingConsequences: accepted,
    day,
  });
  if (!Array.isArray(domain.fronts)) domain.fronts = [];
  domain.fronts.push(front);
  return { status: 'feasible', front, impact: level, pending: accepted.length };
}

function stakeOf(mutation, effect) {
  if (mutation.kind === 'delete') return { delete: { target: mutation.target } };
  if (mutation.kind === 'modify') {
    return { modify: { target: mutation.target, proposed_version: { description: mutation.description, statEffect: effect, weight: mutation.weight } } };
  }
  return {
    create: {
      type: mutation.type || 'structure',
      name: mutation.name,
      description: mutation.description,
      statEffect: effect,
    },
  };
}

export function releaseNextConsequence(config, domain, front, day) {
  if (!front?.pendingConsequences?.length) return null;
  const next = front.pendingConsequences.shift();
  const side = createFront(config, {
    description: next.description || next.name || 'Последствие',
    stake: next.stake || { stats: next.stats || {} },
    effort: impactEffort(config, parseImpact(config, next.impact) || 'MINOR'),
    driftBand: parseDriftBand(config, next.drift || 'SLOW'),
    beatCount: 0,
    refs: next.refs || [front.id],
    day,
  });
  domain.fronts = domain.fronts || [];
  domain.fronts.push(side);
  return side;
}

async function askMutation(runtime, intent, log) {
  if (!runtime) return null;
  const draft = { data: null };
  await runtime.run({
    agentId: 'mutationAgent',
    tools: [
      {
        name: 'submit_mutation',
        description: 'Одно изменение мира.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: MUTATIONS },
            type: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            target: { type: 'string' },
          },
        },
        handler: async (args) => {
          if (!MUTATIONS.includes(args?.kind)) return toolFail('kind', 'kind: create, modify или delete.');
          draft.data = {
            kind: args.kind,
            type: args.type || 'structure',
            name: String(args.name || '').trim(),
            description: String(args.description || args.name || '').trim(),
            target: args.target || null,
          };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_mutation' } },
    log,
    scene: 'mutation',
    userMessages: [{ role: 'user', content: String(intent || '') }],
  });
  return draft.data;
}

async function askFeasibility(runtime, config, mutation, log) {
  if (!runtime) return { verdict: 'FEASIBLE' };
  const draft = { data: null };
  await runtime.run({
    agentId: 'feasibilityJudge',
    tools: [
      {
        name: 'submit_feasibility',
        description: 'Возможность изменения.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['verdict'],
          properties: {
            verdict: { type: 'string', enum: VERDICTS },
            missing: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        handler: async (args) => {
          if (!VERDICTS.includes(args?.verdict)) return toolFail('verdict', 'FEASIBLE, LOCKED или IMPOSSIBLE.');
          draft.data = { verdict: args.verdict, missing: args.missing || null, reason: args.reason || null };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_feasibility' } },
    log,
    scene: 'feasibility',
    extraSystem: JSON.stringify(mutation),
    userMessages: [{ role: 'user', content: mutation.description || mutation.name || '' }],
  });
  return draft.data || { verdict: 'FEASIBLE' };
}

async function askImpact(runtime, config, mutation, log) {
  if (!runtime) return { impact: 'MINOR', stat_profile: blankProfile(config) };
  const ids = (config?.stats || []).map((def) => def.id);
  const draft = { data: null };
  await runtime.run({
    agentId: 'impactJudge',
    tools: [
      {
        name: 'submit_impact',
        description: 'Масштаб изменения.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['impact'],
          properties: {
            impact: { type: 'string', enum: impactLevels(config) },
            stat_profile: {
              type: 'object',
              properties: Object.fromEntries(ids.map((id) => [id, { type: 'integer' }])),
            },
          },
        },
        handler: async (args) => {
          const impact = parseImpact(config, args?.impact);
          if (!impact) return toolFail('impact', 'Неизвестный уровень.');
          draft.data = { impact, stat_profile: args.stat_profile || {} };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_impact' } },
    log,
    scene: 'impact',
    extraSystem: JSON.stringify(mutation),
    userMessages: [{ role: 'user', content: mutation.description || '' }],
  });
  return draft.data || { impact: 'MINOR', stat_profile: {} };
}

async function askConsequences(runtime, mutation, count, log) {
  if (!runtime || count <= 0) return [];
  const draft = { data: [] };
  await runtime.run({
    agentId: 'consequencesGenerator',
    tools: [
      {
        name: 'submit_consequences',
        description: 'Кандидаты побочных процессов.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  impact: { type: 'string' },
                },
              },
            },
          },
        },
        handler: async (args) => {
          draft.data = (Array.isArray(args?.items) ? args.items : [])
            .map((item) => ({ description: String(item?.description || '').trim(), impact: item?.impact || 'MINOR' }))
            .filter((item) => item.description);
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_consequences' } },
    log,
    scene: 'consequences',
    extraSystem: `Нужно кандидатов: ${count}`,
    userMessages: [{ role: 'user', content: JSON.stringify(mutation) }],
  });
  return draft.data;
}

async function askConsequenceJudge(runtime, candidate, log) {
  if (!runtime) return { ok: true };
  const draft = { ok: false };
  await runtime.run({
    agentId: 'consequenceJudge',
    tools: [
      {
        name: 'submit_consequence_verdict',
        description: 'Годится ли этот процесс как отдельное последствие.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
        handler: async (args) => {
          draft.ok = Boolean(args?.ok);
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_consequence_verdict' } },
    log,
    scene: 'consequence_judge',
    extraSystem: candidate.description,
    userMessages: [{ role: 'user', content: candidate.description }],
  });
  return draft;
}
