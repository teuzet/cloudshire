import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEVERITY_BANDS,
  GRAVITY_THREAT_SLOTS,
  livesLeft,
  severityForLives,
  severityForPlot,
  threatSlots,
  targetThreatCount,
  createThreat,
  attachThreat,
  liveThreats,
  liveHarmThreats,
  liveResolutions,
  findThreat,
  remainingDays,
  nearestThreat,
  surfaceOverdueThreats,
  revealThreat,
  dreadFlag,
  knownThreatsForSpeech,
  deferSurvivors,
  fireThreat,
  defendThreat,
  cancelThreat,
  delayThreat,
  hastenThreat,
  reprieveThreat,
  defenseSlowdown,
  resolutionChance,
  nextObligationRequest,
  replenishThreats,
  normalizePlotThreats,
  MAX_DEFENSE_SLOWDOWN,
} from '../src/game/threats.js';

function plot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    title: 'Трещина в опорном столбе',
    gravity: 'CRISIS',
    depth: 0,
    maxDepth: 3,
    failCount: 0,
    threats: [],
    defenseCount: 0,
    endings: [{ id: 'e1', kind: 'BAD_ENDING', text: 'Северное крыло рушится вместе с людьми' }],
    ...extra,
  };
}

function threat(p, { band = 'SEASON', day = 0, known = true, outcome = 'harm', total = null } = {}) {
  const t = createThreat({ plot: p, text: 'обвал', band, day, known, outcome, rng: () => 0.5 });
  if (total != null) {
    t.totalDays = total;
    t.dueDay = day + total;
  }
  attachThreat(p, t);
  return t;
}

// ─────────────────────────── жизни и тяжесть ───────────────────────────

test('жизни считаются от gravity, если maxFails не задан', () => {
  assert.equal(livesLeft(plot({ gravity: 'SITUATION' })), 0);
  assert.equal(livesLeft(plot({ gravity: 'EPISODE' })), 1);
  assert.equal(livesLeft(plot({ gravity: 'CRISIS' })), 2);
  assert.equal(livesLeft(plot({ gravity: 'RUPTURE' })), 3);
  assert.equal(livesLeft(plot({ gravity: 'CRISIS', failCount: 2 })), 0);
});

test('полоса тяжести растёт по мере убывания жизней', () => {
  assert.equal(severityForLives(5), 'ТРЕВОГА');
  assert.equal(severityForLives(3), 'ТРЕВОГА');
  assert.equal(severityForLives(2), 'УЩЕРБ');
  assert.equal(severityForLives(1), 'УТРАТА');
  assert.equal(severityForLives(0), 'КАТАСТРОФА');
  assert.equal(SEVERITY_BANDS.indexOf(severityForLives(0)), SEVERITY_BANDS.length - 1);
});

test('у кризиса на первом шаге угроза не может быть катастрофой', () => {
  assert.equal(severityForPlot(plot({ gravity: 'CRISIS' })), 'УЩЕРБ');
  assert.equal(severityForPlot(plot({ gravity: 'CRISIS', failCount: 1 })), 'УТРАТА');
  assert.equal(severityForPlot(plot({ gravity: 'CRISIS', failCount: 2 })), 'КАТАСТРОФА');
});

test('ситуация без жизней катастрофична с первой же угрозы', () => {
  assert.equal(severityForPlot(plot({ gravity: 'SITUATION' })), 'КАТАСТРОФА');
});

test('число слотов растёт с тяжестью истории', () => {
  assert.equal(threatSlots(plot({ gravity: 'SITUATION' })), 1);
  assert.equal(threatSlots(plot({ gravity: 'CRISIS' })), 2);
  assert.equal(threatSlots(plot({ gravity: 'RUPTURE' })), 3);
  assert.deepEqual(Object.keys(GRAVITY_THREAT_SLOTS).length, 4);
});

test('одновременных угроз не больше остатка жизней, но всегда хотя бы одна', () => {
  assert.equal(targetThreatCount(plot({ gravity: 'RUPTURE' })), 3);
  assert.equal(targetThreatCount(plot({ gravity: 'RUPTURE', failCount: 2 })), 1);
  assert.equal(targetThreatCount(plot({ gravity: 'SITUATION' })), 1, 'ноль жизней — не ноль угроз');
  assert.equal(targetThreatCount(plot({ gravity: 'CRISIS', failCount: 5 })), 1);
});

// ──────────────────────────── создание ────────────────────────────

test('угроза получает срок внутри полосы и запоминает исходную длительность', () => {
  const p = plot();
  const t = createThreat({ plot: p, band: 'WEEKS', day: 100, rng: () => 0 });
  assert.equal(t.band, 'WEEKS');
  assert.equal(t.totalDays, 25);
  assert.equal(t.dueDay, 125);
  assert.equal(t.createdDay, 100);
  assert.equal(t.status, 'live');
  assert.equal(t.outcome, 'harm');
});

test('полоса тяжести проставляется при рождении по текущему остатку жизней', () => {
  const p = plot({ gravity: 'CRISIS', failCount: 1 });
  const t = createThreat({ plot: p, band: 'WEEKS', rng: () => 0.5 });
  assert.equal(t.severity, 'УТРАТА');
});

test('замедление от защит сдвигает полосу при рождении', () => {
  const p = plot();
  const t = createThreat({ plot: p, band: 'DAYS', slowdown: 2, rng: () => 0.5 });
  assert.equal(t.band, 'SEASON', 'DAYS + 2 ступени = SEASON');
});

test('видимость бросается по полосе, но может быть задана явно', () => {
  const p = plot();
  const fast = createThreat({ plot: p, band: 'DAYS', rng: () => 0.5 });
  assert.equal(fast.known, true, 'быстрая угроза почти всегда видна');
  const slow = createThreat({ plot: p, band: 'YEAR', rng: () => 0.5 });
  assert.equal(slow.known, false, 'медленная при том же жребии — нет');
  assert.equal(createThreat({ plot: p, band: 'YEAR', known: true, rng: () => 0.5 }).known, true);
});

test('разрешение всегда видимо — иначе гонки не будет', () => {
  const p = plot();
  const t = createThreat({ plot: p, band: 'YEAR', outcome: 'neutral', known: false, rng: () => 0.99 });
  assert.equal(t.outcome, 'neutral');
  assert.equal(t.known, true);
  assert.equal(t.severity, null);
});

// ──────────────────────────── видимость ────────────────────────────

test('неизвестная угроза всплывает сама на последней четверти срока', () => {
  const p = plot();
  const t = threat(p, { band: 'SEASON', day: 0, known: false, total: 100 });
  assert.deepEqual(surfaceOverdueThreats(p, 70), []);
  assert.equal(t.known, false);
  const surfaced = surfaceOverdueThreats(p, 76);
  assert.deepEqual(surfaced.map((x) => x.id), [t.id]);
  assert.equal(t.known, true);
  assert.equal(t.surfacedDay, 76);
});

test('уже открытая угроза не всплывает второй раз', () => {
  const p = plot();
  threat(p, { band: 'SEASON', day: 0, known: true, total: 100 });
  assert.deepEqual(surfaceOverdueThreats(p, 99), []);
});

test('revealThreat открывает разово', () => {
  const p = plot();
  const t = threat(p, { known: false });
  assert.equal(revealThreat(t, 10), true);
  assert.equal(revealThreat(t, 20), false);
  assert.equal(t.surfacedDay, 10);
});

test('флаг тревоги отражает ближайшую скрытую угрозу', () => {
  const p = plot({ gravity: 'RUPTURE' });
  threat(p, { day: 0, known: false, total: 100 });
  assert.equal(dreadFlag(p, 0), 'спокойно');
  assert.equal(dreadFlag(p, 50), 'тревожно');
  assert.equal(dreadFlag(p, 80), 'очень тревожно');
  assert.equal(dreadFlag(p, 95), 'на пороге');
});

test('тревога усиливается на ступень, когда жизней почти нет', () => {
  const p = plot({ gravity: 'RUPTURE', failCount: 2 });
  threat(p, { day: 0, known: false, total: 100 });
  assert.equal(severityForPlot(p), 'УТРАТА');
  assert.equal(dreadFlag(p, 0), 'тревожно', 'спокойно + ступень');
});

test('без скрытых угроз флага тревоги нет', () => {
  const p = plot();
  threat(p, { known: true });
  assert.equal(dreadFlag(p, 0), null);
});

test('жрец видит формулировку и полосу остатка, но не число дней', () => {
  const p = plot();
  const slow = threat(p, { day: 0, known: true, total: 120 });
  const fast = threat(p, { day: 0, known: true, total: 8 });
  threat(p, { day: 0, known: false, total: 50 });
  const speech = knownThreatsForSpeech(p, 0);
  assert.equal(speech.length, 2, 'скрытая угроза в речь не попадает');
  assert.equal(speech[0].id, fast.id, 'ближайшая первой');
  assert.equal(speech[0].remainingBand, 'DAYS');
  assert.equal(speech[1].id, slow.id);
  assert.equal(speech[1].remainingBand, 'SEASON');
  assert.ok(!('remainingDays' in speech[0]));
});

// ──────────────────────────── срабатывание ────────────────────────────

test('срабатывание съедает жизнь и не закрывает историю, пока они есть', () => {
  const p = plot({ gravity: 'CRISIS' });
  const t = threat(p, { total: 100 });
  const res = fireThreat(p, t, { day: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.closes, false);
  assert.equal(res.severity, 'УЩЕРБ');
  assert.equal(p.failCount, 1);
  assert.equal(res.livesLeft, 1);
  assert.equal(t.status, 'fired');
  assert.equal(t.firedDay, 100);
});

test('обычная угроза за последней раной не закрывает историю', () => {
  const p = plot({ gravity: 'CRISIS', failCount: 2 });
  const t = threat(p, { total: 40 });
  const res = fireThreat(p, t, { day: 40 });
  assert.equal(res.closes, false);
  assert.equal(p.ending, undefined);
  assert.equal(p.failCount, 3);
});

test('угроза с endingId закрывает названной плохой карточкой', () => {
  const p = plot({ gravity: 'CRISIS', failCount: 2 });
  const t = threat(p, { total: 40 });
  t.endingId = 'e1';
  const res = fireThreat(p, t, { day: 40 });
  assert.equal(res.closes, true);
  assert.equal(res.endingKind, 'BAD_ENDING');
  assert.equal(p.ending.endingId, 'e1');
  assert.equal(p.ending.text, 'Северное крыло рушится вместе с людьми');
});

test('ситуация: обычная угроза ранит, финальная — закрывает', () => {
  const p = plot({ gravity: 'SITUATION', maxDepth: 1 });
  const wound = threat(p, { total: 30 });
  assert.equal(fireThreat(p, wound, { day: 30 }).closes, false);
  const [finale] = replenishThreats(p, { day: 30, rng: () => 0.5, author: () => ({ text: 'крыло падает' }) });
  assert.equal(finale.endingId, 'e1');
  const res = fireThreat(p, finale, { day: 60 });
  assert.equal(res.closes, true);
  assert.equal(res.endingKind, 'BAD_ENDING');
});

test('сработавшая дважды угроза не проходит', () => {
  const p = plot();
  const t = threat(p);
  fireThreat(p, t, { day: 10 });
  const again = fireThreat(p, t, { day: 20 });
  assert.equal(again.ok, false);
  assert.equal(p.failCount, 1);
});

test('стыковка-событие не закрывает нить и не тратит рану', () => {
  const p = plot();
  const t = threat(p, { outcome: 'neutral', total: 1 });
  t.eventKind = 'dock_meet';
  const res = fireThreat(p, t, { day: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.closes, false);
  assert.equal(res.kind, 'event');
  assert.equal(p.failCount, 0);
  assert.equal(p.ending, undefined);
});

test('разрешение закрывает историю нейтрально и жизнь не тратит', () => {
  const p = plot();
  const t = threat(p, { outcome: 'neutral', total: 60 });
  const res = fireThreat(p, t, { day: 60 });
  assert.equal(res.kind, 'resolution');
  assert.equal(res.closes, true);
  assert.equal(res.endingKind, 'NEUTRAL_ENDING');
  assert.equal(p.failCount, 0);
  assert.equal(p.ending.kind, 'NEUTRAL_ENDING');
});

// ──────────────────────────── отсрочка ────────────────────────────

test('выжившие угрозы получают отсрочку в исходную длительность сработавшей', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const fired = threat(p, { day: 0, total: 40 });
  const other = threat(p, { day: 0, total: 200 });
  // 40 дней прошло, у второй осталось 160 из 200 — есть куда добавить.
  fireThreat(p, fired, { day: 40 });
  assert.equal(other.dueDay, 240, '200 + 40 сработавшей');
});

test('отсрочка не поднимает угрозу выше её собственного стартового срока', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const fired = threat(p, { day: 0, total: 150 });
  const other = threat(p, { day: 0, total: 30 });
  other.dueDay = 160; // угрозу уже отодвигали
  fireThreat(p, fired, { day: 150 });
  assert.equal(other.dueDay, 180, 'потолок — сегодня плюс её собственные 30 дней');
});

test('короткая угроза после срабатывания фактически перезаводится', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const fired = threat(p, { day: 0, total: 100 });
  const other = threat(p, { day: 0, total: 60 });
  // Второй осталось 60 - 100 → срок уже прошёл бы; отсрочка возвращает её к полному сроку.
  fireThreat(p, fired, { day: 100 });
  assert.equal(other.dueDay, 160);
  assert.equal(remainingDays(other, 100), 60);
});

test('deferSurvivors не трогает сработавшую', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const a = threat(p, { day: 0, total: 50 });
  const b = threat(p, { day: 0, total: 100 });
  const changed = deferSurvivors(p, a, 10);
  assert.deepEqual(changed.map((c) => c.id), [b.id]);
});

// ──────────────────────── защита и отмена ────────────────────────

test('успешная защита снимает угрозу и растит счётчик защит', () => {
  const p = plot();
  const t = threat(p);
  const res = defendThreat(p, t, { day: 20, by: 'proc1' });
  assert.equal(res.ok, true);
  assert.equal(res.defenseCount, 1);
  assert.equal(t.status, 'averted');
  assert.equal(t.avertedBy, 'proc1');
  assert.deepEqual(liveThreats(p), []);
});

test('снятие разбором защитой не считается', () => {
  const p = plot();
  const t = threat(p);
  cancelThreat(p, t, { day: 5, reason: 'предмета больше нет' });
  assert.equal(t.status, 'cancelled');
  assert.equal(p.defenseCount, 0, 'разбор — не оборона');
});

test('отсрочка по вердикту разбора — полтора исходных срока', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 40 });
  const res = delayThreat(t, { day: 10 });
  assert.equal(res.bonus, 60);
  assert.equal(t.dueDay, 100);
  assert.equal(t.delayedDays, 60);
});

test('опасное дело срезает половину исходного срока угрозы', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 100 });
  const res = hastenThreat(t, { day: 20 });
  assert.equal(res.cut, 50);
  assert.equal(t.dueDay, 50);
  assert.equal(res.dueNow, false);
});

test('опасное дело может подтянуть срок угрозы к сегодня, но не в прошлое', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 100 });
  const res = hastenThreat(t, { day: 80 });
  assert.equal(t.dueDay, 80);
  assert.equal(res.dueNow, true);
});

test('крит-передышка добавляет половину срока', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 60 });
  const res = reprieveThreat(t);
  assert.equal(res.bonus, 30);
  assert.equal(t.dueDay, 90);
});

test('снятая угроза больше не двигается', () => {
  const p = plot();
  const t = threat(p);
  defendThreat(p, t, { day: 1 });
  assert.equal(delayThreat(t, { day: 2 }).ok, false);
  assert.equal(hastenThreat(t, { day: 2 }).ok, false);
  assert.equal(reprieveThreat(t).ok, false);
});

// ─────────────────── затухание и нейтральная концовка ───────────────────

test('замедление растёт с числом защит и упирается в потолок', () => {
  assert.equal(defenseSlowdown(plot({ defenseCount: 0 })), 0);
  assert.equal(defenseSlowdown(plot({ defenseCount: 2 })), 2);
  assert.equal(defenseSlowdown(plot({ defenseCount: 9 })), MAX_DEFENSE_SLOWDOWN);
});

test('первая защита разрешения не приносит', () => {
  assert.equal(resolutionChance(plot({ defenseCount: 0, depth: 1 })), 0);
  assert.equal(resolutionChance(plot({ defenseCount: 1, depth: 1 })), 0);
});

test('шанс разрешения растёт с обороной и упирается в 0.9', () => {
  assert.equal(resolutionChance(plot({ defenseCount: 2, depth: 1 })), 0.25);
  assert.equal(resolutionChance(plot({ defenseCount: 3, depth: 1 })), 0.5);
  assert.equal(resolutionChance(plot({ defenseCount: 20, depth: 1 })), 0.9);
});

test('набранная глубина делает разрешение неизбежным', () => {
  assert.equal(resolutionChance(plot({ depth: 3, maxDepth: 3, defenseCount: 0 })), 1);
});

test('чистая оборона без единого дела вдвое реже даёт разрешение', () => {
  assert.equal(resolutionChance(plot({ defenseCount: 3, depth: 0 })), 0.25);
});

// ──────────────────────────── дозаполнение ────────────────────────────

test('заявка не выдаётся, если слоты заполнены', () => {
  const p = plot({ gravity: 'CRISIS' });
  threat(p);
  assert.ok(nextObligationRequest(p, { rng: () => 0.5 }));
  threat(p);
  assert.equal(nextObligationRequest(p, { rng: () => 0.5 }), null);
});

test('пока висит разрешение, новых угроз не заводим', () => {
  const p = plot({ gravity: 'RUPTURE' });
  threat(p, { outcome: 'neutral' });
  assert.equal(nextObligationRequest(p, { rng: () => 0.5 }), null);
});

test('заявка несёт полосу тяжести, анти-таргет и остаток жизней', () => {
  const p = plot({ gravity: 'CRISIS', failCount: 1 });
  const req = nextObligationRequest(p, { rng: () => 0.5 });
  assert.equal(req.outcome, 'harm');
  assert.equal(req.severity, 'УТРАТА');
  assert.equal(req.antiTarget, 'Северное крыло рушится вместе с людьми');
  assert.equal(req.livesLeft, 1);
  assert.ok(req.severityGuidance.length > 10);
});

test('заявка на разрешение не несёт тяжести и не замедляется', () => {
  const p = plot({ depth: 3, maxDepth: 3 });
  const req = nextObligationRequest(p, { rng: () => 0.5 });
  assert.equal(req.outcome, 'neutral');
  assert.equal(req.severity, null);
  assert.equal(req.antiTarget, null);
  assert.equal(req.slowdown, 0);
});

test('заявка показывает автору уже висящие угрозы полосами', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const t = threat(p, { day: 0, total: 100 });
  t.text = 'фундамент садится';
  const req = nextObligationRequest(p, { day: 60, rng: () => 0.5 });
  assert.deepEqual(req.existingThreats, [{ text: 'фундамент садится', remainingBand: 'WEEKS' }]);
});

test('дозаполнение доводит историю до нормы слотов', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const created = replenishThreats(p, { day: 0, rng: () => 0.5, author: () => ({ text: 'беда' }) });
  assert.equal(created.length, 3);
  assert.equal(liveHarmThreats(p).length, 3);
  assert.ok(created.every((t) => t.text === 'беда'));
});

test('дозаполнение после срабатывания учитывает потерянную жизнь', () => {
  const p = plot({ gravity: 'CRISIS' });
  replenishThreats(p, { day: 0, rng: () => 0.5, author: () => ({ text: 'беда' }) });
  assert.equal(liveThreats(p).length, 2);
  const [first] = liveThreats(p);
  fireThreat(p, first, { day: 30 });
  const created = replenishThreats(p, { day: 30, rng: () => 0.5, author: () => ({ text: 'беда' }) });
  assert.equal(created.length, 0, 'жизней осталось одна — и слот один');
  assert.equal(liveThreats(p).length, 1);
});

test('после исчерпания ран заявка — финал к плохой карточке', () => {
  const p = plot({ gravity: 'CRISIS', failCount: 2 });
  const req = nextObligationRequest(p, { rng: () => 0.5 });
  assert.equal(req.finale, true);
  assert.equal(req.endingId, 'e1');
  assert.equal(req.endingText, 'Северное крыло рушится вместе с людьми');
  assert.equal(req.known, true);
  const [t] = replenishThreats(p, { day: 0, rng: () => 0.5, author: () => ({ text: 'сруб обвалится' }) });
  assert.equal(t.endingId, 'e1');
  assert.equal(t.known, true);
});

test('пока висит финал, второй не заводим', () => {
  const p = plot({ gravity: 'CRISIS', failCount: 2 });
  replenishThreats(p, { day: 0, rng: () => 0.5, author: () => ({ text: 'сруб обвалится' }) });
  assert.equal(nextObligationRequest(p, { rng: () => 0.5 }), null);
});

test('дозаполнение без автора всё равно ставит обязательство', () => {
  const p = plot({ gravity: 'EPISODE' });
  const created = replenishThreats(p, { day: 0, rng: () => 0.5 });
  assert.equal(created.length, 1);
  assert.equal(created[0].status, 'live');
});

test('замедление доходит до новой угрозы через счётчик защит', () => {
  const p = plot({ gravity: 'EPISODE', defenseCount: 2, depth: 1 });
  const req = nextObligationRequest(p, { rng: () => 0.5 });
  assert.equal(req.outcome, 'harm');
  assert.equal(req.slowdown, 2);
  assert.equal(req.band, 'SEASON');
  const [t] = replenishThreats(p, { day: 0, rng: () => 0.5, author: (r) => ({ text: 'беда', band: r.band }) });
  assert.equal(t.band, 'YEAR', 'SEASON + 2 ступени, зажатые потолком');
});

test('после набранной глубины дозаполнение ставит разрешение, а не угрозу', () => {
  const p = plot({ depth: 3, maxDepth: 3, defenseCount: 3 });
  const [t] = replenishThreats(p, { day: 0, rng: () => 0.5, author: () => ({ text: 'всё утихло' }) });
  assert.equal(t.outcome, 'neutral');
  assert.equal(t.known, true);
  assert.deepEqual(liveResolutions(p).map((x) => x.id), [t.id]);
});

// ──────────────────────────── прочее ────────────────────────────

test('nearestThreat находит ближайшую по сроку', () => {
  const p = plot({ gravity: 'RUPTURE' });
  threat(p, { day: 0, total: 200 });
  const near = threat(p, { day: 0, total: 12 });
  assert.equal(nearestThreat(p, 0).id, near.id);
});

test('findThreat и remainingDays', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 30 });
  assert.equal(findThreat(p, t.id).id, t.id);
  assert.equal(findThreat(p, 'нет такого'), null);
  assert.equal(remainingDays(t, 10), 20);
  assert.equal(remainingDays(t, 999), 0, 'остаток не бывает отрицательным');
});

test('нормализация переживает круг через JSON', () => {
  const p = plot({ gravity: 'RUPTURE' });
  threat(p, { day: 0, total: 40, known: false });
  threat(p, { day: 0, total: 90, outcome: 'neutral' });
  const revived = normalizePlotThreats(JSON.parse(JSON.stringify(p)));
  assert.equal(revived.threats.length, 2);
  assert.equal(revived.threats[0].known, false);
  assert.equal(revived.threats[1].outcome, 'neutral');
  assert.equal(revived.threats[1].known, true);
  assert.equal(revived.defenseCount, 0);
});

test('нормализация выкидывает мусор и чинит поля', () => {
  const p = { id: 'p', gravity: 'CRISIS', threats: [null, 'мусор', { text: 'беда', band: 'нет' }] };
  normalizePlotThreats(p);
  assert.equal(p.threats.length, 1);
  assert.equal(p.threats[0].band, 'SEASON');
  assert.equal(p.threats[0].status, 'live');
  assert.equal(p.threats[0].severity, 'ТРЕВОГА');
});
