import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deedMargin,
  marginToCurveInput,
  BLESS_MARGIN,
  OFF_PORTFOLIO_PENALTY,
  normalizePaceShift,
  pacedDurationBand,
  paceRatio,
  repaceDeed,
  paceLabel,
  workUnits,
  WORK_UNITS,
  GRAVITY_DEPTH_MULTIPLIER,
  depthGain,
  closesPlot,
  remainingWork,
} from '../src/game/deedMath.js';
import { DURATION_BANDS } from '../src/game/bands.js';

test('маржа — стат минус порог сложности', () => {
  assert.equal(deedMargin({ stat: 60, difficulty: 'PLAIN' }), 40);
  assert.equal(deedMargin({ stat: 60, difficulty: 'HARD' }), 15);
  assert.equal(deedMargin({ stat: 60, difficulty: 'SEVERE' }), -10);
  assert.equal(deedMargin({ stat: 60, difficulty: 'TRIVIAL' }), 60);
});

test('благословение и чужой портфель двигают маржу', () => {
  const base = deedMargin({ stat: 50, difficulty: 'HARD' });
  assert.equal(deedMargin({ stat: 50, difficulty: 'HARD', blessed: true }), base + BLESS_MARGIN);
  assert.equal(
    deedMargin({ stat: 50, difficulty: 'HARD', offPortfolio: true }),
    base - OFF_PORTFOLIO_PENALTY,
  );
});

test('невозможное дело не спасает ни стат, ни благословение', () => {
  assert.equal(deedMargin({ stat: 100, difficulty: 'IMPOSSIBLE', blessed: true }), -Infinity);
  assert.equal(marginToCurveInput(-Infinity), 0);
});

test('маржа подставляется в кривую вместо стата', () => {
  assert.equal(marginToCurveInput(0), 50, 'нулевая маржа = середина кривой');
  assert.equal(marginToCurveInput(40), 90);
  assert.equal(marginToCurveInput(-70), 0, 'зажим снизу');
  assert.equal(marginToCurveInput(120), 100, 'зажим сверху');
});

test('темп сдвигается максимум на одну ступень', () => {
  assert.equal(normalizePaceShift(-5), -1);
  assert.equal(normalizePaceShift(3), 1);
  assert.equal(pacedDurationBand('SEASON', -1), 'WEEKS');
  assert.equal(pacedDurationBand('SEASON', 1), 'YEAR');
  assert.equal(pacedDurationBand('SEASON', -3), 'WEEKS', 'просьба сверх ступени не копится');
  assert.equal(paceLabel(-1), 'спешка');
  assert.equal(paceLabel(0), 'обычно');
  assert.equal(paceLabel(1), 'обстоятельно');
});

test('paceRatio ниже единицы при спешке', () => {
  assert.equal(paceRatio({ objectiveDays: 100, scheduledDays: 40 }), 0.4);
  assert.equal(paceRatio({ objectiveDays: 100, scheduledDays: 100 }), 1);
  assert.ok(paceRatio({ objectiveDays: 100, scheduledDays: 200 }) > 1);
});

test('пересчёт срока при смене темпа сохраняет проделанное', () => {
  const res = repaceDeed({ durationBand: 'SEASON', paceShift: 0, elapsedDays: 30 }, -1, () => 0.5);
  assert.equal(res.paceShift, -1);
  assert.equal(res.pacedBand, 'WEEKS');
  assert.ok(res.totalDays > 30, 'срок не может стать меньше уже потраченного');
  assert.ok(res.remainingDays >= 1);
  assert.equal(res.changed, true);
});

test('повторная просьба о том же темпе ничего не меняет', () => {
  const res = repaceDeed({ durationBand: 'WEEKS', paceShift: -1, elapsedDays: 0 }, -1, () => 0.5);
  assert.equal(res.changed, false);
});

test('срок задаёт потолок работы, сложность — крутизну внутри него', () => {
  for (const band of DURATION_BANDS) {
    const row = WORK_UNITS[band];
    const values = ['TRIVIAL', 'PLAIN', 'HARD', 'SEVERE', 'EXTREME'].map((d) => row[d]);
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i] >= values[i - 1], `${band}: работа должна расти со сложностью`);
    }
  }
  // Мгновенное дело не может сделать столько же, сколько годовое.
  assert.ok(WORK_UNITS.INSTANT.EXTREME < WORK_UNITS.YEAR.PLAIN + 0.001);
  assert.ok(WORK_UNITS.YEARS.EXTREME > WORK_UNITS.SEASON.EXTREME);
});

test('невозможное дело не даёт работы', () => {
  assert.equal(workUnits('YEAR', 'IMPOSSIBLE'), 0);
});

test('одно дело делает больше для мелкой беды, чем для разрыва', () => {
  assert.ok(GRAVITY_DEPTH_MULTIPLIER.SITUATION > GRAVITY_DEPTH_MULTIPLIER.CRISIS);
  assert.ok(GRAVITY_DEPTH_MULTIPLIER.CRISIS > GRAVITY_DEPTH_MULTIPLIER.RUPTURE);
  const mid = () => 0.5;
  const situation = depthGain({ durationBand: 'WEEKS', difficulty: 'HARD', gravity: 'SITUATION', rng: mid });
  const rupture = depthGain({ durationBand: 'WEEKS', difficulty: 'HARD', gravity: 'RUPTURE', rng: mid });
  assert.ok(situation > rupture);
});

test('провал не даёт глубины вовсе', () => {
  assert.equal(
    depthGain({ durationBand: 'YEARS', difficulty: 'EXTREME', gravity: 'SITUATION', finish: 'fail' }),
    0,
  );
});

test('крит даёт половину сверху', () => {
  const mid = () => 0.5;
  const ok = depthGain({ durationBand: 'WEEKS', difficulty: 'HARD', gravity: 'CRISIS', finish: 'ok', rng: mid });
  const crit = depthGain({ durationBand: 'WEEKS', difficulty: 'HARD', gravity: 'CRISIS', finish: 'crit', rng: mid });
  assert.ok(Math.abs(crit - ok * 1.5) < 0.02);
});

test('вклад в глубину имеет разброс, но не безумный', () => {
  const args = { durationBand: 'SEASON', difficulty: 'HARD', gravity: 'CRISIS' };
  const low = depthGain({ ...args, rng: () => 0 });
  const mid = depthGain({ ...args, rng: () => 0.5 });
  const high = depthGain({ ...args, rng: () => 1 });
  assert.ok(low < mid && mid < high, 'разброс должен быть');
  assert.ok(Math.abs(low - mid * 0.85) < 0.02);
  assert.ok(Math.abs(high - mid * 1.15) < 0.02);
});

test('разброс отключается нулём', () => {
  const args = { durationBand: 'SEASON', difficulty: 'HARD', gravity: 'CRISIS', spread: 0 };
  assert.equal(depthGain({ ...args, rng: () => 0 }), depthGain({ ...args, rng: () => 1 }));
});

test('вклад считается по исходной полосе, не по ускоренной', () => {
  // Годовое дело, поторопленное до сезона, всё равно вкладывает как годовое:
  // спешка меняет шансы, а не объём работы.
  const mid = () => 0.5;
  const original = depthGain({ durationBand: 'YEAR', difficulty: 'HARD', gravity: 'CRISIS', rng: mid });
  const hurried = depthGain({
    durationBand: pacedDurationBand('YEAR', 0),
    difficulty: 'HARD',
    gravity: 'CRISIS',
    rng: mid,
  });
  assert.equal(original, hurried);
  const wrong = depthGain({ durationBand: 'SEASON', difficulty: 'HARD', gravity: 'CRISIS', rng: mid });
  assert.ok(original > wrong, 'ускоренная полоса дала бы меньше — её брать нельзя');
});

test('closesPlot и remainingWork', () => {
  assert.equal(closesPlot({ depth: 2.5, gain: 0.6, maxDepth: 3 }), true);
  assert.equal(closesPlot({ depth: 2.0, gain: 0.6, maxDepth: 3 }), false);
  assert.equal(remainingWork({ depth: 1.25, maxDepth: 3 }), 1.75);
  assert.equal(remainingWork({ depth: 5, maxDepth: 3 }), 0);
});
