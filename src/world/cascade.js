/**
 * Каскад по refs: один агент видит одно изменение и одну сущность.
 */

import { toolFail } from '../agents/toolResult.js';
import { getLogger } from '../log.js';
import { cascadeMaxSteps } from './scales.js';
import { deleteWorldObject, findObject } from './objects.js';
import { findFront } from './front.js';

const VERDICTS = ['unchanged', 'updated', 'invalid', 'resolved'];

export function reverseRefs(domain) {
  const index = new Map();
  const link = (id, entity) => {
    const key = String(id || '');
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entity);
  };
  for (const object of domain?.worldObjects || []) {
    for (const ref of object?.refs || []) link(ref, { kind: 'object', id: object.id });
  }
  for (const front of domain?.fronts || []) {
    for (const ref of front?.refs || []) link(ref, { kind: 'front', id: front.id });
  }
  return index;
}

function entityOf(domain, ref) {
  if (ref.kind === 'object') {
    const object = findObject(domain, ref.id);
    return object ? { kind: 'object', entity: object } : null;
  }
  const front = findFront(domain, ref.id);
  return front ? { kind: 'front', entity: front } : null;
}

function applyVerdict(domain, packed, verdict, day) {
  const { kind, entity } = packed;
  if (verdict.verdict === 'unchanged') return [];
  if (kind === 'object' && (verdict.verdict === 'invalid' || verdict.verdict === 'resolved')) {
    if (entity.status !== 'deleted') deleteWorldObject(entity, day);
    return [{ kind: 'deleted', id: entity.id }];
  }
  if (kind === 'front' && (verdict.verdict === 'invalid' || verdict.verdict === 'resolved')) {
    entity.status = verdict.verdict === 'resolved' ? 'resolved' : 'invalid';
    return [{ kind: entity.status, id: entity.id }];
  }
  if (verdict.verdict === 'updated' && verdict.text) {
    entity.description = verdict.text;
    return [];
  }
  return [];
}

async function askUpdater(runtime, change, packed, log) {
  if (!runtime) return { verdict: 'unchanged' };
  const draft = { data: null };
  await runtime.run({
    agentId: 'localWorldUpdater',
    tools: [
      {
        name: 'submit_local_update',
        description: 'Что стало с одной сущностью.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['verdict'],
          properties: {
            verdict: { type: 'string', enum: VERDICTS },
            text: { type: 'string' },
          },
        },
        handler: async (args) => {
          if (!VERDICTS.includes(args?.verdict)) return toolFail('verdict', 'unchanged, updated, invalid или resolved.');
          draft.data = { verdict: args.verdict, text: String(args?.text || '').trim() };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_local_update' } },
    log,
    scene: 'local_update',
    extraSystem: [
      `Изменение: ${JSON.stringify(change)}`,
      `Сущность: ${packed.entity.name || packed.entity.description || packed.entity.id}`,
    ].join('\n'),
    userMessages: [{ role: 'user', content: packed.entity.id }],
  });
  return draft.data || { verdict: 'unchanged' };
}

export async function cascadeChange(config, domain, changeEvent, { runtime = null, updater = null, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'cascade' });
  const limit = Math.max(1, Math.round(cascadeMaxSteps(config)));
  const queue = [{ ...(changeEvent || {}), id: changeEvent?.id || changeEvent?.changes?.[0]?.id }];
  const seen = new Set();
  let steps = 0;
  const applied = [];
  while (queue.length && steps < limit) {
    const change = queue.shift();
    const origin = String(change.id || change.changes?.[0]?.id || '');
    if (!origin) continue;
    const subscribers = reverseRefs(domain).get(origin) || [];
    for (const ref of subscribers) {
      if (steps >= limit) break;
      const key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const packed = entityOf(domain, ref);
      if (!packed) continue;
      steps += 1;
      const verdict = updater
        ? await updater(change, packed.entity)
        : await askUpdater(runtime, change, packed, log);
      const follow = applyVerdict(domain, packed, verdict || { verdict: 'unchanged' }, changeEvent?.day || 0);
      applied.push({ id: packed.entity.id, verdict: verdict?.verdict || 'unchanged' });
      for (const next of follow) queue.push(next);
    }
  }
  return applied;
}
