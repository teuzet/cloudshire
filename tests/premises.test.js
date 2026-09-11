import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  premiseAtIndex,
  revealPremise,
  revealNextPremise,
  revealedPremises,
} from '../src/game/premises.js';
import { createPlotline, normalizePlotlines } from '../src/game/plotlines.js';
import { applyEngagement } from '../src/game/plotAlign.js';
import { plotCardForPrompt } from '../src/game/freeform.js';
import { formatFocusedStoryForLoremaster } from '../src/game/loremaster.js';
import { threadCard, formatHeraldPrompt, buildHeraldContext } from '../src/game/herald.js';

function story(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    title: 'Пустые выгоны',
    synopsis: 'Стада редеют, три дальних выгона пусты',
    gravity: 'RUPTURE',
    depth: 0,
    maxDepth: 4,
    failCount: 0,
    threats: [],
    endings: [],
    hiddenPremises: ['стада вытеснила стая через трещину', 'старейшина нашёл следы и молчит'],
    revealedPremises: [],
    ...extra,
  };
}

// ────────────────────────── выбор пункта ──────────────────────────

test('судья указывает на пункт номером, и номер разрешается в текст', () => {
  const p = story();
  assert.equal(premiseAtIndex(p, 0), 'стада вытеснила стая через трещину');
  assert.equal(premiseAtIndex(p, 1), 'старейшина нашёл следы и молчит');
});

test('молчание судьи и мусор — это не раскрытие', () => {
  const p = story();
  assert.equal(premiseAtIndex(p, null), null);
  assert.equal(premiseAtIndex(p, ''), null);
  assert.equal(premiseAtIndex(p, 'третий'), null);
  assert.equal(premiseAtIndex(p, -1), null);
  assert.equal(premiseAtIndex(p, 7), null, 'за границей списка раскрывать нечего');
});

test('у истории без тайны раскрывать нечего', () => {
  const p = story({ hiddenPremises: [] });
  assert.equal(premiseAtIndex(p, 0), null);
  assert.equal(revealNextPremise(p), null);
});

// ─────────────────────────── перенос ───────────────────────────

test('раскрытие переносит пункт из скрытого в известное', () => {
  const p = story();
  assert.equal(revealPremise(p, 'старейшина нашёл следы и молчит'), 'старейшина нашёл следы и молчит');
  assert.deepEqual(p.hiddenPremises, ['стада вытеснила стая через трещину']);
  assert.deepEqual(p.revealedPremises, ['старейшина нашёл следы и молчит']);
});

test('пункт ищется по тексту, а не по номеру: список мог сдвинуться', () => {
  const p = story();
  revealPremise(p, 'стада вытеснила стая через трещину');
  // Номер 1 уехал на 0, но второе дело называло свой пункт текстом.
  assert.equal(revealPremise(p, 'старейшина  нашёл следы\nи молчит'), 'старейшина нашёл следы и молчит');
  assert.deepEqual(p.hiddenPremises, []);
  assert.equal(revealedPremises(p).length, 2);
});

test('чужой текст ничего не раскрывает', () => {
  const p = story();
  assert.equal(revealPremise(p, 'дарков угнали контрабандисты'), null);
  assert.equal(p.hiddenPremises.length, 2);
  assert.deepEqual(p.revealedPremises, []);
});

// ────────────────────────── карточка нити ──────────────────────────

test('раскрытое знание выживает нормализацию карточки', () => {
  const seeded = createPlotline({
    title: 'Пустые выгоны',
    kind: 'story',
    storyType: 'story',
    gravity: 'RUPTURE',
    hiddenPremises: ['стая пришла через трещину'],
  });
  assert.deepEqual(seeded.revealedPremises, [], 'новая нить начинает без раскрытого');
  revealPremise(seeded, 'стая пришла через трещину');
  const domain = { plotlines: [seeded], closedPlotlines: [] };
  normalizePlotlines(domain);
  assert.deepEqual(domain.plotlines[0].revealedPremises, ['стая пришла через трещину']);
  assert.deepEqual(domain.plotlines[0].hiddenPremises, []);
});

test('намеченный к раскрытию пункт держится только на DIRECT', () => {
  const action = {};
  applyEngagement(action, 'DIRECT', { premiseText: 'стая пришла через трещину' });
  assert.equal(action.premiseText, 'стая пришла через трещину');
  applyEngagement(action, 'RELEVANT', { premiseText: 'стая пришла через трещину', threatId: 't1' });
  assert.equal(action.premiseText, '', 'оборона по краям ничего не выясняет');
});

// ─────────────────────── кому можно говорить ───────────────────────

test('в карточке для промпта раскрытое и скрытое разведены', () => {
  const p = story();
  revealPremise(p, 'стада вытеснила стая через трещину');
  const card = plotCardForPrompt(p);
  assert.match(card, /Город это уже выяснил:\n- стада вытеснила стая через трещину/);
  assert.match(card, /hiddenPremises \(только тебе, в хронику не писать\):\n- старейшина/);
});

test('хранитель знаний отвечает по раскрытому прямо', () => {
  const p = story();
  revealPremise(p, 'стада вытеснила стая через трещину');
  const text = formatFocusedStoryForLoremaster(p);
  assert.match(text, /ГОРОД ЭТО УЖЕ ВЫЯСНИЛ/);
  assert.match(text, /стада вытеснила стая через трещину/);
  assert.doesNotMatch(text, /старейшина/, 'ещё скрытое хранителю не показывают вовсе');
});

test('жрец получает раскрытое как установленное', () => {
  const p = story();
  revealPremise(p, 'стада вытеснила стая через трещину');
  assert.deepEqual(threadCard(p, 10).established, ['стада вытеснила стая через трещину']);
  const prompt = formatHeraldPrompt(
    buildHeraldContext({ domain: { id: 'd1', state: {} }, plot: p, occasion: 'дело', day: 10 }),
  );
  assert.match(prompt, /Город это уже выяснил, и об этом ты говоришь как об установленном:/);
  assert.match(prompt, /стада вытеснила стая через трещину/);
});

test('нераскрытое жрецу не показывают', () => {
  const p = story();
  const prompt = formatHeraldPrompt(
    buildHeraldContext({ domain: { id: 'd1', state: {} }, plot: p, occasion: 'дело', day: 10 }),
  );
  assert.doesNotMatch(prompt, /стая через трещину/);
  assert.doesNotMatch(prompt, /Город это уже выяснил/);
});

// ───────────────────────── лестница судьи ─────────────────────────

test('первая ступень лестницы спрашивает про первопричину, а не про концовку', async () => {
  const { loadConfig } = await import('../src/config.js');
  const ins = loadConfig().agents.plotAlign.instructions;
  assert.match(ins, /Работает ли полный успех по первопричине/);
  assert.match(ins, /Достаточно ШАГА/);
  assert.match(ins, /Расследование первопричины — это DIRECT/);
  assert.doesNotMatch(ins, /сам поставить одну из концовок/, 'старый неисполнимый критерий убран');
});

test('судье сказано, что раскрытие необязательно', async () => {
  const { loadConfig } = await import('../src/config.js');
  const ins = loadConfig().agents.plotAlign.instructions;
  assert.match(ins, /ничего при этом не выясняя/);
  assert.match(ins, /revealsPremise ставь только тому, что дело выясняет своей работой/);
});
