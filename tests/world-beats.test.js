import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssignment } from '../src/world/assignment.js';
import { resolveFrontBeat } from '../src/world/beats.js';
import { createFront } from '../src/world/front.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

function readyFront(extra = {}) {
  const front = createFront(cfg, {
    description: 'Паводок ломает город',
    effort: 6,
    beatCount: 2,
    driftBand: 'NONE',
    day: 0,
    events: [
      { id: 'gates-lower', description: 'Вырвало шлюзы в нижнем квартале.' },
    ],
    ...extra,
  });
  front.progress = 2;
  front.progressDay = 0;
  front.ratePerDay = 0;
  return front;
}

test('порог срабатывает один раз', async () => {
  const front = readyFront();
  const domain = { fronts: [front], assignments: [], officers: [], stats: {}, lore: [] };
  const first = await resolveFrontBeat({ config: cfg, domain, front, day: 0, pick: async () => ({ eventId: 'gates-lower' }) });
  const second = await resolveFrontBeat({ config: cfg, domain, front, day: 0, pick: async () => ({ eventId: 'gates-lower' }) });
  assert.equal(first.skipped, undefined);
  assert.deepEqual(front.beatsFired, [0]);
  assert.equal(second.skipped, 'no_beat');
});

test('заблокированное событие пишется без изменения статов', async () => {
  const front = readyFront();
  front.events[0].status = 'blocked';
  const domain = {
    fronts: [front],
    assignments: [],
    officers: [],
    stats: { prosperity: 40, security: 40, knowledge: 40, influence: 40 },
    statLedger: { prosperity: 0, influence: 0, knowledge: 0, security: 0 },
    lore: [],
  };
  const before = { ...domain.stats };
  const result = await resolveFrontBeat({
    config: cfg,
    domain,
    front,
    day: 0,
    pick: async () => ({ eventId: 'gates-lower' }),
  });
  assert.equal(result.averted, true);
  assert.equal(domain.lore.length, 1);
  assert.match(domain.lore[0].text, /Подготовка/);
  assert.deepEqual(domain.stats, before);
});

test('раскрытая улика даёт ровно одну хронику', async () => {
  const front = createFront(cfg, {
    description: 'Происхождение руин',
    effort: 6,
    beatCount: 1,
    clues: [{ id: 'inscriptions', fact: 'Надписи описывают поворот острова.', alignment: 'языки' }],
    day: 0,
  });
  front.progress = 3;
  front.progressDay = 0;
  const domain = { fronts: [front], assignments: [], officers: [], stats: {}, lore: [] };
  const result = await resolveFrontBeat({
    config: cfg,
    domain,
    front,
    day: 0,
    pick: async () => ({ clueId: 'inscriptions' }),
  });
  assert.equal(result.clue.status, 'revealed');
  assert.equal(domain.lore.length, 1);
  assert.match(domain.lore[0].text, /поворот/);
  assert.equal(createAssignment({ text: 'x' }).status, 'active');
});
