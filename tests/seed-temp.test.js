import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plotConfig } from '../src/game/plotlines.js';
import { emptyState, normalizeDomain } from '../src/game/models.js';
import {
  parseSeedConfig,
  applySeedDelta,
  errandSeedChance,
  worldSeedChance,
  normalizeSeedTemp,
  pickVoidGrain,
} from '../src/game/seedTemp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fileCfg = yaml.load(fs.readFileSync(path.join(root, 'config/default.yaml'), 'utf8'));

test('конфиг посева: общий max, сдвиги по источнику, дроби', () => {
  const parsed = parseSeedConfig({
    max: 10.5,
    start: 5.25,
    worldLiveBelow: 3,
    errandDurationDiv: 3,
    chronicle: { seed: -6.5, miss: 2.25, idle: 1 },
    void: { seed: -6, miss: 2, idle: 0.5 },
    errand: { seed: -6, miss: 2, idle: 1 },
  });
  assert.equal(parsed.max, 10.5);
  assert.equal(parsed.start, 5.25);
  assert.equal(parsed.chronicle.seed, -6.5);
  assert.equal(parsed.chronicle.miss, 2.25);
  assert.equal(parsed.void.idle, 0.5);
  assert.equal(applySeedDelta(5.25, 'chronicle', 'seed', parsed), 0);
  assert.equal(applySeedDelta(5.25, 'chronicle', 'miss', parsed), 7.5);
  assert.equal(applySeedDelta(9.8, 'void', 'idle', parsed), 10.3);
  assert.equal(applySeedDelta(10.4, 'void', 'idle', parsed), 10.5);
});

test('default.yaml совпадает с калибровкой: 6 месяцев на старте → P=1', () => {
  const seed = plotConfig(fileCfg).seed;
  assert.equal(seed.max, 10);
  assert.equal(seed.start, 5);
  assert.equal(seed.errand.miss, 2);
  assert.equal(seed.errand.seed, -6);
  assert.equal(seed.errand.idle, 1);
  assert.equal(errandSeedChance(seed.start, 6, seed), 1);
  assert.equal(errandSeedChance(seed.start, 3, seed), 0.5);
  assert.equal(worldSeedChance(seed.start, seed), 0.5);
  assert.equal(seed.voidGenesisChance, 0.5);
});

test('пустой канал: половина — генезис города, половина — пустота', () => {
  const half = parseSeedConfig({ voidGenesisChance: 0.5 });
  assert.equal(pickVoidGrain(half, () => 0.49), 'genesis');
  assert.equal(pickVoidGrain(half, () => 0.5), 'void');
  assert.equal(pickVoidGrain(parseSeedConfig({ voidGenesisChance: 1 }), () => 0.99), 'genesis');
  assert.equal(pickVoidGrain(parseSeedConfig({ voidGenesisChance: 0 }), () => 0), 'void');
  assert.equal(pickVoidGrain(fileCfg, () => 0.49), 'genesis');
});

test('домен нормализует дробную температуру в общий потолок', () => {
  const domain = { state: { seedTemp: { chronicle: 4.2, void: 99 } } };
  normalizeDomain(domain);
  assert.equal(domain.state.seedTemp.chronicle, 4.2);
  assert.equal(domain.state.seedTemp.void, 10);
  assert.equal(domain.state.seedTemp.errand, 5);
  const fresh = { state: emptyState() };
  normalizeDomain(fresh);
  assert.deepEqual(fresh.state.seedTemp, { chronicle: 5, void: 5, errand: 5 });
  assert.deepEqual(normalizeSeedTemp(null).errand, 5);
});
