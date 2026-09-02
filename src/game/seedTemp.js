/**
 * Температура каналов посева историй. Константы — tick.plot.seed, дробные ок.
 * Общий потолок max; сдвиги seed / miss / idle — у каждого источника свои.
 */

export const SEED_SOURCES = ['chronicle', 'void', 'errand'];

const DEFAULT_DELTAS = { seed: -6, miss: 2, idle: 1 };

export const DEFAULT_SEED = {
  max: 10,
  start: 5,
  worldLiveBelow: 3,
  errandDurationDiv: 3,
  chronicle: { ...DEFAULT_DELTAS },
  void: { ...DEFAULT_DELTAS },
  errand: { ...DEFAULT_DELTAS },
};

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parseDeltas(raw, fallback = DEFAULT_DELTAS) {
  return {
    seed: num(raw?.seed, fallback.seed),
    miss: num(raw?.miss, fallback.miss),
    idle: num(raw?.idle, fallback.idle),
  };
}

/** Сырой YAML `tick.plot.seed` или уже разобранный объект. */
export function parseSeedConfig(raw = {}) {
  const max = Math.max(0.001, num(raw.max, DEFAULT_SEED.max));
  const start = clamp(num(raw.start, DEFAULT_SEED.start), 0, max);
  return {
    max,
    start,
    worldLiveBelow: Math.max(0, num(raw.worldLiveBelow, DEFAULT_SEED.worldLiveBelow)),
    errandDurationDiv: Math.max(0.001, num(raw.errandDurationDiv, DEFAULT_SEED.errandDurationDiv)),
    chronicle: parseDeltas(raw.chronicle, DEFAULT_SEED.chronicle),
    void: parseDeltas(raw.void, DEFAULT_SEED.void),
    errand: parseDeltas(raw.errand, DEFAULT_SEED.errand),
  };
}

export function seedConfig(config) {
  if (config?.chronicle && Number.isFinite(Number(config.max))) return parseSeedConfig(config);
  if (config?.seed && typeof config.seed === 'object') return parseSeedConfig(config.seed);
  return parseSeedConfig(config?.tick?.plot?.seed || {});
}

export function clampSeedTemp(value, cfg = DEFAULT_SEED) {
  const max = Math.max(0.001, num(cfg.max, DEFAULT_SEED.max));
  const n = Number(value);
  if (!Number.isFinite(n)) return clamp(num(cfg.start, DEFAULT_SEED.start), 0, max);
  return clamp(n, 0, max);
}

export function emptySeedTemp(cfg = DEFAULT_SEED) {
  const start = clampSeedTemp(cfg.start, cfg);
  return { chronicle: start, void: start, errand: start };
}

export function normalizeSeedTemp(raw, cfg = DEFAULT_SEED) {
  const base = emptySeedTemp(cfg);
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base };
  for (const key of SEED_SOURCES) {
    out[key] = clampSeedTemp(src[key], cfg);
  }
  return out;
}

export function seedDeltas(source, cfg = DEFAULT_SEED) {
  const parsed = seedConfig(cfg);
  const key = SEED_SOURCES.includes(source) ? source : 'void';
  return parsed[key] || DEFAULT_DELTAS;
}

export function applySeedDelta(temp, source, event, cfg = DEFAULT_SEED) {
  const parsed = seedConfig(cfg);
  const deltas = seedDeltas(source, parsed);
  const kind = event === 'seed' || event === 'miss' || event === 'idle' ? event : 'idle';
  return clampSeedTemp(clampSeedTemp(temp, parsed) + deltas[kind], parsed);
}

export function touchSeedTemp(domain, source, event, cfg = DEFAULT_SEED) {
  if (!domain || typeof domain !== 'object') return null;
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  const parsed = seedConfig(cfg);
  domain.state.seedTemp = normalizeSeedTemp(domain.state.seedTemp, parsed);
  domain.state.seedTemp[source] = applySeedDelta(domain.state.seedTemp[source], source, event, parsed);
  return domain.state.seedTemp[source];
}

export function worldSeedChance(temp, cfg = DEFAULT_SEED) {
  const parsed = seedConfig(cfg);
  return clamp(clampSeedTemp(temp, parsed) / parsed.max, 0, 1);
}

export function errandSeedChance(temp, durationMonths, cfg = DEFAULT_SEED) {
  const parsed = seedConfig(cfg);
  const months = Math.max(0, num(durationMonths, 0));
  const p = worldSeedChance(temp, parsed) * (months / parsed.errandDurationDiv);
  return clamp(p, 0, 1);
}
