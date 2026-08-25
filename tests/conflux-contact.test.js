import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollContactKind,
  CONTACT_KINDS,
  contactControlRule,
  formatContactForPrompt,
} from '../src/game/conflux.js';

const WEIGHTS = {
  bridge: 4,
  gap_jump: 3,
  gorge: 3,
  wagon_pass: 10,
  causeway: 60,
  landmass: 20,
};

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('у каждого вида прохода сказано, можно ли его закрыть', () => {
  for (const [kind, meta] of Object.entries(CONTACT_KINDS)) {
    assert.ok(String(meta.control || '').length > 40, `${kind} без control`);
  }
  const land = contactControlRule({ kind: 'landmass' });
  assert.match(land, /нельзя/i);
  assert.match(land, /запер/i);
  const bridge = contactControlRule({ kind: 'bridge' });
  assert.match(bridge, /запереть/i);
  const prompt = formatContactForPrompt({
    kind: 'landmass',
    description: 'Края лежат вплотную, как одна земля.',
  });
  assert.match(prompt, /сопряжен/i);
  assert.match(prompt, /Контроль прохода/);
  assert.match(prompt, /нельзя/i);
  const already = formatContactForPrompt({
    kind: 'landmass',
    description: `Края вплотную. ${CONTACT_KINDS.landmass.control}`,
  });
  assert.equal((already.match(/Закрыть, запереть/g) || []).length, 1);
});

test('веса стыка: 10% узкий, 10% обозный, 60% широкий, 20% берег в берег', () => {
  const rng = lcg(7);
  const n = 20000;
  const counts = Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, 0]));
  for (let i = 0; i < n; i += 1) {
    const kind = rollContactKind(WEIGHTS, rng);
    assert.ok(CONTACT_KINDS[kind], kind);
    counts[kind] += 1;
  }
  const p = (k) => counts[k] / n;
  const narrow = p('bridge') + p('gap_jump') + p('gorge');
  assert.ok(Math.abs(narrow - 0.1) < 0.015, `narrow=${narrow}`);
  assert.ok(Math.abs(p('wagon_pass') - 0.1) < 0.015, `wagon=${p('wagon_pass')}`);
  assert.ok(Math.abs(p('causeway') - 0.6) < 0.02, `causeway=${p('causeway')}`);
  assert.ok(Math.abs(p('landmass') - 0.2) < 0.015, `landmass=${p('landmass')}`);
});
