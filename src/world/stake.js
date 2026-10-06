/**
 * Ставка фронта: мир меняется, когда шкала доходит до конца.
 */

import { toolFail } from '../agents/toolResult.js';
import { getLogger } from '../log.js';
import { appendEventFact } from '../game/worldLoop.js';
import { closeAssignment, activeAssignmentsForFront } from './assignment.js';
import { cancelFrontJobs } from './frontJobs.js';
import { findFront } from './front.js';
import { objectContribution } from './genesisObjects.js';
import {
  addObjectVersion,
  createWorldObject,
  deleteWorldObject,
  findObject,
} from './objects.js';
import { addToLedger, recomputeStats } from './statSum.js';
import { cascadeChange } from './cascade.js';
import { impactLevels, parseImpact } from './scales.js';
import { STAT_IDS } from './objects.js';

function statIds(config) {
  const fromConfig = (config?.stats || []).map((def) => def?.id).filter(Boolean);
  return fromConfig.length ? fromConfig : STAT_IDS;
}

async function writeVersion(runtime, config, object, mutation, log) {
  if (!runtime) return null;
  const ids = statIds(config);
  const draft = { data: null };
  await runtime.run({
    agentId: 'objectVersionWriter',
    tools: [
      {
        name: 'submit_object_version',
        description: 'Новая каноническая версия объекта.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'stat_profile'],
          properties: {
            description: { type: 'string' },
            stat_profile: {
              type: 'object',
              properties: Object.fromEntries(ids.map((id) => [id, { type: 'integer' }])),
            },
            weight: { type: 'string', enum: impactLevels(config) },
          },
        },
        handler: async (args) => {
          const description = String(args?.description || '').trim();
          if (!description) return toolFail('empty', 'Нужно описание новой версии.');
          draft.data = {
            description,
            weight: parseImpact(config, args?.weight) || 'MINOR',
            stat_profile: args?.stat_profile || {},
          };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_object_version' } },
    log,
    scene: 'object_version',
    extraSystem: [
      `Объект: ${object.name}`,
      `Сейчас: ${object.description}`,
      object.versions?.length ? `Прежние версии:\n${object.versions.map((v) => `- ${v.version}. ${v.description}`).join('\n')}` : '',
      mutation ? `Задуманное изменение: ${JSON.stringify(mutation)}` : '',
    ].filter(Boolean).join('\n\n'),
    userMessages: [{ role: 'user', content: object.name }],
  });
  return draft.data;
}

function finishFront(domain, world, front, day) {
  front.status = 'resolved';
  front.resolvedDay = day;
  for (const assignment of activeAssignmentsForFront(domain, front.id)) {
    if (assignment.stopWhen === 'stake' || assignment.stopWhen === 'next_result') {
      closeAssignment(domain, assignment.id, day, 'done');
    }
  }
  if (world) cancelFrontJobs(world, front.id);
}

export async function applyStake({
  config,
  runtime = null,
  domain,
  world = null,
  front,
  day = 0,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'front_stake' });
  const stake = front?.stake || {};
  const changes = [];

  if (stake.create) {
    const spec = stake.create;
    const weight = parseImpact(config, spec.weight || spec.impact) || 'SIGNIFICANT';
    const effect = spec.statEffect || objectContribution(config, weight, spec.stat_profile || spec.statProfile || {});
    const object = createWorldObject(config, {
      type: spec.type,
      name: spec.name,
      description: spec.description || spec.name,
      statEffect: effect,
      refs: spec.refs || [],
      day,
    });
    domain.worldObjects = domain.worldObjects || [];
    domain.worldObjects.push(object);
    recomputeStats(domain, config);
    changes.push({ kind: 'created', id: object.id });
  } else if (stake.modify) {
    const object = findObject(domain, stake.modify.target);
    if (!object) {
      front.status = 'invalid';
      return { error: 'missing_target', front };
    }
    const written = stake.modify.proposed_version
      ? null
      : await writeVersion(runtime, config, object, stake.modify, log);
    const proposed = stake.modify.proposed_version || written;
    const weight = parseImpact(config, proposed?.weight) || 'MINOR';
    const effect = proposed?.statEffect
      || objectContribution(config, weight, proposed?.stat_profile || proposed?.statProfile || object.statEffect);
    addObjectVersion(object, {
      description: proposed?.description || object.description,
      statEffect: effect,
      day,
    });
    recomputeStats(domain, config);
    changes.push({ kind: 'modified', id: object.id });
  } else if (stake.delete) {
    const object = findObject(domain, stake.delete.target);
    if (!object) {
      front.status = 'invalid';
      return { error: 'missing_target', front };
    }
    if (object.protected) {
      front.status = 'invalid';
      front.resolvedDay = day;
      if (world) cancelFrontJobs(world, front.id);
      return { error: 'protected', front };
    }
    deleteWorldObject(object, day);
    recomputeStats(domain, config);
    changes.push({ kind: 'deleted', id: object.id });
  } else if (stake.stats) {
    addToLedger(domain, stake.stats, config);
    changes.push({ kind: 'stats', deltas: stake.stats });
  } else if (stake.reveal) {
    const text = typeof stake.reveal === 'string' ? stake.reveal : stake.reveal.text;
    appendEventFact(domain, world || { gameDate: null, tickIndex: 0 }, {
      text: String(text || '').trim(),
      day,
      author: 'front',
      tags: ['chronicle'],
    });
    changes.push({ kind: 'reveal' });
  }

  if (front.status !== 'invalid') finishFront(domain, world, front, day);
  if (changes.length) {
    await cascadeChange(config, domain, { changes, day }, { log });
  }
  return { front, changes };
}

export async function resolveFrontStake({
  config,
  runtime,
  domain,
  world,
  frontId,
  day = 0,
  log,
} = {}) {
  const front = findFront(domain, frontId);
  if (!front || front.status !== 'active') return { skipped: 'gone' };
  const applied = await applyStake({ config, runtime, domain, world, front, day, log });
  return { ...applied, occasion: 'ставка', frontId: front.id };
}
