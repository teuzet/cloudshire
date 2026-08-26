import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTruthGraph,
  judgeTruthGraph,
  formatTruthGraphForPrompt,
  formatMysteryGraphShapeForPrompt,
  formatMysteryMaskForPrompt,
  formatMysteryCausalContractForPrompt,
  applyEngineReveal,
  applySeedVisibility,
  pickMysteryGraphSize,
  pickMysteryGraphShape,
  mysteryPublicLeak,
  pickFrontierReveal,
  remainingHiddenNodeIds,
} from '../src/game/mysteryGraph.js';

function knowledgeOf(graph) {
  return Object.fromEntries(graph.nodes.map((n) => [n.id, n.knowledge]));
}

function linear4() {
  return {
    nodes: [
      { id: 'A', text: 'Цистерну перестали чистить.' },
      { id: 'B', text: 'В трубах скопился ил.' },
      { id: 'C', text: 'Ночами вода гудит.' },
      { id: 'X', text: 'Ярус слышит знамение.' },
    ],
    edges: [
      { from: 'A', to: 'B', reason: 'ил растёт без чистки' },
      { from: 'B', to: 'C', reason: 'ил сжимает поток' },
      { from: 'C', to: 'X', reason: 'гул доходит до яруса' },
    ],
  };
}

function linear5() {
  return {
    nodes: [
      { id: 'A', text: 'Цистерну перестали чистить.' },
      { id: 'B', text: 'В трубах скопился ил.' },
      { id: 'C', text: 'Ночами вода гудит.' },
      { id: 'D', text: 'Гул доходит до нижнего яруса.' },
      { id: 'X', text: 'Город принимает гул за знамение.' },
    ],
    edges: [
      { from: 'A', to: 'B', reason: 'ил растёт без чистки' },
      { from: 'B', to: 'C', reason: 'ил сжимает поток' },
      { from: 'C', to: 'D', reason: 'гул идёт вниз' },
      { from: 'D', to: 'X', reason: 'слух расползается' },
    ],
  };
}

function linearSide(target = 'B') {
  const g = linear4();
  g.nodes.push({ id: 'E', text: 'Ночной сброс с красилен.' });
  g.edges.push({ from: 'E', to: target, reason: 'добавляет причину' });
  return g;
}

test('нормализация не берёт маску агента', () => {
  const g = normalizeTruthGraph({
    ...linear4(),
    knowledge: linear4().nodes.map((n) => ({ id: n.id, status: 'observed' })),
  });
  assert.equal(g.nodes.length, 4);
  assert.equal(g.edges.length, 3);
  assert.ok(g.nodes.every((n) => n.knowledge === 'hidden'));
  assert.equal(judgeTruthGraph({ title: 'нет' }), 'missing_graph');
});

test('промпт показывает статусы после маски системы', () => {
  const g = applySeedVisibility(normalizeTruthGraph(linear4()), { shape: 'linear_4' });
  const text = formatTruthGraphForPrompt(g);
  assert.match(text, /A \[скрыто\]/);
  assert.match(text, /X \[замечено\]/);
  assert.match(text, /A → B/);
  assert.equal(text.includes('Гипотеза'), false);
});

test('старые misread на узле читаются как observed, гипотезы нет', () => {
  const raw = linear4();
  raw.nodes[3].knowledge = 'misread';
  raw.hypothesis = 'Это знамение.';
  const g = normalizeTruthGraph(raw);
  assert.equal(g.nodes[3].knowledge, 'observed');
  assert.equal(g.hypothesis, undefined);
});

test('маску можно только повышать, движок открывает фронтир или всё', () => {
  const g = applySeedVisibility(normalizeTruthGraph(linear4()), { shape: 'linear_4' });
  applyEngineReveal(g, { reveal: 'partial', rng: () => 0 });
  assert.equal(g.nodes.find((n) => n.id === 'C').knowledge, 'observed');
  assert.equal(g.nodes.find((n) => n.id === 'A').knowledge, 'hidden');
  applyEngineReveal(g, { reveal: 'full' });
  assert.ok(g.nodes.every((n) => n.knowledge === 'resolved'));
  assert.ok(g.edges.every((e) => e.knowledge === 'resolved'));
});

test('провал не раскрывает граф', () => {
  const g = applySeedVisibility(normalizeTruthGraph(linear4()), { shape: 'linear_4' });
  applyEngineReveal(g, { reveal: 'full', ending: 'fail' });
  assert.equal(g.nodes[0].knowledge, 'hidden');
  assert.equal(g.nodes[3].knowledge, 'observed');
});

test('жребий формы: linear_4 и linear_side по 50%, linear_5 выключен', () => {
  const cfg = {
    mysteryGraph: {
      shapes: [
        { id: 'linear_4', weight: 1 },
        { id: 'linear_5', weight: 0 },
        { id: 'linear_side', weight: 1 },
      ],
    },
  };
  assert.equal(pickMysteryGraphShape(cfg, () => 0), 'linear_4');
  assert.equal(pickMysteryGraphShape(cfg, () => 0.49), 'linear_4');
  assert.equal(pickMysteryGraphShape(cfg, () => 0.5), 'linear_side');
  assert.equal(pickMysteryGraphShape(cfg, () => 0.99), 'linear_side');
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    assert.notEqual(pickMysteryGraphShape(cfg, () => r), 'linear_5');
  }
  assert.equal(pickMysteryGraphSize(cfg, () => 0, 'linear_4'), 4);
  assert.equal(pickMysteryGraphSize(cfg, () => 0, 'linear_5'), 5);
  assert.equal(pickMysteryGraphSize(cfg, () => 0, 'linear_side'), 5);
});

test('маска в промпте говорит, вокруг чего строить завязку', () => {
  assert.match(formatMysteryGraphShapeForPrompt('linear_4'), /A → B → C → X/);
  assert.match(formatMysteryGraphShapeForPrompt('linear_5'), /A → B → C → D → X/);
  assert.match(formatMysteryGraphShapeForPrompt('linear_side'), /A → B → C → X/);
  assert.match(formatMysteryGraphShapeForPrompt('linear_side'), /ПРИЧИНА E/);
  assert.match(formatMysteryMaskForPrompt('linear_4'), /только X/);
  assert.match(formatMysteryMaskForPrompt('linear_5'), /только X/);
  assert.match(formatMysteryMaskForPrompt('linear_side', { sideOpen: false }), /только X/);
  assert.match(formatMysteryMaskForPrompt('linear_side', { sideOpen: true }), /боковая причина/);
  assert.match(formatMysteryMaskForPrompt('linear_4'), /ТОЛЬКО ИЗВЕСТНАЯ ЧАСТЬ ТАЙНЫ/);
  const contract = formatMysteryCausalContractForPrompt();
  assert.match(contract, /КОНТРАКТ УЗЛА/);
  assert.match(contract, /откуда знает/);
  assert.match(contract, /Магия не склеивает цепь/);
  assert.match(formatMysteryGraphShapeForPrompt('linear_4'), /КОНТРАКТ УЗЛА/);
  assert.match(formatMysteryGraphShapeForPrompt('linear_side'), /КОНТРАКТ УЗЛА/);
});

test('публичный текст не должен тащить скрытый узел', () => {
  const g = applySeedVisibility(normalizeTruthGraph(linear4()), { shape: 'linear_4' });
  assert.equal(mysteryPublicLeak(g, ['Ярус слышит знамение по ночам.']), null);
  assert.equal(
    mysteryPublicLeak(g, ['Цистерну перестали чистить, поэтому ярус слышит знамение.']),
    'A',
  );
});

test('linear_4 / linear_5 — цепь; linear_side — причина в B или C', () => {
  assert.equal(judgeTruthGraph(linear4(), { shape: 'linear_4' }), null);
  assert.equal(judgeTruthGraph(linear4(), { shape: 'linear_5' }), 'thin_graph');
  assert.equal(judgeTruthGraph(linear4(), { shape: 'linear_side' }), 'thin_graph');
  assert.equal(judgeTruthGraph(linear5(), { shape: 'linear_5' }), null);
  assert.equal(judgeTruthGraph(linear5(), { shape: 'linear_4' }), 'fat_graph');
  assert.equal(judgeTruthGraph(linearSide('B'), { shape: 'linear_side' }), null);
  assert.equal(judgeTruthGraph(linearSide('C'), { shape: 'linear_side' }), null);
  assert.equal(judgeTruthGraph(linearSide('B'), { shape: 'linear_4' }), 'fat_graph');

  const consequence = linear4();
  consequence.nodes.push({ id: 'E', text: 'побочный эффект' });
  consequence.edges.push({ from: 'B', to: 'E', reason: 'следствие' });
  assert.equal(judgeTruthGraph(consequence, { shape: 'linear_side' }), 'wrong_shape');

  assert.equal(judgeTruthGraph(linearSide('A'), { shape: 'linear_side' }), 'wrong_shape');
  assert.equal(judgeTruthGraph(linearSide('X'), { shape: 'linear_side' }), 'wrong_shape');
});

test('система открывает последний узел цепи и иногда E', () => {
  const four = applySeedVisibility(normalizeTruthGraph(linear4()), { shape: 'linear_4' });
  assert.deepEqual(knowledgeOf(four), { A: 'hidden', B: 'hidden', C: 'hidden', X: 'observed' });

  const five = applySeedVisibility(normalizeTruthGraph(linear5()), { shape: 'linear_5' });
  assert.deepEqual(knowledgeOf(five), {
    A: 'hidden',
    B: 'hidden',
    C: 'hidden',
    D: 'hidden',
    X: 'observed',
  });

  const sideClosed = applySeedVisibility(normalizeTruthGraph(linearSide('C')), {
    shape: 'linear_side',
    sideOpen: false,
  });
  assert.deepEqual(knowledgeOf(sideClosed), {
    A: 'hidden',
    B: 'hidden',
    C: 'hidden',
    X: 'observed',
    E: 'hidden',
  });

  const sideOpen = applySeedVisibility(normalizeTruthGraph(linearSide('C')), {
    shape: 'linear_side',
    sideOpen: true,
  });
  assert.deepEqual(knowledgeOf(sideOpen), {
    A: 'hidden',
    B: 'hidden',
    C: 'hidden',
    X: 'observed',
    E: 'observed',
  });
});

test('фронтир: ближайшая причина известного; ветка E конкурирует, когда открыт ребёнок', () => {
  const four = applySeedVisibility(normalizeTruthGraph(linear4()), { shape: 'linear_4' });
  assert.equal(pickFrontierReveal(four, () => 0).nodeId, 'C');
  applyEngineReveal(four, { reveal: 'partial', openedNodes: ['C'], openedEdges: [{ from: 'C', to: 'X' }] });
  assert.equal(four.nodes.find((n) => n.id === 'C').knowledge, 'observed');
  assert.equal(pickFrontierReveal(four, () => 0).nodeId, 'B');

  const side = applySeedVisibility(normalizeTruthGraph(linearSide('C')), { shape: 'linear_side' });
  applyEngineReveal(side, { reveal: 'partial', openedNodes: ['C'], openedEdges: [{ from: 'C', to: 'X' }] });
  const ids = new Set();
  ids.add(pickFrontierReveal(side, () => 0).nodeId);
  ids.add(pickFrontierReveal(side, () => 0.99).nodeId);
  assert.ok(ids.has('B'));
  assert.ok(ids.has('E'));
  assert.equal(remainingHiddenNodeIds(side, ['B', 'E', 'A']).length, 0);
});
