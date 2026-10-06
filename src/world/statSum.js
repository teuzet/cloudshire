/**
 * Статы города — производные: масштаб вкладов объектов плюс прямой ledger.
 */

import { syncFaith } from '../game/stats.js';
import { STAT_IDS, activeObjects, emptyStatEffect, normalizeStatEffect } from './objects.js';

function statIds(config) {
  const fromConfig = (config?.stats || []).map((def) => def?.id).filter(Boolean);
  return fromConfig.length ? fromConfig : STAT_IDS;
}

export { emptyStatEffect };

export function sumObjectEffects(domain, config = null) {
  const ids = statIds(config);
  const sum = {};
  for (const id of ids) sum[id] = 0;
  for (const obj of activeObjects(domain)) {
    const effect = normalizeStatEffect(obj.statEffect);
    for (const id of ids) sum[id] += Number(effect[id]) || 0;
  }
  return sum;
}

export function recomputeStats(domain, config = null) {
  if (!domain || typeof domain !== 'object') return {};
  const ids = statIds(config);
  const scale = Number.isFinite(Number(domain.statScale)) ? Number(domain.statScale) : 1;
  const ledger = domain.statLedger && typeof domain.statLedger === 'object' ? domain.statLedger : {};
  const sum = sumObjectEffects(domain, config);
  if (!domain.stats || typeof domain.stats !== 'object') domain.stats = {};
  for (const id of ids) {
    const raw = scale * (Number(sum[id]) || 0) + (Number(ledger[id]) || 0);
    domain.stats[id] = Math.max(0, Math.min(100, Math.round(raw)));
  }
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  syncFaith(domain);
  return domain.stats;
}

export function addToLedger(domain, deltas, config = null) {
  if (!domain.statLedger || typeof domain.statLedger !== 'object') {
    domain.statLedger = emptyStatEffect();
  }
  for (const [key, raw] of Object.entries(deltas || {})) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    domain.statLedger[key] = (Number(domain.statLedger[key]) || 0) + n;
  }
  return recomputeStats(domain, config);
}
