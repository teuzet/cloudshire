import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stageScale,
  firedThreatScale,
  isFinalStage,
  neutralEndingDue,
  stageThreatCount,
  stagePoolRequest,
  createThreat,
  attachThreat,
  liveThreats,
  fireThreat,
  avertThreats,
  livesLeft,
  formatKnownUnknown,
} from '../src/game/threats.js';
import { pressureAt, resetPressure, shiftPressure, fillDay } from '../src/game/pressure.js';

function plot(extra = {}) {
  return {
    id: 'p1',
    type: 'story',
    gravity: 'CRISIS',
    urgency: 'MEDIUM',
    depth: 0,
    maxDepth: 3,
    failCount: 0,
    maxFails: 2,
    stage: 0,
    threats: [],
    hiddenPremises: [],
    ...extra,
  };
}

test('масштаб стадии идёт по лестнице, последняя стадия — масштаб истории', () => {
  assert.equal(stageScale(plot({ gravity: 'CRISIS', maxFails: 2, failCount: 0 })), 'SITUATION');
  assert.equal(stageScale(plot({ gravity: 'CRISIS', maxFails: 2, failCount: 1, stage: 1 })), 'EPISODE');
  assert.equal(isFinalStage(plot({ gravity: 'CRISIS', maxFails: 2, failCount: 2 })), true);
  assert.equal(stageScale(plot({ gravity: 'CRISIS', maxFails: 2, failCount: 2 })), 'CRISIS');
  assert.equal(stageScale(plot({ gravity: 'SITUATION', maxFails: 0 })), 'SITUATION');
  assert.equal(isFinalStage(plot({ gravity: 'SITUATION', maxFails: 0 })), true);
});

test('масштаб сработавшей беды не сдвигается вместе со стадией нити', () => {
  const p = plot({ gravity: 'CRISIS', stage: 1 });
  assert.equal(firedThreatScale(p, { stage: 0, final: false }), 'SITUATION');
  assert.equal(firedThreatScale(p, { stage: 1, final: false }), 'EPISODE');
  assert.equal(firedThreatScale(p, { stage: 0, final: true }), 'CRISIS');
});

test('число бед стадии берётся из диапазона тяжести истории', () => {
  const low = stageThreatCount(plot({ gravity: 'SITUATION' }), null, () => 0);
  const high = stageThreatCount(plot({ gravity: 'SITUATION' }), null, () => 0.999);
  assert.equal(low, 1);
  assert.equal(high, 3);
});

test('пул заказывается, пока на стадии нет живых бед', () => {
  const p = plot();
  const req = stagePoolRequest(p, { rng: () => 0 });
  assert.equal(req.scale, 'SITUATION');
  assert.equal(req.final, false);
  assert.ok(req.count >= 7);
  attachThreat(p, createThreat(p, { text: 'опора сядет', day: 1 }));
  assert.equal(stagePoolRequest(p, { rng: () => 0 }), null);
});

test('непоследняя беда тратит жизнь и снимает остальные', () => {
  const p = plot();
  const a = attachThreat(p, createThreat(p, { text: 'опора сядет' }));
  const b = attachThreat(p, createThreat(p, { text: 'лестница уйдёт' }));
  const res = fireThreat(p, a, { day: 10 });
  assert.equal(res.closes, false);
  assert.equal(p.failCount, 1);
  assert.equal(p.stage, 1);
  assert.equal(a.status, 'fired');
  assert.equal(b.status, 'cancelled');
  assert.equal(livesLeft(p), 1);
  assert.equal(liveThreats(p).length, 0);
});

test('последняя беда закрывает плохо, если глубины мало, и нейтрально, если хватает', () => {
  const bad = plot({ failCount: 2, stage: 2, depth: 0.4, maxDepth: 3 });
  const threat = attachThreat(bad, createThreat(bad, { text: 'крыло падает', final: true }));
  const badRes = fireThreat(bad, threat, { day: 4 });
  assert.equal(badRes.closes, true);
  assert.equal(badRes.endingKind, 'BAD_ENDING');

  const ok = plot({ failCount: 2, stage: 2, depth: 1.6, maxDepth: 3 });
  const other = attachThreat(ok, createThreat(ok, { text: 'крыло падает', final: true }));
  const okRes = fireThreat(ok, other, { day: 4 });
  assert.equal(okRes.endingKind, 'NEUTRAL_ENDING');
  assert.equal(neutralEndingDue(ok, null), true);
  assert.equal(neutralEndingDue(bad, null), false);
  assert.equal(neutralEndingDue(plot(), null), false);
});

test('снятые беды уходят из живых', () => {
  const p = plot();
  const a = attachThreat(p, createThreat(p, { text: 'опора сядет' }));
  const b = attachThreat(p, createThreat(p, { text: 'лестница уйдёт' }));
  const gone = avertThreats(p, [a.id, b.id, 'нет'], { day: 3, by: 'proc' });
  assert.equal(gone.length, 2);
  assert.equal(liveThreats(p).length, 0);
});

test('шкала растёт по дням и сдвиг через ста отмечает заполнение', () => {
  const p = plot();
  resetPressure(p, 0, null, () => 0);
  p.pressure.fillDays = 100;
  assert.equal(pressureAt(p, 50), 50);
  assert.equal(fillDay(p), 100);
  const shift = shiftPressure(p, 80, 30);
  assert.equal(shift.filled, true);
  assert.equal(pressureAt(p, 80), 100);
});

test('известное и неизвестное не называют срок', () => {
  const text = formatKnownUnknown(plot());
  assert.match(text, /ИЗВЕСТНОЕ/);
  assert.match(text, /НЕИЗВЕСТНОЕ/);
  assert.doesNotMatch(text, /дней/);
});
