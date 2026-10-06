/**
 * Стартовые объекты города и перевод их сырого веса в статы.
 * Модель задаёт направление, бюджет и масштаб считает код.
 */

import { toolFail } from '../agents/toolResult.js';
import { getLogger } from '../log.js';
import { statBudgetConfig, clipToBudget } from '../game/stats.js';
import { STAT_IDS } from './objects.js';
import { createWorldObject } from './objects.js';
import {
  genesisObjectBounds,
  impactLevels,
  impactRawBudget,
  objectLimits,
  objectTypes,
  parseImpact,
} from './scales.js';

function statIds(config) {
  const fromConfig = (config?.stats || []).map((def) => def?.id).filter(Boolean);
  return fromConfig.length ? fromConfig : STAT_IDS;
}

export function objectContribution(config, weight, statProfile) {
  const ids = statIds(config);
  const budget = impactRawBudget(config, weight);
  let denom = 0;
  const profile = {};
  for (const id of ids) {
    const n = Number(statProfile?.[id]) || 0;
    profile[id] = n;
    denom += Math.abs(n);
  }
  const contrib = {};
  for (const id of ids) {
    contrib[id] = denom === 0 ? 0 : (budget * profile[id]) / denom;
  }
  return contrib;
}

export function buildGenesisObjects({ drafts, config, cityName, day = 0 } = {}) {
  const ids = statIds(config);
  const contributions = (drafts || []).map((draft) => objectContribution(config, draft.weight, draft.stat_profile || draft.statProfile));
  const total = contributions.reduce(
    (sum, contrib) => sum + ids.reduce((inner, id) => inner + (Number(contrib[id]) || 0), 0),
    0,
  );
  if (!(total > 0)) {
    throw new Error('суммарный вклад объектов неположительный');
  }

  const { budget, min, max } = statBudgetConfig(config);
  const kScale = budget / total;
  const summed = {};
  for (const id of ids) {
    summed[id] = contributions.reduce((sum, contrib) => sum + (Number(contrib[id]) || 0), 0);
  }
  const derived = ids.map((id) => Math.round(kScale * summed[id]));
  const final = clipToBudget(derived, { budget, min, max });
  const residual = {};
  ids.forEach((id, i) => {
    residual[id] = (final[i] - derived[i]) / kScale;
  });

  const limits = objectLimits(config);
  const objects = (drafts || []).map((draft, i) =>
    createWorldObject(config, {
      type: draft.type,
      name: draft.name,
      description: draft.description,
      statEffect: contributions[i],
      day,
    }),
  );
  objects.push(
    createWorldObject(config, {
      id: limits.baselineId,
      type: 'settlement',
      name: cityName || 'Город',
      description: 'Город как таковой: его люди, быт и привычный уклад',
      statEffect: residual,
      day,
      protected: true,
    }),
  );

  const stats = {};
  ids.forEach((id, i) => {
    stats[id] = final[i];
  });
  return { objects, statScale: kScale, stats };
}

export async function requestWorldObjects({ runtime, config, description, frozenConcept, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'world_objects_genesis' });
  if (!runtime) throw new Error('нет runtime для объектов города');
  const ids = statIds(config);
  const weights = impactLevels(config).filter((level) => level !== 'NONE');
  const types = objectTypes(config);
  const draft = { data: null };
  await runtime.run({
    agentId: 'worldObjectsGenesis',
    tools: [
      {
        name: 'submit_world_objects',
        description: 'Объекты мира уже описанного города.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['objects'],
          properties: {
            objects: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'name', 'description', 'weight', 'stat_profile'],
                properties: {
                  type: { type: 'string', enum: types },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  weight: { type: 'string', enum: weights },
                  stat_profile: {
                    type: 'object',
                    additionalProperties: false,
                    required: ids,
                    properties: Object.fromEntries(ids.map((id) => [id, { type: 'integer' }])),
                  },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const bounds = genesisObjectBounds(config);
          const list = Array.isArray(args?.objects) ? args.objects : [];
          if (list.length < bounds.minCount || list.length > bounds.maxCount) {
            return toolFail(
              'count',
              `Нужно от ${bounds.minCount} до ${bounds.maxCount} объектов, пришло ${list.length}.`,
            );
          }
          const accepted = [];
          for (const item of list) {
            const profile = item?.stat_profile || {};
            const values = {};
            for (const id of ids) {
              const n = Number(profile[id]);
              if (!Number.isFinite(n) || Math.abs(n) > bounds.profileRange) {
                return toolFail(
                  'profile',
                  `stat_profile «${item?.name || '?'}» вне -${bounds.profileRange}..${bounds.profileRange}.`,
                );
              }
              values[id] = n;
            }
            if (ids.every((id) => values[id] === 0)) {
              return toolFail('profile_flat', `У «${item?.name || '?'}» нулевой профиль.`);
            }
            const weight = parseImpact(config, item?.weight);
            if (!weight || weight === 'NONE') {
              return toolFail('weight', `У «${item?.name || '?'}» нет веса.`);
            }
            const type = String(item?.type || '').trim();
            if (!types.includes(type)) return toolFail('type', `Неизвестный тип «${type}».`);
            const name = String(item?.name || '').trim();
            if (!name) return toolFail('name', 'У объекта нет имени.');
            accepted.push({
              type,
              name,
              description: String(item?.description || '').trim(),
              weight,
              stat_profile: values,
            });
          }
          draft.data = accepted;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_world_objects' } },
    log,
    scene: 'world_objects_genesis',
    extraSystem: [
      frozenConcept?.name ? `Город «${frozenConcept.name}».` : '',
      frozenConcept ? JSON.stringify(frozenConcept) : '',
    ]
      .filter(Boolean)
      .join('\n'),
    userMessages: [{ role: 'user', content: String(description || '') }],
  });
  if (!draft.data) throw new Error('объекты города не собраны');
  return draft.data;
}
