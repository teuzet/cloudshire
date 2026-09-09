import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DURATION_BANDS,
  DURATION_SPEC,
  DIFFICULTY_BANDS,
  THREAT_BANDS,
  normalizeDurationBand,
  shiftDurationBand,
  rollDurationDays,
  durationBandOfDays,
  normalizeDifficultyBand,
  requiredStat,
  isImpossible,
  normalizeThreatBand,
  shiftThreatBand,
  rollThreatDays,
  pickThreatBands,
  remainingBand,
  deedBeatsThreat,
  THREAT_KNOWN_CHANCE,
} from '../src/game/bands.js';

function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** Детерминированный генератор — тесты на распределения не должны мигать. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('полосы срока идут от мгновения к годам без разрывов', () => {
  let prev = 0;
  for (const band of DURATION_BANDS) {
    const spec = DURATION_SPEC[band];
    assert.ok(spec.min >= prev, `${band}: min ${spec.min} < предыдущего max ${prev}`);
    assert.ok(spec.max > spec.min, `${band}: пустая полоса`);
    prev = spec.min;
  }
});

test('мусор в полосе срока падает на дефолт', () => {
  assert.equal(normalizeDurationBand('weeks'), 'WEEKS');
  assert.equal(normalizeDurationBand('  season '), 'SEASON');
  assert.equal(normalizeDurationBand('лет'), 'WEEKS');
  assert.equal(normalizeDurationBand(null, 'DAYS'), 'DAYS');
});

test('сдвиг полосы зажимается по краям', () => {
  assert.equal(shiftDurationBand('WEEKS', 1), 'SEASON');
  assert.equal(shiftDurationBand('WEEKS', -1), 'DAYS');
  assert.equal(shiftDurationBand('INSTANT', -3), 'INSTANT');
  assert.equal(shiftDurationBand('YEARS', 5), 'YEARS');
});

test('жребий срока не выходит за полосу', () => {
  for (const band of DURATION_BANDS) {
    const spec = DURATION_SPEC[band];
    assert.equal(rollDurationDays(band, () => 0), spec.min);
    assert.equal(rollDurationDays(band, () => 1), spec.max);
    const mid = rollDurationDays(band, () => 0.5);
    assert.ok(mid >= spec.min && mid <= spec.max);
  }
});

test('обратный перевод дней в полосу', () => {
  assert.equal(durationBandOfDays(2), 'INSTANT');
  assert.equal(durationBandOfDays(10), 'DAYS');
  assert.equal(durationBandOfDays(45), 'WEEKS');
  assert.equal(durationBandOfDays(100), 'SEASON');
  assert.equal(durationBandOfDays(300), 'YEAR');
  assert.equal(durationBandOfDays(5000), 'YEARS');
});

test('сложность требует всё больше стата', () => {
  const required = DIFFICULTY_BANDS.filter((b) => b !== 'IMPOSSIBLE').map(requiredStat);
  for (let i = 1; i < required.length; i += 1) {
    assert.ok(required[i] > required[i - 1], 'порог должен расти');
  }
  assert.equal(requiredStat('TRIVIAL'), 0);
  assert.equal(requiredStat('EXTREME'), 95);
});

test('невозможное — флаг, а не порог', () => {
  assert.ok(isImpossible('IMPOSSIBLE'));
  assert.ok(!isImpossible('EXTREME'));
  assert.equal(normalizeDifficultyBand('impossible'), 'IMPOSSIBLE');
  assert.equal(requiredStat('IMPOSSIBLE'), Infinity);
});

test('полосы счётчика угрозы', () => {
  assert.equal(normalizeThreatBand('days'), 'DAYS');
  assert.equal(normalizeThreatBand('YEARS'), 'SEASON', 'YEARS у угроз нет');
  assert.equal(shiftThreatBand('DAYS', 1), 'WEEKS');
  assert.equal(shiftThreatBand('YEAR', 2), 'YEAR');
  for (const band of THREAT_BANDS) {
    const days = rollThreatDays(band, () => 0.5);
    assert.ok(days > 0);
  }
});

test('быстрые угрозы почти всегда видимы, медленные — редко', () => {
  assert.ok(THREAT_KNOWN_CHANCE.DAYS > THREAT_KNOWN_CHANCE.SEASON);
  assert.ok(THREAT_KNOWN_CHANCE.SEASON > THREAT_KNOWN_CHANCE.YEAR);
});

test('слоты угроз обычно разнородны, но совпасть могут', () => {
  // Без штрафа за повтор две одинаковые полосы выпадали бы в 36% случаев
  // (0.4² + 0.4² + 0.2²). Штраф должен заметно это проредить, не запретив совсем.
  const rng = lcg(12345);
  let repeats = 0;
  const rounds = 4000;
  for (let i = 0; i < rounds; i += 1) {
    const [a, b] = pickThreatBands(2, rng);
    assert.ok(THREAT_BANDS.includes(a) && THREAT_BANDS.includes(b));
    if (a === b) repeats += 1;
  }
  const rate = repeats / rounds;
  assert.ok(rate < 0.26, `повторов слишком много: ${rate}`);
  assert.ok(rate > 0.05, `повторы запрещены полностью: ${rate}`);
});

test('первая выпавшая полоса теряет вес', () => {
  const bands = pickThreatBands(2, seq([0.9, 0.9]));
  assert.equal(bands[0], 'YEAR');
  assert.notEqual(bands[1], 'YEAR', 'подавленный YEAR не должен выпасть снова при том же жребии');
});

test('остаток срока переводится в полосу для речи', () => {
  assert.equal(remainingBand(1), 'INSTANT');
  assert.equal(remainingBand(10), 'DAYS');
  assert.equal(remainingBand(50), 'WEEKS');
  assert.equal(remainingBand(120), 'SEASON');
  assert.equal(remainingBand(300), 'YEAR');
});

test('жрец видит, что дело не успевает к сроку угрозы', () => {
  const late = deedBeatsThreat(120, 10);
  assert.equal(late.inTime, false);
  assert.equal(late.deedBand, 'SEASON');
  assert.equal(late.threatBand, 'DAYS');

  const ok = deedBeatsThreat(8, 40);
  assert.equal(ok.inTime, true);
});
