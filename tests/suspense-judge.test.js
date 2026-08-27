import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { plotConfig } from '../src/game/plotlines.js';
import { formatSuspenseJudgeCase, judgeSuspenseSeed, SUSPENSE_JUDGE_CODES } from '../src/game/suspenseJudge.js';
import { parseJudgeVerdict, literaryJudgeAccepts } from '../src/game/mysteryJudge.js';

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

test('пакет саспенса: бюджет hiddenPremises, синопсис, closeWhen, без лора города', () => {
  const text = formatSuspenseJudgeCase({
    seed: {
      depth: 1,
      gravity: 33,
      tonePrimary: 'horror',
      source: 'economic',
      situation: 'opportunity',
      dynamic: 'drift',
    },
    tags: [{ tagName: 'Ужас' }, { tagName: 'Дрейф' }],
    draft: {
      title: 'Чёрная прибыль',
      synopsis: 'На нижней террасе продают дешёвый чёрный порошок для чернил.',
      entry: 'У трёх переписчиков после работы с порошком трещины на пальцах.',
      closeWhen: 'Опасный порошок изъят из городского оборота.',
      mootWhen: 'Все запасы порошка высохли и больше не дают следа на бумаге.',
      hiddenPremises: ['Порошок из налёта пещеры вызывает ночное кровотечение.'],
    },
  });
  assert.match(text, /depth: 1/);
  assert.match(text, /Бюджет hiddenPremises: от 0 до 1/);
  assert.match(text, /gravity \(масштаб последствий\): 33/);
  assert.match(text, /Чёрная прибыль/);
  assert.match(text, /closeWhen: Опасный порошок/);
  assert.match(text, /mootWhen: Все запасы/);
  assert.match(text, /Порошок из налёта/);
  assert.equal(text.includes('летающий остров'), false);
});

test('судья саспенса: Luna FAIL и PASS, без Terra', async () => {
  const fail = runtimeQueue([
    {
      verdict: 'FAIL',
      issues: [{ code: 'NO_CONFLICT', location: 'synopsis', reason: 'нет ставок' }],
      summary: 'витрина',
    },
  ]);
  const rejected = await judgeSuspenseSeed({ runtime: fail.runtime, caseText: 'пакет' });
  assert.equal(rejected.verdict, 'FAIL');
  assert.equal(literaryJudgeAccepts(rejected.verdict), false);
  assert.deepEqual(fail.seen, ['suspenseJudge']);

  const pass = runtimeQueue([{ verdict: 'PASS', issues: [], summary: 'есть конфликт' }]);
  const accepted = await judgeSuspenseSeed({ runtime: pass.runtime, caseText: 'пакет' });
  assert.equal(accepted.verdict, 'PASS');
  assert.equal(literaryJudgeAccepts(accepted.verdict), true);
  assert.deepEqual(pass.seen, ['suspenseJudge']);
});

test('коды саспенса: неизвестный код становится OTHER', () => {
  const parsed = parseJudgeVerdict(
    {
      verdict: 'FAIL',
      issues: [{ code: 'NO_VIBES', reason: 'слабо' }],
      summary: 'слабо',
    },
    SUSPENSE_JUDGE_CODES,
  );
  assert.equal(parsed.issues[0].code, 'OTHER');
  const known = parseJudgeVerdict(
    {
      verdict: 'FAIL',
      issues: [{ code: 'HIDDEN_OVER_BUDGET', location: 'hiddenPremises', reason: 'три посылки при depth 1' }],
      summary: 'бюджет',
    },
    SUSPENSE_JUDGE_CODES,
  );
  assert.equal(known.issues[0].code, 'HIDDEN_OVER_BUDGET');
});

test('конфиг: три попытки судьи саспенса и агент Luna', () => {
  const config = loadConfig();
  const cfg = plotConfig(config);
  assert.equal(cfg.suspense.judgeAttempts, 3);
  assert.equal(config.agents.suspenseJudge.model, 'gpt-5.6-luna');
  assert.equal(config.agents.suspenseJudge.canon.length, 0);
});
