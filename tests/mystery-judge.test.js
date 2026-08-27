import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { plotConfig, formatMysteryAxesForPrompt } from '../src/game/plotlines.js';
import {
  parseMysteryJudgeVerdict,
  formatMysteryJudgeCase,
  judgeMysteryCascade,
  formatMysteryPresentationJudgeCase,
  judgeMysteryPresentation,
  formatJudgeRevisionForPrompt,
  literaryJudgeAccepts,
} from '../src/game/mysteryJudge.js';

function graph() {
  return {
    nodes: [
      { id: 'A', text: 'Цистерну перестали чистить.', knowledge: 'hidden' },
      { id: 'B', text: 'В трубах скопился ил.', knowledge: 'hidden' },
      { id: 'C', text: 'Ночами вода гудит.', knowledge: 'hidden' },
      { id: 'X', text: 'Ярус слышит знамение.', knowledge: 'observed' },
    ],
    edges: [
      { from: 'A', to: 'B', reason: 'ил растёт без чистки', knowledge: 'hidden' },
      { from: 'B', to: 'C', reason: 'ил сжимает поток', knowledge: 'hidden' },
      { from: 'C', to: 'X', reason: 'гул доходит до яруса', knowledge: 'hidden' },
    ],
  };
}

test('вердикт PASS чистит issues, FAIL без issues становится OTHER', () => {
  const pass = parseMysteryJudgeVerdict({
    verdict: 'pass',
    issues: [{ code: 'OTHER', reason: 'не должно остаться' }],
    summary: 'ок',
  });
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.issues.length, 0);
  const fail = parseMysteryJudgeVerdict({ verdict: 'FAIL', issues: [], summary: 'дырявое ребро' });
  assert.equal(fail.verdict, 'FAIL');
  assert.equal(fail.issues[0].code, 'OTHER');
  const bad = parseMysteryJudgeVerdict({ verdict: 'maybe' });
  assert.equal(bad.verdict, 'UNCERTAIN');
});

test('пакет judge компактный: якоря и граф, без описания города', () => {
  const text = formatMysteryJudgeCase({
    tags: [
      { groupId: 'type', tagName: 'саботаж', about: 'несущую жизнь ломают нарочно' },
      { groupId: 'association', tagName: 'слой' },
    ],
    anchors: [{ kind: 'place', name: 'Соляной Колокол', about: 'колокол у площади' }],
    graphShape: 'linear_4',
    graph: graph(),
    draft: {
      observedFacts: ['Колокол звонил сам.', 'После удара звон не стих.'],
      resolutionFacts: ['Кто трогал язык колокола', 'Почему звон не затих'],
      asksSequel: false,
      newCharacters: [{ name: 'Эрвен', role: 'литейщик', about: 'держит артель' }],
    },
  });
  assert.match(text, /ТИП: саботаж/);
  assert.match(text, /about: несущую жизнь/);
  assert.match(text, /Соляной Колокол/);
  assert.match(text, /Эрвен/);
  assert.match(text, /Ярус слышит знамение/);
  assert.match(text, /observedFacts:/);
  assert.match(text, /Колокол звонил сам/);
  assert.match(text, /resolutionFacts:/);
  assert.match(text, /язык колокола/);
  assert.equal(text.includes('летающий остров'), false);
  assert.equal(text.includes('domain.description'), false);
  assert.equal(text.includes('closeWhen'), false);
});

function runtimeQueue(replies) {
  const seen = [];
  return {
    seen,
    runtime: {
      async run({ agentId, tools }) {
        seen.push(agentId);
        const reply = replies.shift();
        await tools[0].handler(reply);
      },
    },
  };
}

test('каскад: Luna PASS всё равно зовёт Terra', async () => {
  const { runtime, seen } = runtimeQueue([
    { verdict: 'PASS', issues: [], summary: 'ок' },
    { verdict: 'PASS', issues: [], summary: 'состоятельно' },
  ]);
  const out = await judgeMysteryCascade({ runtime, caseText: 'пакет' });
  assert.equal(out.accepted, true);
  assert.deepEqual(seen, ['mysteryJudge', 'mysteryJudgeTerra']);
  assert.equal(out.terra.verdict, 'PASS');
});

test('каскад: Luna FAIL отклоняет без Terra', async () => {
  const { runtime, seen } = runtimeQueue([
    {
      verdict: 'FAIL',
      issues: [{ code: 'BROKEN_CAUSAL_EDGE', location: 'C → X', reason: 'нет механизма' }],
      summary: 'ребро',
    },
  ]);
  const out = await judgeMysteryCascade({ runtime, caseText: 'пакет' });
  assert.equal(out.accepted, false);
  assert.deepEqual(seen, ['mysteryJudge']);
});

test('каскад: Luna UNCERTAIN и Terra PASS принимает', async () => {
  const { runtime, seen } = runtimeQueue([
    { verdict: 'UNCERTAIN', issues: [], summary: 'спорно' },
    { verdict: 'PASS', issues: [], summary: 'состоятельно' },
  ]);
  const out = await judgeMysteryCascade({ runtime, caseText: 'пакет' });
  assert.equal(out.accepted, true);
  assert.deepEqual(seen, ['mysteryJudge', 'mysteryJudgeTerra']);
});

test('каскад: Terra UNCERTAIN считается FAIL', async () => {
  const { runtime, seen } = runtimeQueue([
    { verdict: 'UNCERTAIN', issues: [], summary: 'спорно' },
    { verdict: 'UNCERTAIN', issues: [], summary: 'мало данных' },
  ]);
  const out = await judgeMysteryCascade({ runtime, caseText: 'пакет' });
  assert.equal(out.accepted, false);
  assert.deepEqual(seen, ['mysteryJudge', 'mysteryJudgeTerra']);
});

test('каскад: Luna PASS и Terra FAIL отклоняет', async () => {
  const { runtime, seen } = runtimeQueue([
    { verdict: 'PASS', issues: [], summary: 'ок' },
    {
      verdict: 'FAIL',
      issues: [{ code: 'IMPLAUSIBLE_ACTION', location: 'B', reason: 'поступок только ради следующего узла' }],
      summary: 'авторский механизм',
    },
  ]);
  const out = await judgeMysteryCascade({ runtime, caseText: 'пакет' });
  assert.equal(out.accepted, false);
  assert.deepEqual(seen, ['mysteryJudge', 'mysteryJudgeTerra']);
});

test('конфиг каскада и агенты judge на месте', () => {
  const config = loadConfig();
  const cfg = plotConfig(config);
  assert.equal(cfg.mysteryGraph.judgeAttempts, 3);
  assert.equal(cfg.mysteryGraph.generateTries, 6);
  assert.equal(cfg.mysteryGraph.presentationTries, 3);
  assert.equal(cfg.suspense.judgeAttempts, 3);
  assert.equal(config.agents.mysteryJudge.model, 'gpt-5.6-luna');
  assert.equal(config.agents.mysteryJudgeTerra.model, 'gpt-5.6-terra');
  assert.equal(config.agents.mysteryPresentation.model, 'gpt-5.6-luna');
  assert.equal(config.agents.mysteryPresentationJudge.model, 'gpt-5.6-luna');
  assert.equal(config.agents.suspenseJudge.model, 'gpt-5.6-luna');
  assert.equal(config.agents.mysteryStart.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryPresentation.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryPresentationJudge.reasoningEffort, undefined);
  assert.equal(config.agents.suspenseJudge.reasoningEffort, undefined);
});

test('ассоциация в промпте — слабый импульс', () => {
  const formatted = formatMysteryAxesForPrompt([
    { groupId: 'association', groupName: 'Ассоциативное поле', tagName: 'остаток' },
    { groupId: 'type', groupName: 'Тип тайны', tagName: 'заговор', about: 'скрытая воля' },
  ]);
  assert.match(formatted, /ТИП ТАЙНЫ \(обязателен\): заговор/);
  assert.match(formatted, /очень слабый импульс/);
  assert.equal(formatted.includes('должно читаться'), false);
});

test('литературный судья принимает PASS и UNCERTAIN, только FAIL гоняет на доработку', () => {
  assert.equal(literaryJudgeAccepts('PASS'), true);
  assert.equal(literaryJudgeAccepts('UNCERTAIN'), true);
  assert.equal(literaryJudgeAccepts('FAIL'), false);
  assert.equal(literaryJudgeAccepts(null), true);
});

test('пакет подачи: известные узлы отдельно от скрытых, есть синопсис и хроника', () => {
  const text = formatMysteryPresentationJudgeCase({
    title: 'Перекос под крышами',
    graph: graph(),
    observedFacts: ['Ярус слышит знамение.'],
    resolutionFacts: ['Почему гудит вода'],
    presentation: {
      synopsis: 'Ярус слышит ночной гул в трубах.',
      entry: 'В ярусе ночами гудит вода. Откуда звук — неясно.',
      closeWhen: 'Установлен источник гула.',
      mootWhen: 'Гул сам стих и больше не возвращается.',
    },
  });
  assert.match(text, /ИЗВЕСТНЫЕ УЗЛЫ/);
  assert.match(text, /Ярус слышит знамение/);
  assert.match(text, /СКРЫТЫЕ УЗЛЫ/);
  assert.match(text, /Цистерну перестали чистить/);
  assert.match(text, /synopsis: Ярус слышит ночной гул/);
  assert.match(text, /entry: В ярусе ночами/);
  assert.match(text, /closeWhen: Установлен источник/);
  assert.match(text, /mootWhen: Гул сам стих/);
  assert.equal(text.includes('летающий остров'), false);
});

test('заметки доработки содержат ошибки судьи и предыдущий текст', () => {
  const notes = formatJudgeRevisionForPrompt({
    mechanical: null,
    judge: {
      summary: 'синопсис выдаёт виновного',
      issues: [{ code: 'MASK_LEAK', location: 'synopsis', reason: 'назван Фавор' }],
    },
    previous: {
      synopsis: 'Фавор заставил помощника.',
      entry: 'Крыши провисли.',
      closeWhen: 'Узнать всё.',
      mootWhen: '',
    },
  });
  assert.match(notes, /ДОРАБОТКА/);
  assert.match(notes, /MASK_LEAK/);
  assert.match(notes, /Фавор заставил/);
  assert.match(notes, /mootWhen: \(пусто\)/);
});

test('литературный судья подачи зовёт mysteryPresentationJudge', async () => {
  const { runtime, seen } = runtimeQueue([
    {
      verdict: 'FAIL',
      issues: [{ code: 'MASK_LEAK', location: 'synopsis', reason: 'назван виновный' }],
      summary: 'утечка',
    },
  ]);
  const out = await judgeMysteryPresentation({ runtime, caseText: 'пакет' });
  assert.equal(out.verdict, 'FAIL');
  assert.equal(out.issues[0].code, 'MASK_LEAK');
  assert.deepEqual(seen, ['mysteryPresentationJudge']);
});
