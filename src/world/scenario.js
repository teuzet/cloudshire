/**
 * Зерно истории один раз создаёт объекты и фронты. Дальше они живут сами.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { toolFail } from '../agents/toolResult.js';
import { getLogger } from '../log.js';
import { projectRoot } from '../config.js';
import { createFront } from './front.js';
import { createWorldObject } from './objects.js';
import { impactEffort, objectTypes, parseDriftBand, parseImpact } from './scales.js';

export function loadScenarioSeed(file) {
  const absolute = path.isAbsolute(file) ? file : path.join(projectRoot(), file);
  return yaml.load(fs.readFileSync(absolute, 'utf8'));
}

export function applyScenarioDraft(config, domain, draft, day = 0) {
  const objects = [];
  for (const spec of draft?.objects || []) {
    const object = createWorldObject(config, {
      id: spec.id || null,
      type: spec.type,
      name: spec.name,
      description: spec.description || spec.name,
      statEffect: spec.statEffect || spec.stat_effect || {},
      refs: spec.refs || [],
      day,
    });
    objects.push(object);
  }
  const fronts = [];
  for (const spec of draft?.fronts || []) {
    const impact = parseImpact(config, spec.impact || spec.weight) || 'SIGNIFICANT';
    const front = createFront(config, {
      id: spec.id || null,
      description: spec.description,
      stake: spec.stake || null,
      effort: impactEffort(config, impact),
      driftBand: parseDriftBand(config, spec.drift),
      beatCount: Math.max(0, Math.round(Number(spec.beat_count || spec.beatCount) || 0)),
      events: spec.events || [],
      clues: spec.clues || [],
      alignment: spec.alignment || '',
      refs: spec.refs || [],
      day,
    });
    fronts.push(front);
  }
  domain.worldObjects = [...(domain.worldObjects || []), ...objects];
  domain.fronts = [...(domain.fronts || []), ...fronts];
  return { objects, fronts };
}

export async function initializeScenario({
  config,
  runtime = null,
  domain,
  seed,
  day = 0,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'scenario' });
  if (!runtime) return applyScenarioDraft(config, domain, seed?.create || seed, day);
  const types = objectTypes(config);
  const draft = { data: null };
  await runtime.run({
    agentId: 'scenarioInitializer',
    tools: [
      {
        name: 'submit_scenario',
        description: 'Объекты и фронты, которые зерно сажает в город.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['objects', 'fronts'],
          properties: {
            objects: { type: 'array' },
            fronts: { type: 'array' },
          },
        },
        handler: async (args) => {
          const objects = Array.isArray(args?.objects) ? args.objects : [];
          for (const object of objects) {
            if (!types.includes(object?.type)) return toolFail('type', `Неизвестный тип «${object?.type}».`);
            if (!String(object?.name || '').trim()) return toolFail('name', 'У объекта нет имени.');
          }
          draft.data = { objects, fronts: Array.isArray(args?.fronts) ? args.fronts : [] };
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_scenario' } },
    log,
    scene: 'scenario',
    extraSystem: seed?.title ? `Зерно: ${seed.title}` : '',
    userMessages: [{ role: 'user', content: JSON.stringify(seed || {}) }],
  });
  if (!draft.data) throw new Error('зерно не собрано');
  return applyScenarioDraft(config, domain, draft.data, day);
}
