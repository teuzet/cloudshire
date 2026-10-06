import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssignment } from '../src/world/assignment.js';
import {
  createFront,
  nextEventDay,
  progressAt,
  recomputeRate,
  settleProgress,
} from '../src/world/front.js';
import { armFrontSchedule } from '../src/world/frontJobs.js';
import { officerRate } from '../src/world/scales.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

function frontAtRest() {
  return createFront(cfg, {
    description: 'Поиск рецепта',
    effort: 6,
    beatCount: 2,
    driftBand: 'NONE',
    day: 0,
  });
}

test('прогресс растёт линейно и не выше effort', () => {
  const front = frontAtRest();
  front.ratePerDay = 1;
  assert.equal(progressAt(front, 2), 2);
  assert.equal(progressAt(front, 40), 6);
});

test('повторный пересчёт в тот же день не удваивает прогресс', () => {
  const front = frontAtRest();
  front.ratePerDay = 1;
  settleProgress(front, 3);
  const once = front.progress;
  settleProgress(front, 3);
  assert.equal(front.progress, once);
});

test('скорость фронта без дрейфа равна скорости поручения', () => {
  const front = frontAtRest();
  const officer = { id: 'off_m', statId: 'security' };
  const assignment = createAssignment({
    frontId: front.id,
    officerId: officer.id,
    text: 'Обыскать башню',
    direction: 'forward',
    efficiency: 'normal',
  });
  const domain = {
    assignments: [assignment],
    officers: [officer],
    stats: { security: 50 },
  };
  const rate = recomputeRate(cfg, front, domain, 0);
  assert.equal(rate, officerRate(cfg, { stat: 50, efficiency: 'normal', direction: 'forward' }));
});

test('первый порог наступает на двадцатый день', () => {
  const front = frontAtRest();
  const officer = { id: 'off_m', statId: 'security' };
  const domain = {
    assignments: [
      createAssignment({
        frontId: front.id,
        officerId: officer.id,
        text: 'Обыскать башню',
        direction: 'forward',
        efficiency: 'normal',
      }),
    ],
    officers: [officer],
    stats: { security: 50 },
  };
  recomputeRate(cfg, front, domain, 0);
  assert.equal(nextEventDay(front), 20);
});

test('стоящий и откатывающийся фронт не назначает день ставки', () => {
  const front = frontAtRest();
  front.ratePerDay = 0;
  assert.equal(nextEventDay(front), null);
  front.ratePerDay = -0.2;
  assert.equal(nextEventDay(front), null);
});

test('сработавший порог не включается снова после отката', () => {
  const front = frontAtRest();
  front.beatsFired = [0];
  front.progress = 0;
  front.progressDay = 0;
  front.ratePerDay = officerRate(cfg, { stat: 50, efficiency: 'normal', direction: 'forward' });
  assert.equal(nextEventDay(front), 40);
});

test('дневной ход ставит задание на живой фронт', () => {
  const front = frontAtRest();
  const officer = { id: 'off_m', statId: 'security' };
  const domain = {
    id: 'dom',
    fronts: [front],
    assignments: [
      createAssignment({
        frontId: front.id,
        officerId: officer.id,
        text: 'Искать',
        direction: 'forward',
        efficiency: 'normal',
      }),
    ],
    officers: [officer],
    stats: { security: 50 },
  };
  const world = { jobs: [] };
  armFrontSchedule(cfg, domain, world, 0);
  assert.equal(world.jobs.filter((job) => job.payload?.frontId === front.id && job.state === 'pending').length, 1);
});
