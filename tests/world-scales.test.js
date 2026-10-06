import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frontScales,
  driftPerDay,
  officerRate,
  beatThresholds,
  complicationChance,
} from '../src/world/scales.js';
import { testConfig } from './helpers/config.js';

test('настоящий конфиг разбирается без ошибки', () => {
  const scales = frontScales(testConfig());
  assert.ok(scales.impact.levels.includes('MAJOR'));
  assert.equal(scales.drift.bands[0], 'NONE');
});

test('дырявый конфиг падает с путём до отсутствующего ключа', () => {
  assert.throws(
    () => frontScales({ fronts: { impact: { levels: ['MAJOR'] } } }),
    (err) => /impact\.effort/.test(err.message),
  );
});

test('дрейф STEADY — один effort за игровой месяц', () => {
  const perDay = driftPerDay(testConfig(), 'STEADY');
  assert.ok(Math.abs(perDay - 1 / 30) < 1e-9, String(perDay));
});

test('сановник со статом 50 и normal даёт базовую скорость со знаком направления', () => {
  const cfg = testConfig();
  const forward = officerRate(cfg, { stat: 50, efficiency: 'normal', direction: 'forward' });
  assert.equal(forward, 0.1);
  assert.equal(officerRate(cfg, { stat: 50, efficiency: 'normal', direction: 'backward' }), -0.1);
  assert.equal(officerRate(cfg, { stat: 50, efficiency: 'normal', direction: 'none' }), 0);
});

test('при базовой скорости фронт effort 6 проходится за 60 дней', () => {
  const rate = officerRate(testConfig(), { stat: 50, efficiency: 'normal', direction: 'forward' });
  assert.equal(6 / rate, 60);
});

test('два бита делят шкалу на три равные части', () => {
  assert.deepEqual(beatThresholds(6, 2), [2, 4]);
  assert.deepEqual(beatThresholds(0, 2), []);
  assert.deepEqual(beatThresholds(6, 0), []);
});

test('низкий риск на шести единицах effort даёт около одиннадцати процентов', () => {
  const chance = complicationChance(testConfig(), 'LOW', 6);
  assert.ok(chance > 0.11 && chance < 0.12, String(chance));
});
