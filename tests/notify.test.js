import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFY_TRIGGERS,
  PROTECTED_TRIGGERS,
  MIN_GAP_BY_INTENSITY,
  parseIntensity,
  defaultNotify,
  normalizeNotify,
  notifySettings,
  minGapDays,
  applyPriestNotifyChange,
  shouldPush,
  markPushed,
} from '../src/game/notify.js';

function domain() {
  return { id: 'd1', state: {} };
}

function at(hour) {
  const d = new Date(2026, 0, 1, hour, 0, 0);
  return d;
}

test('интенсивность парсится, мусор падает на важное', () => {
  assert.equal(parseIntensity('всё'), 'всё');
  assert.equal(parseIntensity('СВОДКА'), 'сводка');
  assert.equal(parseIntensity('шум'), 'важное');
});

test('зазор растёт по мере затихания', () => {
  assert.ok(MIN_GAP_BY_INTENSITY['всё'] < MIN_GAP_BY_INTENSITY['важное']);
  assert.ok(MIN_GAP_BY_INTENSITY['важное'] < MIN_GAP_BY_INTENSITY['сводка']);
  assert.equal(minGapDays({ intensity: 'сводка' }), 30, 'сводка — раз в игровой месяц');
});

test('дефолт включает важное и глушит мелочь', () => {
  const n = defaultNotify();
  assert.equal(n.intensity, 'важное');
  assert.equal(n.triggers.threatFired, true);
  assert.equal(n.triggers.newStory, true);
  assert.equal(n.triggers.deedDone, false, 'успех дела — не повод для пуша по умолчанию');
  assert.equal(n.triggers.errandDone, false);
});

test('интенсивность задаёт набор триггеров, но явные значения сильнее', () => {
  const quiet = normalizeNotify({ intensity: 'сводка' });
  assert.equal(quiet.triggers.newStory, false);
  assert.equal(quiet.triggers.plotClosed, true);
  const tuned = normalizeNotify({ intensity: 'сводка', triggers: { newStory: true } });
  assert.equal(tuned.triggers.newStory, true);
});

test('сработавшую беду нельзя выключить никакой настройкой', () => {
  const n = normalizeNotify({ intensity: 'сводка', triggers: { threatFired: false } });
  assert.equal(n.triggers.threatFired, true);
  assert.deepEqual(PROTECTED_TRIGGERS, ['threatFired']);
});

test('нормализация чинит битые тихие часы', () => {
  const n = normalizeNotify({ quiet: { fromHour: 26, toHour: 'ночь', tz: 'Europe/Berlin' } });
  assert.equal(n.quiet.fromHour, null);
  assert.equal(n.quiet.toHour, null);
  assert.equal(n.quiet.tz, 'Europe/Berlin');
});

test('настройки садятся на домен и переживают повторную нормализацию', () => {
  const d = domain();
  const first = notifySettings(d);
  first.triggers.deedDone = true;
  const second = notifySettings(d);
  assert.equal(second.triggers.deedDone, true);
  assert.equal(Object.keys(second.triggers).length, NOTIFY_TRIGGERS.length);
});

test('жрец может включить подробности и приглушить лишнее', () => {
  const d = domain();
  applyPriestNotifyChange(d, { triggers: { deedDone: true, newStory: false }, style: { detail: 'коротко' } });
  const n = notifySettings(d);
  assert.equal(n.triggers.deedDone, true);
  assert.equal(n.triggers.newStory, false);
  assert.equal(n.style.detail, 'коротко');
});

test('жрец не может увести игрока в тишину', () => {
  const d = domain();
  applyPriestNotifyChange(d, { intensity: 'сводка', triggers: { threatFired: false } });
  const n = notifySettings(d);
  assert.equal(n.intensity, 'важное', 'ниже важного жрец не опускает');
  assert.equal(n.triggers.threatFired, true);
});

test('жрец не трогает тихие часы', () => {
  const d = domain();
  d.state.notify = normalizeNotify({ quiet: { fromHour: 23, toHour: 8, tz: 'Europe/Berlin' } });
  applyPriestNotifyChange(d, { quiet: { fromHour: 0, toHour: 0 } });
  assert.equal(notifySettings(d).quiet.fromHour, 23);
});

test('выключенный триггер молчит', () => {
  const d = domain();
  const res = shouldPush(d, { trigger: 'deedDone', day: 100 });
  assert.equal(res.push, false);
  assert.equal(res.reason, 'trigger_off');
});

test('в тихие часы через полночь не будим', () => {
  const d = domain();
  d.state.notify = normalizeNotify({ quiet: { fromHour: 23, toHour: 8 } });
  assert.equal(shouldPush(d, { trigger: 'threatFired', day: 100, now: at(2) }).reason, 'quiet_hours');
  assert.equal(shouldPush(d, { trigger: 'threatFired', day: 100, now: at(23) }).reason, 'quiet_hours');
  assert.equal(shouldPush(d, { trigger: 'threatFired', day: 100, now: at(12) }).push, true);
});

test('зазор разрежает поток пушей', () => {
  const d = domain();
  markPushed(d, 100);
  assert.equal(shouldPush(d, { trigger: 'newStory', day: 104, now: at(12) }).reason, 'min_gap');
  assert.equal(shouldPush(d, { trigger: 'newStory', day: 108, now: at(12) }).push, true);
});

test('force пробивает и зазор, и тихие часы', () => {
  const d = domain();
  d.state.notify = normalizeNotify({ quiet: { fromHour: 0, toHour: 23 } });
  markPushed(d, 100);
  assert.equal(shouldPush(d, { trigger: 'deedDone', day: 100, now: at(3), force: true }).push, true);
});

test('интенсивность «всё» пропускает почти сразу', () => {
  const d = domain();
  d.state.notify = normalizeNotify({ intensity: 'всё' });
  markPushed(d, 100);
  assert.equal(shouldPush(d, { trigger: 'deedDone', day: 101, now: at(12) }).reason, 'min_gap');
  assert.equal(shouldPush(d, { trigger: 'deedDone', day: 102, now: at(12) }).push, true);
});
