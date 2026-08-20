import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { projectRoot } from '../config.js';

/**
 * @typedef {{ city?: string, ruler?: string, freeform?: string }} PlayerBrief
 * @typedef {{ talk?: string, tick?: boolean }} ScriptedAction
 * @typedef {{
 *   id?: string,
 *   cityName: string,
 *   playerBrief?: PlayerBrief,
 *   ambition?: string,
 *   goals?: string[],
 *   scriptedActions?: ScriptedAction[],
 * }} PlaytestScenario
 */

/**
 * @param {string} scenarioPath
 * @returns {PlaytestScenario}
 */
export function loadScenario(scenarioPath) {
  const absolute = path.isAbsolute(scenarioPath)
    ? scenarioPath
    : path.join(projectRoot(), scenarioPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Scenario not found: ${absolute}`);
  }
  const raw = yaml.load(fs.readFileSync(absolute, 'utf8')) || {};
  const cityName = String(raw.cityName || '').trim();
  if (!cityName) {
    throw new Error(`Scenario ${absolute}: cityName is required`);
  }

  let scriptedActions = [];
  if (Array.isArray(raw.scriptedActions)) {
    scriptedActions = raw.scriptedActions.map(normalizeScriptedAction).filter(Boolean);
  } else if (Array.isArray(raw.scriptedTurns)) {
    // backward compat: only talks; ticks must be inserted by runner if needed
    scriptedActions = raw.scriptedTurns
      .map((t) => String(t).trim())
      .filter(Boolean)
      .map((talk) => ({ talk }));
  }

  return {
    id: raw.id || path.basename(absolute, path.extname(absolute)),
    cityName,
    playerBrief: {
      city: String(raw.playerBrief?.city || '').trim(),
      ruler: String(raw.playerBrief?.ruler || '').trim(),
      freeform: String(raw.playerBrief?.freeform || '').trim(),
    },
    ambition: String(raw.ambition || '').trim(),
    goals: Array.isArray(raw.goals)
      ? raw.goals.map((g) => (typeof g === 'string' ? g : JSON.stringify(g)))
      : [],
    scriptedActions,
  };
}

function normalizeScriptedAction(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.tick === true || item.action === 'tick') {
    return { tick: true };
  }
  const talk = String(item.talk || item.message || '').trim();
  if (talk) return { talk };
  return null;
}
