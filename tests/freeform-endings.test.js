import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  formatEndingsJudgeCase,
  formatEndingsJudgeRepair,
  refreshFreeformEndings,
} from '../src/game/freeformEndings.js';
import { normalizeFreeformEndings, formatFreeformEndings } from '../src/game/plotlines.js';

const silentLog = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function plot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    title: 'Гон костоломов',
    synopsis: 'в выработке нельзя работать, пока идёт гон',
    cause: 'гон костоломов — сезонный цикл карьерных птиц',
    gravity: 'CRISIS',
    depth: 0,
    maxDepth: 3,
    failCount: 0,
    maxFails: 2,
    threats: [],
    endings: [],
    ...extra,
  };
}

const domain = { id: 'd1', name: 'Варшена', cityBrief: 'ЦИСТЕРНЫ_МАРКЕР питают водосборы.', lore: [], plotlines: [] };

function triple(kind, n) {
  return {
    id: `e_${n}`,
    kind,
    text: `Концовка ${n}`,
    questionGone: `Вопроса больше нет, потому что ${n}`,
    nowDifferent: `В городе теперь иначе: ${n}`,
  };
}

const GOOD = triple('GOOD_ENDING', 1);
const NEUTRAL = triple('NEUTRAL_ENDING', 2);
const BAD = triple('BAD_ENDING', 3);

// ──────────────────────────── модель концовки ────────────────────────────

test('концовка несёт тройку: что случилось, почему вопрос снят, что теперь иначе', () => {
  const [e] = normalizeFreeformEndings([GOOD]);
  assert.equal(e.text, 'Концовка 1');
  assert.equal(e.questionGone, 'Вопроса больше нет, потому что 1');
  assert.equal(e.nowDifferent, 'В городе теперь иначе: 1');
});

test('в списке для промпта видны обе новые строки', () => {
  const text = formatFreeformEndings(normalizeFreeformEndings([GOOD, BAD]));
  assert.match(text, /вопрос снят: Вопроса больше нет, потому что 1/);
  assert.match(text, /теперь иначе: В городе теперь иначе: 3/);
});

// ──────────────────────────── выдача и судья ────────────────────────────

function endingsRuntime({ endings = [GOOD, NEUTRAL, BAD], reviews = null, repaired = null } = {}) {
  const calls = [];
  let asked = 0;
  return {
    calls,
    run: async (opts) => {
      calls.push({
        agentId: opts.agentId,
        user: opts.userMessages[0].content,
        extraSystem: String(opts.extraSystem || ''),
        domainId: opts.domainId,
      });
      const tool = opts.tools[0];
      if (opts.agentId === 'freeformEndings') {
        asked += 1;
        const list = asked === 1 || !repaired ? endings : repaired;
        await tool.handler({ keep: false, endings: list });
      } else if (opts.agentId === 'freeformEndingsJudge') {
        const n = tool.parameters.properties.reviews.maxItems;
        await tool.handler({
          reviews: reviews || Array.from({ length: n }, (_, i) => ({ index: i + 1, verdict: 'PASS' })),
        });
      }
      return {};
    },
  };
}

test('без questionGone и nowDifferent список не принимается', async () => {
  const runtime = endingsRuntime({ endings: [{ id: 'g', kind: 'GOOD_ENDING', text: 'Всё уладилось.' }] });
  const rejected = [];
  const wrapped = {
    run: async (opts) => {
      if (opts.agentId === 'freeformEndings') {
        const res = await opts.tools[0].handler({
          keep: false,
          endings: [{ id: 'g', kind: 'GOOD_ENDING', text: 'Всё уладилось.' }],
        });
        rejected.push(res);
        return {};
      }
      return runtime.run(opts);
    },
  };
  const p = plot();
  await refreshFreeformEndings({ runtime: wrapped, domain, plot: p, log: silentLog });
  assert.equal(rejected[0].ok, false);
  assert.match(rejected[0].error || rejected[0].reason || '', /questionGone|thin/);
});

test('свежий список идёт к судье, PASS не гоняет автора второй раз', async () => {
  const runtime = endingsRuntime();
  const p = plot();
  const res = await refreshFreeformEndings({ runtime, domain, plot: p, config: loadConfig(), log: silentLog });
  assert.deepEqual(
    runtime.calls.map((c) => c.agentId),
    ['freeformEndings', 'freeformEndingsJudge'],
  );
  assert.ok(runtime.calls.every((c) => c.domainId === 'd1'));
  assert.match(runtime.calls[0].user, /GRAVITY: CRISIS/);
  assert.match(runtime.calls[0].user, /пожар|осада|Восстание/);
  assert.doesNotMatch(runtime.calls[0].user, /SITUATION|EPISODE|RUPTURE/);
  assert.match(runtime.calls[0].extraSystem, /ЦИСТЕРНЫ_МАРКЕР/);
  assert.match(runtime.calls[0].extraSystem, /стандартный бриф/);
  assert.doesNotMatch(runtime.calls[0].extraSystem, /cityBrief/i);
  assert.doesNotMatch(runtime.calls[0].user, /cityBrief/i);
  assert.doesNotMatch(runtime.calls[1].extraSystem, /ЦИСТЕРНЫ_МАРКЕР/);
  assert.equal(res.endings.length, 3);
  assert.equal(p.endings[0].questionGone, GOOD.questionGone);
  assert.equal(p.closeWhen[0], 'Концовка 1');
});

test('FAIL судьи даёт ровно один круг починки', async () => {
  const fixed = [
    { ...GOOD, text: 'Гнездовье перенесли, выработка открыта круглый год.' },
    NEUTRAL,
    BAD,
  ];
  const runtime = endingsRuntime({
    reviews: [
      { index: 1, verdict: 'FAIL', code: 'CAUSE_UNTOUCHED', repair: 'Первопричина осталась на месте.' },
      { index: 2, verdict: 'PASS' },
      { index: 3, verdict: 'PASS' },
    ],
    repaired: fixed,
  });
  const p = plot();
  const res = await refreshFreeformEndings({ runtime, domain, plot: p, log: silentLog });
  assert.deepEqual(
    runtime.calls.map((c) => c.agentId),
    ['freeformEndings', 'freeformEndingsJudge', 'freeformEndings'],
  );
  assert.match(runtime.calls[2].user, /CAUSE_UNTOUCHED/);
  assert.match(runtime.calls[2].user, /Первопричина осталась на месте/);
  assert.match(res.endings[0].text, /Гнездовье перенесли/);
});

test('судья видит первопричину и обе новые строки', () => {
  const text = formatEndingsJudgeCase(plot(), normalizeFreeformEndings([GOOD]));
  assert.match(text, /Первопричина: гон костоломов — сезонный цикл карьерных птиц/);
  assert.match(text, /вопрос снят:/);
  assert.match(text, /теперь иначе:/);
});

test('починка собирается только из FAIL', () => {
  const list = normalizeFreeformEndings([GOOD, NEUTRAL]);
  const repair = formatEndingsJudgeRepair(list, [
    { index: 1, verdict: 'PASS' },
    { index: 2, verdict: 'FAIL', code: 'NOT_A_LOSS', repair: 'Названо ухудшение, а не утрата.' },
  ]);
  assert.doesNotMatch(repair, /Концовка 1/);
  assert.match(repair, /Концовка 2/);
  assert.match(repair, /NOT_A_LOSS/);
});

test('без FAIL починки нет', () => {
  const list = normalizeFreeformEndings([GOOD]);
  assert.equal(formatEndingsJudgeRepair(list, [{ index: 1, verdict: 'PASS' }]), '');
});
