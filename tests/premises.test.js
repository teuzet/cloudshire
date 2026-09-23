import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  premiseAtIndex,
  revealPremise,
  revealAnswer,
  revealedPremises,
  hiddenAnswer,
  revealedAnswer,
  answerDepthTarget,
  answerOpen,
  speechHintsHidden,
} from '../src/game/premises.js';
import { createPlotline, normalizePlotlines } from '../src/game/plotlines.js';
import { applyEngagement, judgeProcessAlignment } from '../src/game/plotAlign.js';
import { plotCardForPrompt } from '../src/game/freeform.js';
import { formatFocusedStoryForLoremaster } from '../src/game/loremaster.js';
import { threadCard, formatHeraldPrompt, buildHeraldContext } from '../src/game/herald.js';

const ANSWER = 'стада вытеснила стая через трещину';
const TRACKS = 'на выгонах остались следы крупных лап';
const ELDER = 'старейшина видел это раньше и молчит';

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
    hiddenAnswer: ANSWER,
    hiddenPremises: [TRACKS, ELDER],
    revealedAnswer: '',
    revealedPremises: [],
    ...extra,
  };
}

// ────────────────────────── выбор подступа ──────────────────────────

test('судья указывает на подступ номером, и номер разрешается в текст', () => {
  const p = story();
  assert.equal(premiseAtIndex(p, 0), TRACKS);
  assert.equal(premiseAtIndex(p, 1), ELDER);
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
  const p = story({ hiddenAnswer: '', hiddenPremises: [] });
  assert.equal(premiseAtIndex(p, 0), null);
  assert.equal(revealAnswer(p), null);
});

// ─────────────────────────── перенос ───────────────────────────

test('раскрытие переносит подступ из скрытого в известное', () => {
  const p = story();
  assert.equal(revealPremise(p, ELDER), ELDER);
  assert.deepEqual(p.hiddenPremises, [TRACKS]);
  assert.deepEqual(p.revealedPremises, [ELDER]);
  assert.equal(hiddenAnswer(p), ANSWER, 'подступ сам по себе сердцевину не отдаёт');
});

test('подступ ищется по тексту, а не по номеру: список мог сдвинуться', () => {
  const p = story();
  revealPremise(p, TRACKS);
  // Номер 1 уехал на 0, но второе дело называло свой подступ текстом.
  assert.equal(revealPremise(p, 'старейшина  видел это раньше\nи молчит'), ELDER);
  assert.deepEqual(p.hiddenPremises, []);
  assert.equal(revealedPremises(p).length, 2);
});

test('чужой текст ничего не раскрывает', () => {
  const p = story();
  assert.equal(revealPremise(p, 'дарков угнали контрабандисты'), null);
  assert.equal(p.hiddenPremises.length, 2);
  assert.deepEqual(p.revealedPremises, []);
});

test('разгадка переезжает в раскрытое целиком и только раз', () => {
  const p = story();
  assert.equal(revealAnswer(p), ANSWER);
  assert.equal(hiddenAnswer(p), '');
  assert.equal(revealedAnswer(p), ANSWER);
  assert.equal(revealAnswer(p), null, 'разгадывать дважды нечего');
});

// ──────────────────────── доступ к сердцевине ────────────────────────

test('целевая глубина считается от масштаба истории', () => {
  assert.equal(answerDepthTarget(story({ maxDepth: 4 })), 2.4);
  assert.equal(answerDepthTarget(story({ maxDepth: 1.5 })), 0.9);
  assert.equal(answerDepthTarget(story({ maxDepth: 0 })), 0);
});

test('пока подступы целы и работа не набрана, сердцевина закрыта', () => {
  const p = story({ depth: 2 });
  assert.equal(answerOpen(p), false);
});

test('набранная глубина открывает сердцевину', () => {
  assert.equal(answerOpen(story({ depth: 2.4 })), true);
  assert.equal(answerOpen(story({ depth: 2.39 })), false);
});

test('крит открывает сердцевину досрочно', () => {
  const p = story({ depth: 0 });
  assert.equal(answerOpen(p, { finish: 'crit' }), true);
  assert.equal(answerOpen(p, { finish: 'ok' }), false);
});

test('когда подступы исчерпаны, сердцевина открыта сама', () => {
  const p = story({ depth: 0, hiddenPremises: [] });
  assert.equal(answerOpen(p), true);
});

test('у истории без разгадки открывать нечего', () => {
  const p = story({ hiddenAnswer: '', hiddenPremises: [] });
  assert.equal(answerOpen(p, { finish: 'crit' }), false);
});

// ────────────────────────── карточка нити ──────────────────────────

test('раскрытое знание выживает нормализацию карточки', () => {
  const seeded = createPlotline({
    title: 'Пустые выгоны',
    kind: 'story',
    storyType: 'story',
    gravity: 'RUPTURE',
    hiddenAnswer: ANSWER,
    hiddenPremises: [TRACKS],
  });
  assert.deepEqual(seeded.revealedPremises, [], 'новая нить начинает без раскрытого');
  assert.equal(seeded.hiddenAnswer, ANSWER);
  revealPremise(seeded, TRACKS);
  revealAnswer(seeded);
  const domain = { plotlines: [seeded], closedPlotlines: [] };
  normalizePlotlines(domain);
  assert.deepEqual(domain.plotlines[0].revealedPremises, [TRACKS]);
  assert.deepEqual(domain.plotlines[0].hiddenPremises, []);
  assert.equal(domain.plotlines[0].revealedAnswer, ANSWER);
  assert.equal(domain.plotlines[0].hiddenAnswer, '');
});

test('намеченное к раскрытию держится только на DIRECT', () => {
  const action = {};
  applyEngagement(action, 'DIRECT', { premiseText: TRACKS, reachesAnswer: true });
  assert.equal(action.premiseText, TRACKS);
  assert.equal(action.reachesAnswer, true);
  applyEngagement(action, 'RELEVANT', { premiseText: TRACKS, reachesAnswer: true, threatId: 't1' });
  assert.equal(action.premiseText, '', 'оборона по краям ничего не выясняет');
  assert.equal(action.reachesAnswer, false);
});

// ─────────────────────── кому можно говорить ───────────────────────

test('в карточке для промпта раскрытое и скрытое разведены', () => {
  const p = story();
  revealPremise(p, TRACKS);
  const card = plotCardForPrompt(p);
  assert.match(card, new RegExp(`Город это уже выяснил:\\n- ${TRACKS}`));
  assert.match(card, /Скрыто от города \(только тебе, в хронику не писать\):/);
  assert.match(card, new RegExp(`- разгадка: ${ANSWER}`));
  assert.match(card, /- подступ: старейшина/);
});

test('разгаданное перестаёт быть секретом и в карточке', () => {
  const p = story({ hiddenPremises: [] });
  revealAnswer(p);
  const card = plotCardForPrompt(p);
  assert.match(card, new RegExp(`Город разгадал: ${ANSWER}`));
  assert.doesNotMatch(card, /в хронику не писать/);
});

test('хранитель знаний отвечает по раскрытому прямо', () => {
  const p = story();
  revealPremise(p, TRACKS);
  revealAnswer(p);
  const text = formatFocusedStoryForLoremaster(p);
  assert.match(text, /ГОРОД ЭТО УЖЕ ВЫЯСНИЛ/);
  assert.match(text, new RegExp(`- разгадка: ${ANSWER}`));
  assert.match(text, new RegExp(TRACKS));
  assert.doesNotMatch(text, /старейшина/, 'ещё скрытое хранителю не показывают вовсе');
});

test('жрец получает раскрытое как установленное', () => {
  const p = story();
  revealPremise(p, TRACKS);
  revealAnswer(p);
  assert.deepEqual(threadCard(p, 10).established, [`разгадка: ${ANSWER}`, TRACKS]);
  const prompt = formatHeraldPrompt(
    buildHeraldContext({ domain: { id: 'd1', state: {} }, plot: p, occasion: 'дело', day: 10 }),
  );
  assert.match(prompt, /Город это уже выяснил, и об этом ты говоришь как об установленном:/);
  assert.match(prompt, new RegExp(ANSWER));
});

test('нераскрытое жрецу не показывают', () => {
  const p = story();
  const prompt = formatHeraldPrompt(
    buildHeraldContext({ domain: { id: 'd1', state: {} }, plot: p, occasion: 'дело', day: 10 }),
  );
  assert.doesNotMatch(prompt, /стая через трещину/);
  assert.doesNotMatch(prompt, /следы крупных лап/);
  assert.doesNotMatch(prompt, /Город это уже выяснил/);
});

test('речь не может сама назвать скрытую причину даже отрицанием', () => {
  const p = {
    title: 'Сочение',
    synopsis: 'Из коры верхних развилок течёт густая тёмная смола, у смолокуров немеют пальцы.',
    hiddenAnswer: 'Мелкие паразитические насекомые выходят из-под коры для спаривания.',
    hiddenPremises: ['В старой развилке видны пустые узкие ходы и тела мелких насекомых.'],
  };
  assert.equal(
    speechHintsHidden(
      p,
      'Причину мы пока не установили. О насекомых или иной живности там ничего не знаем.',
    ),
    true,
  );
  assert.equal(
    speechHintsHidden(p, 'Это густая тёмная смола из коры. Причину мы пока не установили.'),
    false,
  );
  assert.equal(
    speechHintsHidden(
      p,
      'О насекомых достоверно ничего не знаем.',
      { alreadySaid: 'это насекомые?' },
    ),
    false,
    'покровитель сам назвал кандидата — повторить можно',
  );
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

test('судья по каждой беде возвращает blocked и why', async () => {
  const plot = createPlotline({ title: 'Зов', type: 'story', cause: 'хищник на склоне' });
  plot.threats = [
    { id: 't1', text: 'Беженцы открывают северные ворота', status: 'live' },
    { id: 't2', text: 'Вылазка к логову с порохом', status: 'live' },
    { id: 't-gone', text: 'Старая беда', status: 'cancelled' },
  ];
  const process = { id: 'd1', summary: 'Впустить людей и запереть северные ворота' };
  const runtime = {
    async run(opts) {
      await opts.tools[0].handler({
        relation: 'RELEVANT',
        threats: [
          { id: 't1', blocked: true, why: 'Толпы у створов больше нет.' },
          { id: 't2', blocked: false, why: 'Вылазка к логову этим делом не отменена.' },
          { id: 'чужой', blocked: true, why: 'Этой беды нет.' },
        ],
        causesThreatId: 't2',
      });
    },
  };
  const engagement = await judgeProcessAlignment({
    runtime,
    domain: { id: 'd' },
    process,
    plot,
  });
  assert.equal(engagement, 'RELEVANT');
  assert.deepEqual(process.threatIds, ['t1']);
  assert.deepEqual(process.threatVerdicts, [
    { id: 't1', blocked: true, why: 'Толпы у створов больше нет.' },
    { id: 't2', blocked: false, why: 'Вылазка к логову этим делом не отменена.' },
  ]);
});

test('судье сказано, что раскрытие необязательно и что подступы независимы', async () => {
  const { loadConfig } = await import('../src/config.js');
  const ins = loadConfig().agents.plotAlign.instructions;
  assert.match(ins, /ничего при этом не выясняя/);
  assert.match(ins, /Подступы независимы, и очереди между ними нет/);
  assert.match(ins, /uncoversPremise и reachesAnswer ставь только тому, что дело выясняет своей работой/);
  assert.match(ins, /Дойдёт ли дело до разгадки, решаешь не ты/);
});
