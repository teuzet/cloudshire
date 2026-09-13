import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEED_ALIGNMENTS,
  parseAlignment,
  alignmentAttends,
  alignmentNeedsWarning,
  applyAlignment,
  alignmentOf,
} from '../src/game/deedAlign.js';
import { applyDeedToPlot, critCascade } from '../src/game/deedResolve.js';
import { createThreat, attachThreat, liveThreats, livesLeft, findThreat } from '../src/game/threats.js';

function plot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    gravity: 'CRISIS',
    depth: 0,
    maxDepth: 3,
    failCount: 0,
    defenseCount: 0,
    threats: [],
    endings: [{ id: 'e1', kind: 'BAD_ENDING', text: 'крыло рушится' }],
    ...extra,
  };
}

function deed(alignment, extra = {}) {
  const p = { id: 'proc1', summary: 'укрепить опору', durationBand: 'WEEKS', difficulty: 'HARD', ...extra };
  applyAlignment(p, alignment, { endingId: extra.endingId || 'e1', threatId: extra.threatId || '' });
  return p;
}

function threat(p, opts = {}) {
  const t = createThreat({
    plot: p,
    text: opts.text || 'обвал',
    band: opts.band || 'SEASON',
    day: opts.day ?? 0,
    known: opts.known ?? true,
    outcome: opts.outcome || 'harm',
    rng: () => 0.5,
  });
  if (opts.total != null) {
    t.totalDays = opts.total;
    t.dueDay = (opts.day ?? 0) + opts.total;
  }
  attachThreat(p, t);
  return t;
}

// ───────────────────────────── лестница ─────────────────────────────

test('в лестнице ровно четыре ступени в правильном порядке', () => {
  assert.deepEqual(DEED_ALIGNMENTS, ['DIRECT', 'RELEVANT', 'DANGEROUS', 'UNRELATED']);
});

test('мусор падает в UNRELATED, а не в середину лестницы', () => {
  assert.equal(parseAlignment('direct'), 'DIRECT');
  assert.equal(parseAlignment('RELATED'), 'UNRELATED', 'старое слово больше не в словаре');
  assert.equal(parseAlignment(null), 'UNRELATED');
});

test('на нити числятся все, кроме постороннего', () => {
  assert.ok(alignmentAttends('DIRECT'));
  assert.ok(alignmentAttends('RELEVANT'));
  assert.ok(alignmentAttends('DANGEROUS'), 'опасное дело тоже висит на нити');
  assert.ok(!alignmentAttends('UNRELATED'));
});

test('жрец переспрашивает на опасном и на постороннем', () => {
  assert.ok(alignmentNeedsWarning('DANGEROUS'));
  assert.ok(alignmentNeedsWarning('UNRELATED'));
  assert.ok(!alignmentNeedsWarning('DIRECT'));
  assert.ok(!alignmentNeedsWarning('RELEVANT'));
});

test('выравнивание чистит поля, которые к нему не относятся', () => {
  const p = {};
  applyAlignment(p, 'DIRECT', { endingId: 'e1', threatId: 't1' });
  assert.equal(p.endingId, 'e1');
  assert.equal(p.threatId, '');
  applyAlignment(p, 'RELEVANT', { endingId: 'e1', threatId: 't1' });
  assert.equal(p.endingId, '');
  assert.equal(p.threatId, 't1');
  assert.equal(p.plotAligned, false);
});

test('старый boolean читается как раньше', () => {
  assert.equal(alignmentOf({ plotAligned: true }), 'DIRECT');
  assert.equal(alignmentOf({ plotAligned: false }), 'RELEVANT');
  assert.equal(alignmentOf({}), null, 'нет вердикта — это не UNRELATED');
});

// ───────────────────────────── DIRECT ─────────────────────────────

test('DIRECT-успех даёт глубину по матрице', () => {
  const p = plot();
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'ok', rng: () => 0.5 });
  assert.equal(res.depthGain, 1.2, 'WEEKS × HARD × CRISIS');
  assert.equal(p.depth, 1.2);
  assert.equal(res.closes, false);
});

test('DIRECT-крит даёт половину сверху', () => {
  const p = plot();
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'crit', rng: () => 0.5 });
  assert.equal(res.depthGain, 1.8);
});

test('короткое дело весит заметную долю истории, а не крошку', () => {
  // Платит игрок вниманием, а не игровым временем: десять вылазок по восемь
  // дней не должны стоить дешевле одной годовой стройки.
  const p = plot({ gravity: 'RUPTURE', maxDepth: 4 });
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DIRECT', { durationBand: 'DAYS', difficulty: 'PLAIN' }),
    finish: 'ok',
    rng: () => 0.5,
  });
  assert.equal(res.depthGain, 0.35);
  assert.ok(res.depthGain * 12 >= p.maxDepth, 'разрыв берётся дюжиной коротких дел, не тридцатью');
});

test('глубина хранится дробной', () => {
  const p = plot();
  applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'ok', rng: () => 0.5 });
  applyDeedToPlot({ plot: p, process: deed('DIRECT', { difficulty: 'PLAIN' }), finish: 'ok', rng: () => 0.5 });
  assert.equal(p.depth, 1.9);
  assert.ok(!Number.isInteger(p.depth));
});

test('DIRECT закрывает историю, когда работа набрана', () => {
  const p = plot({ depth: 2.5 });
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'ok', rng: () => 0.5 });
  assert.equal(res.closes, true);
  assert.equal(res.endingKind, 'GOOD_ENDING');
  assert.equal(p.ending.endingId, 'e1');
});

test('DIRECT с малой глубиной успех не закрывает историю', () => {
  // Игрок может пойти напрямую с первого шага — успех будет, но закрытия нет.
  const p = plot({ depth: 0, maxDepth: 3 });
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'ok', rng: () => 0.5 });
  assert.equal(res.closes, false);
  assert.ok(p.depth > 0, 'но цель стала достижимее');
});

test('DIRECT-провал стоит жизни, а не глубины', () => {
  const p = plot();
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'fail' });
  assert.equal(res.depthGain, 0);
  assert.equal(p.depth, 0);
  assert.equal(p.failCount, 1);
  assert.equal(res.livesLeft, 1);
  assert.equal(res.severity, 'УЩЕРБ');
  assert.equal(res.closes, false);
});

test('DIRECT-провал на последней ране не закрывает — только копит провал', () => {
  const p = plot({ failCount: 2 });
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'fail' });
  assert.equal(res.closes, false);
  assert.equal(p.ending, undefined);
  assert.equal(p.failCount, 3);
});

// ─────────────────────── раскрытие на DIRECT ───────────────────────

const ANSWER = 'стада вытеснила стая через трещину';
const TRACKS = 'свежая лёжка у обрыва и погрызенные кости';
const ELDER = 'старейшина нашёл следы и молчит';

function mystery(extra = {}) {
  // CRISIS, maxDepth 3 → сердцевина открывается на глубине 1.8.
  return plot({
    hiddenAnswer: ANSWER,
    hiddenPremises: [TRACKS, ELDER],
    revealedPremises: [],
    ...extra,
  });
}

/** Дешёвая вылазка: 0.25 глубины, до порога сердцевины не дотягивает. */
function scout(extra = {}) {
  return deed('DIRECT', { durationBand: 'DAYS', difficulty: 'TRIVIAL', ...extra });
}

test('DIRECT-успех вскрывает тот подступ, на который указал судья', () => {
  const p = mystery();
  const res = applyDeedToPlot({ plot: p, process: scout({ premiseText: ELDER }), finish: 'ok', rng: () => 0.5 });
  assert.deepEqual(res.revealed, [ELDER]);
  assert.equal(res.answer, null);
  assert.deepEqual(p.revealedPremises, [ELDER]);
  assert.deepEqual(p.hiddenPremises, [TRACKS], 'раскрытое уходит из скрытого');
  assert.ok(res.depthGain > 0, 'расследование первопричины — это работа по сути');
});

test('дешёвое дело целится в разгадку, но приносит подступ', () => {
  const p = mystery();
  const res = applyDeedToPlot({
    plot: p,
    process: scout({ premiseText: TRACKS, reachesAnswer: true }),
    finish: 'ok',
    rng: () => 0.5,
  });
  assert.equal(res.answer, null, 'сердцевина ещё не по силам городу');
  assert.deepEqual(res.revealed, [TRACKS], 'но успех не пустой');
  assert.equal(p.hiddenAnswer, ANSWER);
});

test('разгадка открывается, когда набрана целевая глубина', () => {
  const p = mystery({ depth: 1.6 });
  const res = applyDeedToPlot({
    plot: p,
    process: scout({ premiseText: TRACKS, reachesAnswer: true }),
    finish: 'ok',
    rng: () => 0.5,
  });
  assert.equal(res.answer, ANSWER, '1.6 + 0.25 перевалило 1.8');
  assert.deepEqual(res.revealed, [], 'дело шло за разгадкой, а не за подступом');
  assert.equal(p.revealedAnswer, ANSWER);
  assert.equal(p.hiddenAnswer, '');
  assert.deepEqual(p.hiddenPremises, [TRACKS, ELDER], 'неиспользованные подступы остаются скрытыми');
});

test('крит вскрывает разгадку досрочно', () => {
  const p = mystery();
  const res = applyDeedToPlot({
    plot: p,
    process: scout({ premiseText: TRACKS, reachesAnswer: true }),
    finish: 'crit',
    rng: () => 0.5,
  });
  assert.equal(res.answer, ANSWER);
  assert.ok(p.depth < 1.8, 'порог взят не глубиной, а качеством работы');
});

test('когда подступы исчерпаны, разгадка открыта сама', () => {
  const p = mystery({ hiddenPremises: [] });
  const res = applyDeedToPlot({
    plot: p,
    process: scout({ reachesAnswer: true }),
    finish: 'ok',
    rng: () => 0.5,
  });
  assert.equal(res.answer, ANSWER, 'искать больше нечего, и гейту нечем держать');
});

test('крит без прицела на разгадку её не выдаёт', () => {
  const p = mystery();
  const res = applyDeedToPlot({ plot: p, process: scout({ premiseText: ELDER }), finish: 'crit', rng: () => 0.5 });
  assert.equal(res.answer, null);
  assert.deepEqual(res.revealed, [ELDER]);
  assert.equal(p.hiddenAnswer, ANSWER);
});

test('DIRECT без расследования только копит глубину', () => {
  const p = mystery();
  const res = applyDeedToPlot({ plot: p, process: scout(), finish: 'ok', rng: () => 0.5 });
  assert.deepEqual(res.revealed, []);
  assert.equal(res.answer, null);
  assert.equal(p.hiddenPremises.length, 2);
  assert.ok(res.depthGain > 0);
});

test('DIRECT-провал не выясняет ничего', () => {
  const p = mystery();
  const res = applyDeedToPlot({
    plot: p,
    process: scout({ premiseText: TRACKS, reachesAnswer: true }),
    finish: 'fail',
  });
  assert.deepEqual(res.revealed, []);
  assert.equal(res.answer, null);
  assert.equal(p.hiddenPremises.length, 2);
  assert.equal(p.hiddenAnswer, ANSWER);
});

test('уже раскрытое вторым делом не раскрывается снова', () => {
  const p = mystery();
  const process = scout({ premiseText: TRACKS });
  applyDeedToPlot({ plot: p, process, finish: 'ok', rng: () => 0.5 });
  const res = applyDeedToPlot({ plot: p, process, finish: 'ok', rng: () => 0.5 });
  assert.deepEqual(res.revealed, []);
  assert.deepEqual(p.revealedPremises, [TRACKS]);
});

test('RELEVANT ничего не выясняет, даже если пункт назван', () => {
  const p = mystery();
  const t = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatId: t.id, premiseText: TRACKS, reachesAnswer: true }),
    finish: 'ok',
  });
  assert.deepEqual(res.revealed, []);
  assert.equal(res.answer, null);
  assert.equal(p.hiddenPremises.length, 2);
});

// ──────────────────────────── RELEVANT ────────────────────────────

test('RELEVANT-успех снимает названную угрозу', () => {
  const p = plot();
  const t = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatId: t.id }),
    finish: 'ok',
    day: 30,
  });
  assert.equal(res.threatId, t.id);
  assert.equal(t.status, 'averted');
  assert.equal(p.defenseCount, 1);
  assert.equal(res.depthGain, 0, 'оборона глубины не даёт');
});

test('RELEVANT-провал угрозу не трогает', () => {
  const p = plot();
  const t = threat(p, { total: 100 });
  applyDeedToPlot({ plot: p, process: deed('RELEVANT', { threatId: t.id }), finish: 'fail', day: 10 });
  assert.equal(t.status, 'live');
  assert.equal(t.dueDay, 100);
  assert.equal(p.defenseCount, 0);
});

test('без threatId берётся первая живая вредная угроза', () => {
  const p = plot();
  const t = threat(p);
  threat(p, { outcome: 'neutral' });
  const res = applyDeedToPlot({ plot: p, process: deed('RELEVANT'), finish: 'ok' });
  assert.equal(res.threatId, t.id, 'разрешение не является целью обороны');
});

test('RELEVANT без угрозы вовсе не падает', () => {
  const p = plot();
  const res = applyDeedToPlot({ plot: p, process: deed('RELEVANT'), finish: 'ok' });
  assert.equal(res.threatId, null);
  assert.equal(p.defenseCount, 0);
});

// ──────────────────── каскад крита на RELEVANT ────────────────────

test('крит сначала открывает скрытую угрозу', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const target = threat(p);
  const hidden = threat(p, { known: false, text: 'фундамент садится' });
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatId: target.id }),
    finish: 'crit',
    day: 5,
  });
  assert.equal(res.cascade.step, 'reveal');
  assert.equal(res.cascade.threatId, hidden.id);
  assert.equal(hidden.known, true);
});

test('если скрытых нет — другая угроза получает передышку', () => {
  const p = plot({ gravity: 'RUPTURE' });
  const target = threat(p);
  const other = threat(p, { day: 0, total: 80, known: true });
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatId: target.id }),
    finish: 'crit',
    day: 10,
  });
  assert.equal(res.cascade.step, 'reprieve');
  assert.equal(res.cascade.bonusDays, 40);
  assert.equal(other.dueDay, 120);
});

test('если больше угроз нет — возвращается потерянная жизнь', () => {
  const p = plot({ failCount: 1 });
  const target = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatId: target.id }),
    finish: 'crit',
  });
  assert.equal(res.cascade.step, 'restore_life');
  assert.equal(p.failCount, 0);
  assert.equal(livesLeft(p), 2);
});

test('когда дать нечего — крит добавляет немного глубины', () => {
  const p = plot();
  const target = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatId: target.id }),
    finish: 'crit',
  });
  assert.equal(res.cascade.step, 'depth');
  assert.equal(p.depth, 0.5);
});

test('каскад срабатывает ровно один раз', () => {
  const p = plot({ gravity: 'RUPTURE', failCount: 1 });
  const target = threat(p);
  const hidden = threat(p, { known: false });
  const other = threat(p, { day: 0, total: 60 });
  const res = critCascade(p, target, { day: 0 });
  assert.equal(res.step, 'reveal');
  assert.equal(hidden.known, true);
  assert.equal(other.dueDay, 60, 'передышки не было');
  assert.equal(p.failCount, 1, 'жизнь не вернулась');
  assert.equal(p.depth, 0);
});

// ──────────────────────────── DANGEROUS ────────────────────────────

test('DANGEROUS-провал ничего не портит', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 100 });
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'fail',
    day: 20,
  });
  assert.equal(t.dueDay, 100);
  assert.equal(res.hastenedDays, undefined);
});

test('DANGEROUS-успех приближает беду вдвое от её срока', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 100 });
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'ok',
    day: 20,
  });
  assert.equal(res.hastenedDays, 50);
  assert.equal(t.dueDay, 50);
  assert.equal(t.status, 'live');
});

test('DANGEROUS-крит роняет беду немедленно', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 100 });
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'crit',
    day: 20,
  });
  assert.equal(t.status, 'fired');
  assert.equal(t.firedBy, 'proc1');
  assert.equal(p.failCount, 1);
  assert.equal(res.fired.ok, true);
  assert.equal(res.closes, false);
});

test('DANGEROUS-крит обычной угрозы на краю не хоронит историю', () => {
  const p = plot({ failCount: 2 });
  const t = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'crit',
  });
  assert.equal(res.closes, false);
  assert.equal(p.failCount, 3);
});

test('DANGEROUS-крит финальной угрозы ставит названную концовку', () => {
  const p = plot({ failCount: 2 });
  const t = threat(p);
  t.endingId = 'e1';
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'crit',
  });
  assert.equal(res.closes, true);
  assert.equal(res.endingKind, 'BAD_ENDING');
  assert.equal(p.ending.endingId, 'e1');
});

// ──────────────────────────── UNRELATED ────────────────────────────

test('UNRELATED нить не двигает вовсе', () => {
  const p = plot();
  const t = threat(p, { day: 0, total: 90 });
  const res = applyDeedToPlot({ plot: p, process: deed('UNRELATED'), finish: 'crit' });
  assert.equal(res.depthGain, 0);
  assert.equal(p.depth, 0);
  assert.equal(p.failCount, 0);
  assert.equal(findThreat(p, t.id).dueDay, 90);
  assert.equal(liveThreats(p).length, 1);
});

test('без нити применение исхода не падает', () => {
  const res = applyDeedToPlot({ plot: null, process: deed('DIRECT'), finish: 'ok' });
  assert.equal(res.depthGain, 0);
  assert.equal(res.closes, false);
});
