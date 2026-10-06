import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeAssignment, createAssignment } from '../src/world/assignment.js';
import { createFront, nextEventDay, progressAt, recomputeRate } from '../src/world/front.js';
import { officerRate } from '../src/world/scales.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

function domainOf(assignments, { security = 50, drift = 'NONE', effort = 6 } = {}) {
  const front = createFront(cfg, {
    description: 'Паводок',
    effort,
    beatCount: 2,
    driftBand: drift,
    day: 0,
  });
  for (const assignment of assignments) assignment.frontId = front.id;
  const officer = { id: 'off_m', statId: 'security', processId: null };
  for (const assignment of assignments) assignment.officerId = officer.id;
  return {
    front,
    officer,
    domain: {
      assignments,
      officers: [officer],
      stats: { security },
      fronts: [front],
    },
  };
}

test('сильное поручение быстрее обычного', () => {
  const strong = officerRate(cfg, { stat: 50, efficiency: 'strong', direction: 'forward' });
  const normal = officerRate(cfg, { stat: 50, efficiency: 'normal', direction: 'forward' });
  assert.ok(strong > normal);
  const { front, domain } = domainOf([
    createAssignment({ text: 'Укрепить шлюзы', direction: 'forward', efficiency: 'strong' }),
  ]);
  assert.equal(recomputeRate(cfg, front, domain, 0), strong);
});

test('два поручения на одном фронте складываются', () => {
  const one = officerRate(cfg, { stat: 50, efficiency: 'normal', direction: 'forward' });
  const { front, domain } = domainOf([
    createAssignment({ text: 'Нижние шлюзы', direction: 'forward', efficiency: 'normal' }),
    createAssignment({ text: 'Верхние шлюзы', direction: 'forward', efficiency: 'normal' }),
  ]);
  assert.equal(recomputeRate(cfg, front, domain, 0), one + one);
});

test('встречное поручение останавливает ставку', () => {
  const { front, domain } = domainOf([
    createAssignment({ text: 'Держать воду', direction: 'backward', efficiency: 'normal' }),
  ]);
  const rate = recomputeRate(cfg, front, domain, 0);
  assert.ok(rate < 0);
  assert.equal(nextEventDay(front), null);
});

test('закрытие поручения не съедает уже накопленный прогресс', () => {
  const { front, domain } = domainOf([
    createAssignment({ text: 'Чинить шлюзы', direction: 'forward', efficiency: 'normal' }),
  ]);
  recomputeRate(cfg, front, domain, 0);
  const day = 10;
  const gained = progressAt(front, day);
  assert.ok(gained > 0);
  closeAssignment(domain, domain.assignments[0].id, day, 'done');
  recomputeRate(cfg, front, domain, day);
  assert.equal(front.progress, gained);
  assert.equal(front.ratePerDay, 0);
});
