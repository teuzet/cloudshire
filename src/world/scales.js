/**
 * Читалка шкал фронтов. Чисел здесь нет: все значения лежат в config.fronts.
 * Отсутствие ключа — ошибка с точным путём, а не молчаливый запасной вариант.
 */

import { DAYS_PER_MONTH } from '../game/gameClock.js';

const cache = new WeakMap();

function fail(path) {
  throw new Error(`нет ${path}`);
}

function finiteAt(obj, path) {
  const n = Number(obj);
  if (!Number.isFinite(n)) fail(path);
  return n;
}

function stringList(raw, path) {
  if (!Array.isArray(raw) || raw.length === 0) fail(path);
  return raw.map((item, i) => {
    const s = String(item || '').trim();
    if (!s) fail(`${path}[${i}]`);
    return s;
  });
}

function tableFor(levels, table, path) {
  if (!table || typeof table !== 'object') fail(path);
  const out = {};
  for (const level of levels) {
    out[level] = finiteAt(table[level], `${path}.${level}`);
  }
  return out;
}

function validate(config) {
  const fronts = config?.fronts;
  if (!fronts || typeof fronts !== 'object') fail('config.fronts');

  const impact = fronts.impact;
  if (!impact || typeof impact !== 'object') fail('config.fronts.impact');
  const levels = stringList(impact.levels, 'config.fronts.impact.levels');
  const levelSet = new Set(levels);

  const effort = tableFor(levels, impact.effort, 'config.fronts.impact.effort');
  const rawBudget = tableFor(levels, impact.rawBudget, 'config.fronts.impact.rawBudget');
  const consequences = tableFor(levels, impact.consequences, 'config.fronts.impact.consequences');

  const drift = fronts.drift;
  if (!drift || typeof drift !== 'object') fail('config.fronts.drift');
  const bands = stringList(drift.bands, 'config.fronts.drift.bands');
  const perMonth = tableFor(bands, drift.perMonth, 'config.fronts.drift.perMonth');

  const assignment = fronts.assignment;
  if (!assignment || typeof assignment !== 'object') fail('config.fronts.assignment');
  const efficiency = assignment.efficiency;
  if (!efficiency || typeof efficiency !== 'object' || !Object.keys(efficiency).length) {
    fail('config.fronts.assignment.efficiency');
  }
  const efficiencyTable = {};
  for (const [key, value] of Object.entries(efficiency)) {
    efficiencyTable[key] = finiteAt(value, `config.fronts.assignment.efficiency.${key}`);
  }
  const baseRate = finiteAt(assignment.baseRate, 'config.fronts.assignment.baseRate');
  const statFloor = finiteAt(assignment.statFloor, 'config.fronts.assignment.statFloor');
  const evaluatorCandidates = finiteAt(
    assignment.evaluatorCandidates,
    'config.fronts.assignment.evaluatorCandidates',
  );

  const risk = fronts.risk;
  if (!risk || typeof risk !== 'object') fail('config.fronts.risk');
  const riskLevels = stringList(risk.levels, 'config.fronts.risk.levels');
  const perEffort = tableFor(riskLevels, risk.perEffort, 'config.fronts.risk.perEffort');
  if (!risk.impactCap || typeof risk.impactCap !== 'object') fail('config.fronts.risk.impactCap');
  const impactCap = {};
  for (const level of riskLevels) {
    const cap = String(risk.impactCap[level] || '').trim();
    if (!levelSet.has(cap)) fail(`config.fronts.risk.impactCap.${level}`);
    impactCap[level] = cap;
  }

  const objects = fronts.objects;
  if (!objects || typeof objects !== 'object') fail('config.fronts.objects');
  const types = stringList(objects.types, 'config.fronts.objects.types');
  const nameMax = finiteAt(objects.nameMax, 'config.fronts.objects.nameMax');
  const descriptionMax = finiteAt(objects.descriptionMax, 'config.fronts.objects.descriptionMax');

  const genesisObjects = fronts.genesisObjects;
  if (!genesisObjects || typeof genesisObjects !== 'object') fail('config.fronts.genesisObjects');
  const minCount = finiteAt(genesisObjects.minCount, 'config.fronts.genesisObjects.minCount');
  const maxCount = finiteAt(genesisObjects.maxCount, 'config.fronts.genesisObjects.maxCount');
  if (minCount > maxCount) fail('config.fronts.genesisObjects.minCount');
  const profileRange = finiteAt(genesisObjects.profileRange, 'config.fronts.genesisObjects.profileRange');

  const consequenceCfg = fronts.consequences;
  if (!consequenceCfg || typeof consequenceCfg !== 'object') fail('config.fronts.consequences');
  const overdraft = finiteAt(consequenceCfg.overdraft, 'config.fronts.consequences.overdraft');

  const cascade = fronts.cascade;
  if (!cascade || typeof cascade !== 'object') fail('config.fronts.cascade');
  const maxSteps = finiteAt(cascade.maxSteps, 'config.fronts.cascade.maxSteps');

  return {
    impact: { levels, rawBudget, effort, consequences },
    drift: { bands, perMonth },
    assignment: { baseRate, statFloor, efficiency: efficiencyTable, evaluatorCandidates },
    risk: { levels: riskLevels, perEffort, impactCap },
    consequences: { overdraft },
    objects: { types, nameMax, descriptionMax },
    genesisObjects: { minCount, maxCount, profileRange },
    cascade: { maxSteps },
  };
}

/** Разобранная и проверенная секция config.fronts. Один раз на объект конфига. */
export function frontScales(config) {
  if (!config || typeof config !== 'object') fail('config');
  const hit = cache.get(config);
  if (hit) return hit;
  const parsed = validate(config);
  cache.set(config, parsed);
  return parsed;
}

export function impactLevels(config) {
  return frontScales(config).impact.levels;
}

export function parseImpact(config, raw) {
  const text = String(raw || '').trim().toUpperCase();
  return impactLevels(config).includes(text) ? text : null;
}

function lookup(table, impact) {
  const key = String(impact || '').trim().toUpperCase();
  const value = table[key];
  return Number.isFinite(value) ? value : 0;
}

export function impactEffort(config, impact) {
  return lookup(frontScales(config).impact.effort, impact);
}

export function impactRawBudget(config, impact) {
  return lookup(frontScales(config).impact.rawBudget, impact);
}

export function consequenceBudget(config, impact) {
  return lookup(frontScales(config).impact.consequences, impact);
}

export function driftBands(config) {
  return frontScales(config).drift.bands;
}

export function parseDriftBand(config, raw) {
  const bands = driftBands(config);
  const text = String(raw || '').trim().toUpperCase();
  return bands.includes(text) ? text : bands[0];
}

export function driftPerDay(config, band) {
  const scales = frontScales(config);
  const key = parseDriftBand(config, band);
  return scales.drift.perMonth[key] / DAYS_PER_MONTH;
}

export function efficiencyLevels(config) {
  return Object.keys(frontScales(config).assignment.efficiency);
}

/**
 * Effort сановника за игровой день, со знаком направления.
 * backward — минус, none и неизвестная степень — ноль.
 */
export function officerRate(config, { stat, efficiency, direction } = {}) {
  const scales = frontScales(config);
  if (direction === 'none') return 0;
  const mult = scales.assignment.efficiency[efficiency];
  if (!Number.isFinite(mult)) return 0;
  const clamped = Math.max(0, Math.min(100, Number(stat) || 0));
  const rate = scales.assignment.baseRate * (scales.assignment.statFloor + clamped / 100) * mult;
  return direction === 'backward' ? -rate : rate;
}

/** Пороги битов: effort * i / (beatCount + 1). Пусто, если считать нечего. */
export function beatThresholds(effort, beatCount) {
  const count = Math.round(Number(beatCount) || 0);
  const total = Number(effort) || 0;
  if (count <= 0 || total <= 0) return [];
  const out = [];
  for (let i = 1; i <= count; i += 1) out.push((total * i) / (count + 1));
  return out;
}

export function riskLevels(config) {
  return frontScales(config).risk.levels;
}

export function complicationChance(config, risk, effortDone) {
  const per = frontScales(config).risk.perEffort[risk];
  if (!Number.isFinite(per)) return 0;
  const done = Math.max(0, Number(effortDone) || 0);
  return 1 - (1 - per) ** done;
}

export function riskImpactCap(config, risk) {
  return frontScales(config).risk.impactCap[risk] || null;
}

export function objectTypes(config) {
  return frontScales(config).objects.types;
}

export function objectLimits(config) {
  const objects = frontScales(config).objects;
  return { nameMax: objects.nameMax, descriptionMax: objects.descriptionMax };
}

export function genesisObjectBounds(config) {
  return frontScales(config).genesisObjects;
}

export function cascadeMaxSteps(config) {
  return frontScales(config).cascade.maxSteps;
}

export function consequenceOverdraft(config) {
  return frontScales(config).consequences.overdraft;
}

export function evaluatorCandidateLimit(config) {
  return frontScales(config).assignment.evaluatorCandidates;
}
