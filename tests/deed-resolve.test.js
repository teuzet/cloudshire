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
import { applyDeedToPlot } from '../src/game/deedResolve.js';
import { createThreat, attachThreat, liveThreats, findThreat } from '../src/game/threats.js';

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
  applyAlignment(p, alignment, {
    threatId: extra.threatId || '',
    threatIds: extra.threatIds || [],
  });
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
  applyAlignment(p, 'DIRECT', { threatIds: ['t1'] });
  assert.equal(p.endingId, '');
  assert.deepEqual(p.threatIds, []);
  applyAlignment(p, 'RELEVANT', { threatIds: ['t1'] });
  assert.equal(p.endingId, '');
  assert.deepEqual(p.threatIds, ['t1']);
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
  assert.equal(p.ending.kind, 'GOOD_ENDING');
});

test('DIRECT с малой глубиной успех не закрывает историю', () => {
  // Игрок может пойти напрямую с первого шага — успех будет, но закрытия нет.
  const p = plot({ depth: 0, maxDepth: 3 });
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'ok', rng: () => 0.5 });
  assert.equal(res.closes, false);
  assert.ok(p.depth > 0, 'но цель стала достижимее');
});

test('DIRECT-провал давит на шкалу и не тратит жизнь', () => {
  const p = plot();
  p.pressure = { value: 0, day: 0, fillDays: 100 };
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'fail', day: 0 });
  assert.equal(res.depthGain, 0);
  assert.equal(p.depth, 0);
  assert.equal(p.failCount, 0);
  assert.equal(res.pressureFilled, false);
  assert.equal(p.pressure.value, 25);
  assert.equal(res.closes, false);
});

test('DIRECT-провал на полной шкале помечает, что беда должна сработать', () => {
  const p = plot({ failCount: 2 });
  p.pressure = { value: 80, day: 0, fillDays: 100 };
  const res = applyDeedToPlot({ plot: p, process: deed('DIRECT'), finish: 'fail', day: 0 });
  assert.equal(res.closes, false);
  assert.equal(res.pressureFilled, true);
  assert.equal(p.failCount, 2);
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

test('RELEVANT-успех снимает названную угрозу и чуть двигает глубину', () => {
  const p = plot();
  p.pressure = { value: 40, day: 0, fillDays: 100 };
  const t = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatId: t.id }),
    finish: 'ok',
    day: 0,
  });
  assert.equal(res.threatId, t.id);
  assert.equal(t.status, 'averted');
  assert.ok(res.depthGain > 0 && res.depthGain < 0.2);
  assert.ok(p.pressure.value < 40);
});

test('RELEVANT-провал угрозу не трогает и давит на шкалу', () => {
  const p = plot();
  p.pressure = { value: 0, day: 0, fillDays: 100 };
  const t = threat(p);
  const res = applyDeedToPlot({ plot: p, process: deed('RELEVANT', { threatId: t.id }), finish: 'fail', day: 0 });
  assert.equal(t.status, 'live');
  assert.equal(p.pressure.value, 20);
  assert.equal(res.pressureFilled, false);
});

test('без threatId RELEVANT ничего не снимает', () => {
  const p = plot();
  const t = threat(p);
  const res = applyDeedToPlot({ plot: p, process: deed('RELEVANT'), finish: 'ok' });
  assert.equal(res.threatId, null);
  assert.equal(t.status, 'live');
});

test('RELEVANT без угрозы вовсе не падает', () => {
  const p = plot();
  const res = applyDeedToPlot({ plot: p, process: deed('RELEVANT'), finish: 'ok' });
  assert.equal(res.threatId, null);
  assert.equal(res.averted.length, 0);
});

test('крит RELEVANT снимает сильнее и даёт чуть больше глубины', () => {
  const p = plot();
  p.pressure = { value: 40, day: 0, fillDays: 100 };
  const target = threat(p);
  const other = threat(p, { text: 'фундамент садится' });
  const res = applyDeedToPlot({
    plot: p,
    process: deed('RELEVANT', { threatIds: [target.id] }),
    finish: 'crit',
    day: 5,
  });
  assert.equal(target.status, 'averted');
  assert.equal(other.status, 'live');
  assert.ok(res.depthGain > 0.02);
  assert.ok(p.pressure.value < 32);
});

test('DANGEROUS-провал беду не вызывает', () => {
  const p = plot();
  const t = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'fail',
    day: 20,
  });
  assert.equal(t.status, 'live');
  assert.equal(res.triggerThreat, null);
});

test('DANGEROUS-успех помечает беду к исполнению и сам её не сжигает', () => {
  const p = plot();
  const t = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'ok',
    day: 20,
  });
  assert.equal(res.triggerThreat.id, t.id);
  assert.equal(t.status, 'live');
  assert.equal(res.closes, false);
});

test('DANGEROUS-крит тоже только помечает беду', () => {
  const p = plot({ failCount: 2 });
  const t = threat(p);
  const res = applyDeedToPlot({
    plot: p,
    process: deed('DANGEROUS', { threatId: t.id }),
    finish: 'crit',
  });
  assert.equal(res.triggerThreat.id, t.id);
  assert.equal(res.closes, false);
  assert.equal(p.failCount, 2);
});

test('UNRELATED нить не двигает вовсе', () => {
  const p = plot();
  const t = threat(p);
  const res = applyDeedToPlot({ plot: p, process: deed('UNRELATED'), finish: 'crit' });
  assert.equal(res.depthGain, 0);
  assert.equal(p.depth, 0);
  assert.equal(p.failCount, 0);
  assert.equal(findThreat(p, t.id).status, 'live');
  assert.equal(liveThreats(p).length, 1);
});

test('без нити применение исхода не падает', () => {
  const res = applyDeedToPlot({ plot: null, process: deed('DIRECT'), finish: 'ok' });
  assert.equal(res.depthGain, 0);
  assert.equal(res.closes, false);
});
