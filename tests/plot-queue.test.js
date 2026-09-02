import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rehomeUnrelatedProcess,
  rehomeUnrelatedOnDomain,
  collectProcessAdvanceBatch,
  applyQueuedEngineProgress,
  planBeats,
  attendingQueueForPlot,
  detachProcessFromPlots,
} from '../src/game/plotEngine.js';
import { applyEngagement } from '../src/game/plotAlign.js';

const ACTS = { acts: { maxEscalations: 3, worsenMin: 1.1, worsenMax: 1.1, dampMin: 0.9, dampMax: 0.9 } };
const midRng = () => 0.5;

function mystery(extra = {}) {
  return {
    id: 'plot_story',
    title: 'Гул в цистерне',
    synopsis: 'В нижней цистерне ночами гудит вода.',
    closeWhen: 'Найдут источник гула.',
    kind: 'story',
    relatedProcessIds: [],
    relatedStats: ['security'],
    tags: [],
    chronicleIds: [],
    relatedPlotlineIds: [],
    importance: 40,
    maxAgeMonths: 6,
    ageMonths: 0,
    temperature: 30,
    status: 'open',
    ...extra,
  };
}

function process(id, extra = {}) {
  return {
    id,
    summary: id,
    detail: `работа ${id}`,
    status: 'active',
    monthsLeft: 3,
    expectedMonths: 3,
    monthsDone: 0,
    linkedStats: ['security'],
    createdAt: extra.createdAt || '2026-08-30T12:00:00.000Z',
    ...extra,
  };
}

test('UNRELATED снимается с истории на свою нить-поручение', () => {
  const plot = mystery({ relatedProcessIds: ['act_side'] });
  const action = process('act_side');
  applyEngagement(action, 'UNRELATED');
  action.plotlineId = plot.id;
  const domain = { plotlines: [plot], state: { pendingActions: [action] } };
  const moved = rehomeUnrelatedProcess(domain, action, { tick: 10 });
  assert.equal(moved.rehomed, true);
  assert.equal(moved.originPlot.id, plot.id);
  assert.equal(plot.relatedProcessIds.includes('act_side'), false);
  assert.equal(action.plotlineId, moved.plot.id);
  assert.equal(moved.plot.kind, 'errand');
  assert.equal(domain.plotlines.some((p) => p.kind === 'errand' && p.relatedProcessIds.includes('act_side')), true);
});

test('повторный rehome уже на поручении ничего не плодит', () => {
  const plot = mystery({ relatedProcessIds: ['act_side'] });
  const action = process('act_side');
  applyEngagement(action, 'UNRELATED');
  const domain = { plotlines: [plot], state: { pendingActions: [action] } };
  rehomeUnrelatedProcess(domain, action, { tick: 1 });
  const errandsBefore = domain.plotlines.filter((p) => p.kind === 'errand').length;
  const again = rehomeUnrelatedProcess(domain, action, { tick: 2 });
  assert.equal(again.rehomed, false);
  assert.equal(domain.plotlines.filter((p) => p.kind === 'errand').length, errandsBefore);
});

test('два DIRECT на одной нити: второе дело видит состояние после первого', () => {
  const plot = mystery({ relatedProcessIds: ['act_a', 'act_b'] });
  const domain = {
    plotlines: [plot],
    state: {
      pendingActions: [
        process('act_a', {
          plotEngagement: 'DIRECT',
          plotAligned: true,
          createdAt: '2026-08-30T12:00:00.000Z',
        }),
        process('act_b', {
          plotEngagement: 'DIRECT',
          plotAligned: true,
          createdAt: '2026-08-30T12:10:00.000Z',
        }),
      ],
    },
  };
  const { beats } = planBeats({
    domain,
    config: ACTS,
    processOutcomes: [
      {
        processId: 'act_b',
        mustNarrate: true,
        finished: true,
        finish: 'ok',
        plotEngagement: 'DIRECT',
        plotAligned: true,
      },
      {
        processId: 'act_a',
        mustNarrate: true,
        finished: true,
        finish: 'ok',
        plotEngagement: 'DIRECT',
        plotAligned: true,
      },
    ],
    rng: () => 1,
  });
  const story = beats.filter((b) => b.plotId === plot.id && b.reason === 'process_finished');
  assert.equal(story.length, 2);
  assert.equal(story[0].processOutcome.processId, 'act_a');
  assert.equal(story[1].processOutcome.processId, 'act_b');
});

test('на одной нити в месяц тикает только старшее DIRECT дело', () => {
  const plot = mystery({ relatedProcessIds: ['act_old', 'act_new'] });
  const old = process('act_old', {
    plotEngagement: 'DIRECT',
    plotAligned: true,
    createdAt: '2026-08-30T11:00:00.000Z',
    monthsLeft: 3,
  });
  const newer = process('act_new', {
    plotEngagement: 'DIRECT',
    plotAligned: true,
    createdAt: '2026-08-30T12:00:00.000Z',
    monthsLeft: 2,
  });
  const domain = {
    plotlines: [plot],
    stats: { security: 50 },
    state: { pendingActions: [old, newer] },
  };
  const due = collectProcessAdvanceBatch(domain);
  assert.deepEqual(due.map((p) => p.id), ['act_old']);
  assert.equal(attendingQueueForPlot(domain, plot)[0].id, 'act_old');

  applyQueuedEngineProgress(domain, { tick: 4, rng: midRng });
  assert.equal(old.monthsLeft, 2);
  assert.equal(newer.monthsLeft, 2);
  assert.equal(old.status, 'active');
  assert.equal(newer.status, 'active');
});

test('когда голова очереди завершилась, второе дело тикает в том же месяце', () => {
  const plot = mystery({ relatedProcessIds: ['act_old', 'act_new'] });
  const old = process('act_old', {
    plotEngagement: 'DIRECT',
    plotAligned: true,
    createdAt: '2026-08-30T11:00:00.000Z',
    monthsLeft: 1,
    expectedMonths: 3,
  });
  const newer = process('act_new', {
    plotEngagement: 'DIRECT',
    plotAligned: true,
    createdAt: '2026-08-30T12:00:00.000Z',
    monthsLeft: 2,
    expectedMonths: 2,
  });
  const domain = {
    plotlines: [plot],
    stats: { security: 50 },
    state: { pendingActions: [old, newer] },
  };
  applyQueuedEngineProgress(domain, { tick: 5, rng: midRng });
  assert.equal(old.status, 'resolved');
  assert.equal(old.monthsLeft, 0);
  assert.equal(newer.monthsLeft, 1);
  assert.equal(newer.status, 'active');
});

test('UNRELATED на доске снимается пачкой и не держит очередь', () => {
  const plot = mystery({ relatedProcessIds: ['act_side', 'act_main'] });
  const side = process('act_side', { plotEngagement: 'UNRELATED', plotAligned: false });
  const main = process('act_main', { plotEngagement: 'DIRECT', plotAligned: true });
  const domain = { plotlines: [plot], state: { pendingActions: [side, main] } };
  const moved = rehomeUnrelatedOnDomain(domain, { tick: 8 });
  assert.equal(moved.length, 1);
  assert.equal(plot.relatedProcessIds.includes('act_side'), false);
  assert.equal(plot.relatedProcessIds.includes('act_main'), true);
  const due = collectProcessAdvanceBatch(domain);
  assert.ok(due.some((p) => p.id === 'act_side'));
  assert.ok(due.some((p) => p.id === 'act_main'));
});

test('отмена поручения закрывает пустую errand-нить', () => {
  const plot = mystery({ relatedProcessIds: ['act_side'] });
  const action = process('act_side');
  applyEngagement(action, 'UNRELATED');
  const domain = { plotlines: [plot], closedPlotlines: [], state: { pendingActions: [action] } };
  rehomeUnrelatedProcess(domain, action, { tick: 3 });
  assert.equal(domain.plotlines.some((p) => p.kind === 'errand'), true);
  action.status = 'revoked';
  const dropped = detachProcessFromPlots(domain, action, { tick: 3 });
  assert.equal(dropped.closedErrands.length, 1);
  assert.equal(domain.plotlines.some((p) => p.kind === 'errand'), false);
  assert.equal(domain.closedPlotlines.some((p) => p.kind === 'errand'), true);
});
