import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTrailingUnansweredNews,
  shouldAskPatronPresence,
  shouldRunSteward,
  markPatronPresenceAsked,
  clearPatronPresenceAsked,
  runOfficerAct,
} from '../src/game/steward.js';
import { chronicleEntries } from '../src/game/models.js';

function news(n) {
  return Array.from({ length: n }, () => ({ role: 'assistant', kind: 'tick_news' }));
}

const cfg = { tick: { steward: { loseAfterLetters: 2, afterSilentMonths: 3 } } };

test('молчание считает только письма месяца до ответа игрока', () => {
  assert.equal(countTrailingUnansweredNews(news(2)), 2);
  assert.equal(
    countTrailingUnansweredNews([...news(3), { role: 'user', content: 'я здесь' }, ...news(1)]),
    1,
  );
});

test('стюард молчит первые три письма и включается с четвёртого месяца', () => {
  const domain = (silent) => ({
    characters: [{ dialogHistory: news(silent) }],
  });
  assert.equal(shouldRunSteward(domain(0), cfg).ok, false);
  assert.equal(shouldRunSteward(domain(2), cfg).ok, false);
  assert.equal(shouldRunSteward(domain(3), cfg).ok, true);
  assert.equal(shouldRunSteward(domain(5), cfg).ok, true);
});

test('вопрос «куда делся» один раз после двух писем, даже если окно уже проскочили', () => {
  const fresh = { characters: [{ dialogHistory: news(2) }], state: {} };
  assert.equal(shouldAskPatronPresence(fresh, cfg).ok, true);
  const late = { characters: [{ dialogHistory: news(6) }], state: {} };
  assert.equal(shouldAskPatronPresence(late, cfg).ok, true);
  markPatronPresenceAsked(late);
  assert.equal(shouldAskPatronPresence(late, cfg).ok, false);
  clearPatronPresenceAsked(late);
  assert.equal(shouldAskPatronPresence(late, cfg).ok, true);
});

test('ответ игрока сразу гасит стюарда', () => {
  const domain = {
    characters: [
      {
        dialogHistory: [...news(4), { role: 'user', content: 'слышу' }],
      },
    ],
  };
  assert.equal(shouldRunSteward(domain, cfg).ok, false);
});

// ───────────────────────── почин сановника ─────────────────────────

const silentLog = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const actConfig = {
  stats: [{ id: 'prosperity' }, { id: 'security' }],
  tick: { steward: { loseAfterLetters: 2, afterSilentMonths: 3 }, plot: {} },
};

/** Отвечает только за самого сановника: остальным агентам движок обязан не верить. */
function actRuntime(args) {
  return {
    run: async (opts) => {
      if (opts.agentId !== 'officerAct') return {};
      await opts.tools[0].handler(args);
      return {};
    },
  };
}

function actDomain() {
  return {
    id: 'd1',
    name: 'Варшена',
    stats: { prosperity: 60, security: 50 },
    lore: [],
    plotlines: [
      {
        id: 'p1',
        kind: 'story',
        storyType: 'story',
        title: 'Соглашение о птицах',
        synopsis: 'птичники спорят о правах на гнездовья',
        gravity: 'SITUATION',
        depth: 0,
        maxDepth: 2,
        failCount: 0,
        maxFails: 1,
        threats: [],
        relatedProcessIds: [],
        chronicleIds: [],
      },
    ],
    officers: [
      { id: 'off_c', office: 'chancellor', statId: 'influence', title: 'Канцлер', name: 'Жален', processId: null },
    ],
    characters: [{ name: 'Орион', dialogHistory: news(4) }],
    state: { pendingActions: [] },
  };
}

test('почин сановника не попадает в хронику: начало дела игрок видит в списке дел', async () => {
  const domain = actDomain();
  const world = { id: 'w1', tickIndex: 4, dayIndex: 120, jobs: [] };
  const res = await runOfficerAct({
    config: actConfig,
    runtime: actRuntime({
      action: 'process',
      summary: 'Свести птичников за общий стол',
      detail: 'Собрать спорящих птичников и записать права на гнездовья',
      goal: 'Договориться о правах',
      linkedStats: ['prosperity'],
      plotId: 'p1',
    }),
    domain,
    world,
    day: 130,
    rng: () => 0.5,
    log: silentLog,
  });

  assert.equal(res.act.kind, 'process');
  const mark = domain.lore.find((f) => (f.tags || []).includes('initiative'));
  assert.ok(mark, 'служебный след остаётся: по нему видно, что дело завёл не игрок');
  assert.equal(mark.day, 130, 'без дня запись врала бы, что она первого дня');
  assert.equal(mark.secret, true);
  assert.deepEqual(
    chronicleEntries(domain.lore),
    [],
    'в летописи такая строка называет дело по имени и палит метагейм',
  );
});
