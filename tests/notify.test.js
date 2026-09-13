import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFY_TRIGGERS,
  PROTECTED_TRIGGERS,
  MIN_GAP_BY_INTENSITY,
  PUSH_THROTTLE_ON,
  parseIntensity,
  defaultNotify,
  normalizeNotify,
  notifySettings,
  minGapDays,
  applyPriestNotifyChange,
  pushVerdict,
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
  assert.equal(n.triggers.deedDone, true, 'исход дела покровитель завёл сам — молчать нельзя');
  assert.equal(n.triggers.errandDone, false, 'мелкое поручение по умолчанию глушим');
});

test('интенсивность задаёт набор триггеров, но явные значения сильнее', () => {
  const quiet = normalizeNotify({ intensity: 'сводка' });
  assert.equal(quiet.triggers.newStory, false);
  assert.equal(quiet.triggers.plotClosed, true);
  const tuned = normalizeNotify({ intensity: 'сводка', triggers: { newStory: true } });
  assert.equal(tuned.triggers.newStory, true);
});

test('сработавшую беду и удар соседа нельзя выключить никакой настройкой', () => {
  const n = normalizeNotify({ intensity: 'сводка', triggers: { threatFired: false, confluxHostile: false } });
  assert.equal(n.triggers.threatFired, true);
  assert.equal(n.triggers.confluxHostile, true);
  assert.deepEqual(PROTECTED_TRIGGERS, ['threatFired', 'confluxHostile']);
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

test('смена громкости накатывает пресет, а не только меняет подпись', () => {
  const d = domain();
  assert.equal(notifySettings(d).triggers.errandDone, false, 'мелочь по умолчанию молчит');

  applyPriestNotifyChange(d, { intensity: 'всё' });
  const loud = notifySettings(d);
  assert.equal(loud.intensity, 'всё');
  assert.equal(loud.triggers.errandDone, true, '«пиши мне про всё» обязано включить мелочь');

  applyPriestNotifyChange(d, { intensity: 'важное' });
  const back = notifySettings(d);
  assert.equal(back.intensity, 'важное');
  assert.equal(back.triggers.errandDone, false, 'обратно — снова молчит');
  assert.equal(back.triggers.deedDone, true, 'важное не выключает исход своего дела');
});

test('точечная правка в том же вызове сильнее пресета громкости', () => {
  const d = domain();
  applyPriestNotifyChange(d, { intensity: 'всё', triggers: { errandDone: false } });
  const n = notifySettings(d);
  assert.equal(n.intensity, 'всё');
  assert.equal(n.triggers.errandDone, false, 'явная просьба важнее пресета');
  assert.equal(n.triggers.newStory, true);
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

test('выключенный триггер даёт вердикт trigger_off', () => {
  const d = domain();
  assert.equal(pushVerdict(d, { trigger: 'errandDone', day: 100 }), 'trigger_off');
});

test('в тихие часы через полночь вердикт quiet_hours', () => {
  const d = domain();
  d.state.notify = normalizeNotify({ quiet: { fromHour: 23, toHour: 8 } });
  assert.equal(pushVerdict(d, { trigger: 'threatFired', day: 100, now: at(2) }), 'quiet_hours');
  assert.equal(pushVerdict(d, { trigger: 'threatFired', day: 100, now: at(23) }), 'quiet_hours');
  assert.equal(pushVerdict(d, { trigger: 'threatFired', day: 100, now: at(12) }), 'ok');
});

test('зазор виден в вердикте', () => {
  const d = domain();
  markPushed(d, 100);
  assert.equal(pushVerdict(d, { trigger: 'newStory', day: 104, now: at(12) }), 'min_gap');
  assert.equal(pushVerdict(d, { trigger: 'newStory', day: 108, now: at(12) }), 'ok');
});

test('интенсивность «всё» сокращает зазор', () => {
  const d = domain();
  d.state.notify = normalizeNotify({ intensity: 'всё' });
  markPushed(d, 100);
  assert.equal(pushVerdict(d, { trigger: 'deedDone', day: 101, now: at(12) }), 'min_gap');
  assert.equal(pushVerdict(d, { trigger: 'deedDone', day: 102, now: at(12) }), 'ok');
});

test('снятая глушилка пропускает всё, но называет съеденный повод', () => {
  assert.equal(PUSH_THROTTLE_ON, false, 'сейчас мерим поток, а не режем его');
  const d = domain();
  markPushed(d, 100);

  const gap = shouldPush(d, { trigger: 'newStory', day: 101, now: at(12) });
  assert.equal(gap.push, true);
  assert.equal(gap.wouldMute, 'min_gap');

  const off = shouldPush(d, { trigger: 'errandDone', day: 200, now: at(12) });
  assert.equal(off.push, true);
  assert.equal(off.wouldMute, 'trigger_off');

  const clean = shouldPush(d, { trigger: 'newStory', day: 200, now: at(12) });
  assert.equal(clean.push, true);
  assert.equal(clean.wouldMute, null, 'без причины глушить wouldMute пустой');

  const night = domain();
  night.state.notify = normalizeNotify({ quiet: { fromHour: 23, toHour: 8 } });
  const quiet = shouldPush(night, { trigger: 'threatFired', day: 200, now: at(3) });
  assert.equal(quiet.push, true, 'даже тихие часы больше не держат');
  assert.equal(quiet.wouldMute, 'quiet_hours');
});

test('force пробивает всё и ничего не помечает', () => {
  const d = domain();
  d.state.notify = normalizeNotify({ quiet: { fromHour: 0, toHour: 23 } });
  markPushed(d, 100);
  const res = shouldPush(d, { trigger: 'deedDone', day: 100, now: at(3), force: true });
  assert.equal(res.push, true);
  assert.equal(res.wouldMute, null);
});
