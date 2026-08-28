import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clockTickIndex,
  gameDateFromTickIndex,
  nextAlignedTickAt,
  applyClockAlignedCalendar,
} from '../src/game/tickClock.js';
import { createWorldFromConfig } from '../src/game/models.js';
import { recordTickCompleted } from '../src/scheduler/ticks.js';

const cfg = { tick: { intervalHours: 2 } };

function at(hour, minute = 0, second = 0, ms = 0) {
  return new Date(2026, 7, 28, hour, minute, second, ms).getTime();
}

test('полночь дня старта — год 1 месяц 1; 02:00 — слот месяца 2', () => {
  assert.equal(clockTickIndex(at(0, 0), cfg), 0);
  assert.equal(clockTickIndex(at(1, 59), cfg), 0);
  assert.equal(clockTickIndex(at(2, 0), cfg), 1);
  assert.equal(clockTickIndex(at(13, 37), cfg), 6);
  assert.equal(gameDateFromTickIndex(0).label, 'Год 1, месяц 1');
  assert.equal(gameDateFromTickIndex(1).label, 'Год 1, месяц 2');
  assert.equal(gameDateFromTickIndex(12).label, 'Год 2, месяц 1');
});

test('следующий тик на границе часов, не через интервал от now', () => {
  assert.equal(new Date(nextAlignedTickAt(at(0, 0), cfg)).getHours(), 2);
  assert.equal(new Date(nextAlignedTickAt(at(0, 30), cfg)).getHours(), 2);
  assert.equal(new Date(nextAlignedTickAt(at(2, 0), cfg)).getHours(), 4);
  assert.equal(new Date(nextAlignedTickAt(at(13, 37), cfg)).getHours(), 14);
  const fromLate = new Date(nextAlignedTickAt(at(23, 30), cfg));
  assert.equal(fromLate.getDate(), 29);
  assert.equal(fromLate.getHours(), 0);
});

test('новый мир и wipe сажают календарь на часы сервера', () => {
  const world = createWorldFromConfig({ world: { id: 't', name: 'Т' }, ...cfg }, { now: at(0, 15) });
  assert.equal(world.tickIndex, 0);
  assert.equal(world.gameDate.label, 'Год 1, месяц 1');
  assert.equal(new Date(world.scheduler.nextTickAt).getHours(), 2);

  const afternoon = {};
  applyClockAlignedCalendar(afternoon, cfg, at(15, 0));
  assert.equal(afternoon.tickIndex, 7);
  assert.equal(afternoon.gameDate.label, 'Год 1, месяц 8');
  assert.equal(new Date(afternoon.scheduler.nextTickAt).getHours(), 16);
});

test('после тика nextTickAt — следующая граница, даже если тик опоздал', async () => {
  let world = { scheduler: {} };
  const storage = {
    async getWorld() {
      return world;
    },
    async saveWorld(w) {
      world = w;
      return w;
    },
  };
  await recordTickCompleted(storage, cfg, at(2, 4));
  const next = new Date(world.scheduler.nextTickAt);
  assert.equal(next.getHours(), 4);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getSeconds(), 0);
});
