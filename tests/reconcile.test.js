import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEED_VERDICTS,
  THREAT_VERDICTS,
  PAUSE_EXPIRY_DAYS,
  parseDeedVerdict,
  parseThreatVerdict,
  reconcileScope,
  applyDeedVerdict,
  applyThreatVerdict,
  expirePauses,
  reconcileRequest,
} from '../src/game/reconcile.js';
import { createThreat, attachThreat } from '../src/game/threats.js';

function plot(extra = {}) {
  return { id: 'p1', title: 'Беглый мздоимец', gravity: 'CRISIS', threats: [], defenseCount: 0, ...extra };
}

function threat(p, opts = {}) {
  const t = createThreat({ plot: p, text: opts.text || 'сбежит', band: 'SEASON', day: 0, rng: () => 0.5 });
  if (opts.total != null) {
    t.totalDays = opts.total;
    t.dueDay = opts.total;
  }
  attachThreat(p, t);
  return t;
}

function deed(id, extra = {}) {
  return { id, summary: extra.summary || 'арестовать', plotlineId: 'p1', status: 'active', ...extra };
}

test('словари вердиктов различаются по типу', () => {
  assert.deepEqual(DEED_VERDICTS, ['CONTINUE', 'PAUSE', 'CANCEL', 'RETARGET']);
  assert.deepEqual(THREAT_VERDICTS, ['CONTINUE', 'CANCEL', 'DELAY']);
  assert.equal(parseThreatVerdict('PAUSE'), 'CONTINUE', 'угрозу нельзя запаузить');
  assert.equal(parseDeedVerdict('DELAY'), 'CONTINUE', 'дело нельзя отсрочить');
});

test('разбор не нужен, если на нити больше ничего нет', () => {
  const p = plot();
  const scope = reconcileScope({ plot: p, processes: [deed('proc1')], resolvedId: 'proc1' });
  assert.equal(scope.needed, false);
  assert.deepEqual(scope.deeds, []);
});

test('в область разбора попадают чужие дела и живые угрозы', () => {
  const p = plot();
  const t = threat(p);
  const scope = reconcileScope({
    plot: p,
    processes: [deed('proc1'), deed('proc2', { summary: 'казнить' }), deed('proc3', { status: 'paused' })],
    resolvedId: 'proc1',
  });
  assert.equal(scope.needed, true);
  assert.deepEqual(scope.deeds.map((d) => d.id), ['proc2'], 'запаузенное уже не в игре');
  assert.deepEqual(scope.threats.map((x) => x.id), [t.id]);
});

test('дела с другой нити в разбор не попадают', () => {
  const p = plot();
  const scope = reconcileScope({
    plot: p,
    processes: [deed('proc2', { plotlineId: 'other' })],
    resolvedId: 'proc1',
  });
  assert.equal(scope.needed, false);
});

test('казнь состоялась — арест отменяется и освобождает столп', () => {
  const arrest = deed('proc2');
  const res = applyDeedVerdict(arrest, 'CANCEL', { day: 40, reason: 'преступник мёртв' });
  assert.equal(res.freesOfficer, true);
  assert.equal(arrest.status, 'cancelled');
  assert.equal(arrest.cancelledDay, 40);
  assert.equal(arrest.cancelReason, 'преступник мёртв');
});

test('арест состоялся — казнь на паузе и ждёт подтверждения', () => {
  const execution = deed('proc2', { summary: 'казнить' });
  const res = applyDeedVerdict(execution, 'PAUSE', { day: 40, reason: 'он уже под стражей' });
  assert.equal(res.needsConfirmation, true);
  assert.equal(res.freesOfficer, true);
  assert.equal(execution.status, 'paused');
  assert.equal(execution.pausedBy, 'reconcile');
});

test('перенацеливание сохраняет прогресс', () => {
  const d = deed('proc2', { goal: 'поймать в порту', elapsedDays: 12 });
  applyDeedVerdict(d, 'RETARGET', { day: 30, goal: 'искать в верхнем городе' });
  assert.equal(d.status, 'active');
  assert.equal(d.goal, 'искать в верхнем городе');
  assert.equal(d.elapsedDays, 12);
  assert.equal(d.retargetedDay, 30);
});

test('CONTINUE ничего не меняет', () => {
  const d = deed('proc2');
  applyDeedVerdict(d, 'CONTINUE', { day: 5 });
  assert.equal(d.status, 'active');
  assert.equal(d.pausedDay, undefined);
});

test('вердикт по угрозе: отмена и отсрочка', () => {
  const p = plot();
  const t = threat(p, { total: 60 });
  assert.equal(applyThreatVerdict(p, t.id, 'DELAY', { day: 10 }).bonus, 90);
  assert.equal(t.dueDay, 150);
  applyThreatVerdict(p, t.id, 'CANCEL', { day: 20, reason: 'ловить больше некого' });
  assert.equal(t.status, 'cancelled');
  assert.equal(p.defenseCount, 0, 'разбор не считается обороной');
});

test('вердикт по несуществующей угрозе — мягкий отказ', () => {
  const p = plot();
  assert.equal(applyThreatVerdict(p, 'нет такой', 'CANCEL').ok, false);
});

test('брошенная пауза истлевает, но не раньше срока', () => {
  const d = deed('proc2', { status: 'paused', pausedDay: 100, pausedBy: 'reconcile' });
  assert.deepEqual(expirePauses([d], 100 + PAUSE_EXPIRY_DAYS - 1), []);
  assert.equal(d.status, 'paused');
  const dropped = expirePauses([d], 100 + PAUSE_EXPIRY_DAYS);
  assert.deepEqual(dropped.map((x) => x.id), ['proc2']);
  assert.equal(d.status, 'expired');
});

test('пауза от наказа не истлевает — о ней доложено', () => {
  const d = deed('proc2', { status: 'paused', pausedDay: 0, pausedBy: 'order' });
  assert.deepEqual(expirePauses([d], 999), []);
  assert.equal(d.status, 'paused');
});

test('активные дела истлевание не трогает', () => {
  const d = deed('proc2');
  assert.deepEqual(expirePauses([d], 999), []);
  assert.equal(d.status, 'active');
});

test('заявка разбора не отдаёт агенту чисел механики', () => {
  const p = plot({ synopsis: 'мздоимец в бегах' });
  const t = threat(p, { total: 60, text: 'уйдёт с острова' });
  const scope = reconcileScope({
    plot: p,
    processes: [deed('proc2', { summary: 'арестовать', officerName: 'Малуша' })],
    resolvedId: 'proc1',
  });
  const req = reconcileRequest({
    plot: p,
    resolved: { summary: 'казнить', kind: 'deed', finish: 'ok' },
    scope,
    day: 10,
  });
  assert.equal(req.plotTitle, 'Беглый мздоимец');
  assert.deepEqual(req.deeds, [{ id: 'proc2', summary: 'арестовать', goal: '', officer: 'Малуша' }]);
  assert.deepEqual(req.threats, [{ id: t.id, text: 'уйдёт с острова' }]);
  const json = JSON.stringify(req);
  assert.ok(!json.includes('dueDay'));
  assert.ok(!json.includes('totalDays'));
});
