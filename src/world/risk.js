/**
 * Осложнение — не провал. Код решает, выпало ли оно, и держит потолок ущерба.
 */

import { toolFail } from '../agents/toolResult.js';
import { activeAssignmentsForFront } from './assignment.js';
import { parseImpact, riskImpactCap, riskLevels, complicationChance, impactLevels } from './scales.js';

function impactRank(config, level) {
  const index = impactLevels(config).indexOf(level);
  return index < 0 ? 0 : index;
}

export function clampImpact(config, risk, impact) {
  const cap = riskImpactCap(config, risk);
  const proposed = parseImpact(config, impact) || 'MINOR';
  if (!cap) return proposed;
  return impactRank(config, proposed) > impactRank(config, cap) ? cap : proposed;
}

export function complicationHits(config, risk, effortDone, rng = Math.random) {
  const chance = complicationChance(config, risk, effortDone);
  if (chance <= 0) return false;
  return rng() < chance;
}

export async function classifyRisk({ runtime, config, text, log } = {}) {
  if (!runtime) return 'LOW';
  const draft = { risk: null };
  await runtime.run({
    agentId: 'riskJudge',
    tools: [
      {
        name: 'submit_risk',
        description: 'Уровень риска способа работы.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['risk'],
          properties: { risk: { type: 'string', enum: riskLevels(config) } },
        },
        handler: async (args) => {
          const risk = String(args?.risk || '').trim();
          if (!riskLevels(config).includes(risk)) return toolFail('risk', 'LOW, MEDIUM или HIGH.');
          draft.risk = risk;
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_risk' } },
    log,
    scene: 'risk',
    extraSystem: String(text || ''),
    userMessages: [{ role: 'user', content: String(text || '') }],
  });
  return draft.risk || 'LOW';
}

export async function maybeComplication({
  config,
  runtime = null,
  domain,
  front,
  day = 0,
  rng = Math.random,
  log,
} = {}) {
  const assignment = activeAssignmentsForFront(domain, front?.id).find((item) => item.risk);
  if (!assignment) return null;
  const slice = Math.max(0, Number(assignment.effortDone) - Number(assignment.riskCheckedAtEffort || 0));
  assignment.riskCheckedAtEffort = assignment.effortDone;
  if (!complicationHits(config, assignment.risk, slice, rng)) return null;
  const cap = riskImpactCap(config, assignment.risk);
  let impact = cap;
  let description = `Работа дала осложнение в пределах ${cap}.`;
  if (runtime) {
    const draft = { data: null };
    await runtime.run({
      agentId: 'complicationGenerator',
      tools: [
        {
          name: 'submit_complication',
          description: 'Негативное последствие работы.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['description', 'impact'],
            properties: {
              description: { type: 'string' },
              impact: { type: 'string', enum: impactLevels(config) },
            },
          },
          handler: async (args) => {
            const text = String(args?.description || '').trim();
            if (!text) return toolFail('empty', 'Нужно описание осложнения.');
            draft.data = { description: text, impact: args.impact };
            return { ok: true };
          },
        },
      ],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_complication' } },
      log,
      scene: 'complication',
      extraSystem: `Потолок ущерба: ${cap}. Метод: ${assignment.text}`,
      userMessages: [{ role: 'user', content: assignment.text }],
    });
    if (draft.data) {
      description = draft.data.description;
      impact = clampImpact(config, assignment.risk, draft.data.impact);
    }
  }
  const capped = clampImpact(config, assignment.risk, impact);
  return { description, impact: capped, day };
}
