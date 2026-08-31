import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlotline,
  isThreeActPlot,
  isFreeformPlot,
  storyTypeOf,
  formatCloseWhen,
  normalizeCloseWhenList,
  plotBeatAgentId,
} from '../src/game/plotlines.js';
import { advanceWorldMonths, normalizeFinish, freeformConfig, openStoryTitlesLine, formatFreeformGravityForPrompt, parseFreeformGravity, FREEFORM_GRAVITY } from '../src/game/freeform.js';
import { parseFreeformPick, formatFreeformVariants, formatFreeformCardJudgeCase, formatFreeformCardJudgeRepair } from '../src/game/freeformJudge.js';
import { normalizeSeedBlank, pickFreeformSeedAxes, pickFreeformSeedAxisPairs, formatFreeformSeedAxesForPrompt, formatFreeformSeedAxisPairsForPrompt } from '../src/game/freeformArchitect.js';
import {
  pickFreeformBrainstormRolls,
  formatFreeformBrainstormRollsForPrompt,
  brainstormFreeformSeeds,
  normalizeBrainstormCandidate,
} from '../src/game/freeformBrainstorm.js';
import { startFreeformStory, normalizeSeedVariant } from '../src/game/freeformStarter.js';
import { tellFreeformBeat } from '../src/game/freeformTeller.js';
import { loadConfig } from '../src/config.js';
import { createWebServer } from '../src/clients/web/server.js';
import { sessionPayload } from '../src/clients/web/freeformLab.js';
import { AgentRuntime } from '../src/agents/runtime.js';

function seedArchitectBlank(i, hook = `Затравка сапога ${i}`) {
  return {
    hook,
    conflict: `Конфликт сапога ${i}`,
    dynamics: `Динамика сапога ${i}`,
    consequences: `Последствия сапога ${i}`,
  };
}

test('freeform — отдельный тип, не трёхтакт', () => {
  const plot = createPlotline({
    title: 'Соль на ветру',
    kind: 'story',
    storyType: 'freeform',
    closeWhen: ['Найти источник соли', 'Признать, что соли нет'],
    hiddenPremises: ['Соль сыплется из разлома края, не из склада.'],
    urgency: 70,
  });
  assert.equal(plot.storyType, 'freeform');
  assert.equal(isFreeformPlot(plot), true);
  assert.equal(isThreeActPlot(plot), false);
  assert.equal(storyTypeOf(plot), 'freeform');
  assert.equal(plotBeatAgentId(plot), 'freeformTell');
  assert.deepEqual(plot.closeWhen, ['Найти источник соли', 'Признать, что соли нет']);
  assert.match(formatCloseWhen(plot), /1\. Найти источник соли/);
  assert.equal(plot.urgency, 70);
  assert.ok(plot.hiddenPremises.length);
  assert.equal(plot.act, null);
});

test('closeWhen список нормализуется', () => {
  assert.deepEqual(normalizeCloseWhenList('Один\nОдин\nДва'), ['Один', 'Два']);
  assert.deepEqual(normalizeCloseWhenList(['А', '', 'А']), ['А']);
});

test('исход дела и сдвиг календаря', () => {
  assert.equal(normalizeFinish('критический успех'), 'crit');
  assert.equal(normalizeFinish('провал'), 'fail');
  const world = { tickIndex: 14, gameDate: { year: 2, month: 3 } };
  const date = advanceWorldMonths(world, 2);
  assert.equal(world.tickIndex, 16);
  assert.equal(date.label, 'Год 2, месяц 5');
});

test('судья выбирает номер варианта с 1', () => {
  const parsed = parseFreeformPick({ pick: 3, why: 'живее', repair: '', issues: [] }, 5);
  assert.equal(parsed.pick, 3);
  assert.equal(parseFreeformPick({ pick: 99 }, 3).pick, 1);
});

test('конфиг freeform читается из YAML', () => {
  const cfg = freeformConfig(loadConfig());
  assert.equal(cfg.variantsMin, 3);
  assert.equal(cfg.variantsMax, 3);
  assert.deepEqual(cfg.seedAxes, ['truthArena', 'worldRelation']);
  const agents = loadConfig().agents;
  assert.equal(agents.freeformArchitectStart.provider, 'anthropic');
  assert.equal(agents.freeformArchitectStart.model, 'claude-sonnet-5');
  assert.equal(agents.freeformArchitectStart.reasoningEffort, 'high');
  assert.equal(agents.freeformArchitectStart.maxTokens, 16000);
  assert.deepEqual(agents.freeformArchitectStart.canon, ['world', 'time']);
  assert.equal(agents.freeformBrainstorm.provider, 'anthropic');
  assert.equal(agents.freeformBrainstorm.model, 'claude-sonnet-5');
  assert.equal(agents.freeformBrainstorm.reasoningEffort, 'high');
  assert.equal(agents.freeformBrainstorm.maxTokens, 16000);
  assert.deepEqual(agents.freeformBrainstorm.canon, ['world', 'time']);
  assert.match(agents.freeformBrainstorm.instructions, /агент брейншторма/);
  assert.match(agents.freeformBrainstorm.instructions, /фитиль/);
  assert.match(agents.freeformBrainstorm.instructions, /только к полю «последствия»/);
  assert.match(agents.freeformBrainstorm.instructions, /conflictSource/);
  assert.match(agents.freeformBrainstorm.instructions, /temporalShape/);
  assert.match(agents.freeformBrainstorm.instructions, /emit_freeform_candidates/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /судья|конструктор|cityBrief|recent_themes|actor_scope/);
  assert.doesNotMatch(agents.freeformBrainstorm.instructions, /позже подставит/);
  assert.equal(agents.freeformArchitectTell.model, 'gpt-5.6-luna');
  assert.deepEqual(agents.freeformArchitectTell.canon, ['world', 'time']);
  assert.match(agents.freeformArchitectStart.instructions, /придумываешь завязки/);
  assert.match(agents.freeformArchitectTell.instructions, /ХОДА/);
  assert.equal(Boolean(agents.freeformArchitect), false);
  assert.equal(agents.freeformStart.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformTell.provider, 'anthropic');
  assert.equal(agents.freeformTell.model, 'claude-haiku-4-5');
  assert.equal(agents.freeformJudge.model, 'gpt-5.6-luna');
  assert.equal(agents.freeformCardJudge.model, 'gpt-5.6-luna');
  assert.match(agents.freeformCardJudge.instructions, /HINGE/);
  assert.match(agents.freeformCardJudge.instructions, /не требуй угрозу/);
  assert.match(agents.freeformCardJudge.instructions, /PLAUSIBLE_ENOUGH/);
  assert.match(agents.freeformCardJudge.instructions, /RUPTURE/);
  assert.doesNotMatch(agents.freeformCardJudge.instructions, /CLEAR_THREAT/);
  assert.doesNotMatch(agents.freeformCardJudge.instructions, /MEANINGFUL_AGENCY/);
  assert.doesNotMatch(agents.freeformArchitectStart.instructions, /ANTI-ATTRACTOR|плесень|грибок/);
  assert.doesNotMatch(agents.freeformJudge.instructions, /ANTI-ATTRACTOR|плесень/);
  assert.match(agents.freeformArchitectStart.instructions, /не обязательно прямое и мгновенное/);
  assert.match(agents.freeformArchitectStart.instructions, /четыре поля/);
  assert.match(agents.freeformArchitectStart.instructions, /Gravity относится только к этому полю/);
  assert.match(agents.freeformArchitectStart.instructions, /фитиль/);
  assert.match(agents.freeformStart.instructions, /Не ужимай посадку/);
  assert.match(agents.freeformCardJudge.instructions, /Синопсис может быть меньше/);
  assert.match(agents.freeformArchitectStart.instructions, /по А судят о Б/);
  assert.match(agents.freeformJudge.instructions, /ШАРНИР/);
  assert.match(agents.freeformStart.instructions, /whyMoves/);
  assert.match(agents.freeformStart.instructions, /Urgency не ставь/);
  assert.match(agents.freeformJudge.instructions, /прибыть с чужого острова нельзя/);
});

test('gravity для архитектора — enum и расшифровка уровней', () => {
  assert.deepEqual(FREEFORM_GRAVITY, ['SITUATION', 'EPISODE', 'CRISIS', 'RUPTURE']);
  assert.equal(parseFreeformGravity('crisis'), 'CRISIS');
  assert.equal(parseFreeformGravity(8), 'SITUATION');
  assert.equal(parseFreeformGravity(40), 'EPISODE');
  assert.equal(parseFreeformGravity(60), 'CRISIS');
  assert.equal(parseFreeformGravity(80), 'RUPTURE');
  assert.equal(parseFreeformGravity('нет'), 'EPISODE');
  const rupture = formatFreeformGravityForPrompt('RUPTURE');
  assert.match(rupture, /GRAVITY: RUPTURE/);
  assert.match(rupture, /посадк/);
  assert.match(rupture, /Не CRISIS/);
  assert.match(rupture, /якоря/);
  assert.doesNotMatch(rupture, /SITUATION/);
  assert.doesNotMatch(rupture, /EPISODE/);
  assert.doesNotMatch(rupture, /изгородь|венок/);
  assert.match(rupture, /терраса/);
  const episode = formatFreeformGravityForPrompt('EPISODE');
  assert.match(episode, /GRAVITY: EPISODE/);
  assert.doesNotMatch(episode, /RUPTURE/);
  assert.doesNotMatch(episode, /изгородь|венок/);
  assert.match(formatFreeformGravityForPrompt('SITUATION'), /изгородь|венок|ступен/);
  assert.match(formatFreeformGravityForPrompt('CRISIS'), /пастбищ|повинност|артел|источник/);
});

test('пакет судьи карточки — абзац, whyMoves, gravity, без угрозы', () => {
  const text = formatFreeformCardJudgeCase({
    seedText: 'На площади нашли сапог.',
    blank: {
      hook: 'Сапог зовёт к створу.',
      conflict: 'Хозяин ищет гостя.',
      dynamics: 'Пока сапог на площади, двор держит чужака.',
      consequences: 'Площадь неделю спорит, чей это знак.',
      arena: 'HUMAN',
      worldRelation: 'NATIVE',
    },
    card: {
      title: 'Сапог',
      synopsis: 'Гость оставил сапог.',
      whyMoves: 'Хозяин ищет сапог.',
      closeWhen: ['Найти', 'Бросить'],
      hiddenPremises: [],
      urgency: 40,
    },
    gravity: 'RUPTURE',
  });
  assert.match(text, /Сапог зовёт к створу/);
  assert.match(text, /последствия: Площадь неделю спорит/);
  assert.match(text, /whyMoves: Хозяин ищет сапог/);
  assert.match(text, /GRAVITY: RUPTURE/);
  assert.match(text, /HUMAN/);
  assert.match(text, /hiddenPremises: \[\]/);
  assert.doesNotMatch(text, /если не предотвратить/);
  const repair = formatFreeformCardJudgeRepair({
    verdict: 'FAIL',
    summary: 'нет шарнира',
    issues: [{ code: 'HINGE', location: 'synopsis', reason: 'по густоте судят о жильцах без механизма' }],
  });
  assert.match(repair, /HINGE/);
  assert.match(repair, /густоте/);
  assert.equal(formatFreeformCardJudgeRepair({ verdict: 'PASS', summary: 'ок' }), '');
});

test('завязка: hiddenPremises по умолчанию пустые, лишние режутся', () => {
  const cfg = freeformConfig(loadConfig());
  const empty = normalizeSeedVariant(
    {
      title: 'Долг за камень',
      synopsis: 'Патроны спорят, платить ли каменотёсам сверх уговора.',
      closeWhen: ['Заплатить', 'Отказать'],
      hiddenPremises: [],
      urgency: 40,
    },
    cfg,
  );
  assert.deepEqual(empty.hiddenPremises, []);
  assert.equal(empty.urgency, undefined);
  const clipped = normalizeSeedVariant(
    {
      title: 'Долг за камень',
      synopsis: 'Патроны спорят, платить ли каменотёсам сверх уговора.',
      closeWhen: ['Заплатить', 'Отказать'],
      hiddenPremises: [
        'Первая тайна достаточно длинная для учёта',
        'Вторая тайна тоже достаточно длинная',
      ],
      urgency: 40,
    },
    cfg,
  );
  assert.deepEqual(clipped.hiddenPremises, ['Первая тайна достаточно длинная для учёта']);
});

test('болванка архитектора — четыре поля без urgency', () => {
  const blank = normalizeSeedBlank(
    {
      hook: 'На площади нашли сапог.',
      conflict: 'Хозяин ищет гостя.',
      dynamics: 'Двор держит чужака, пока сапог лежит.',
      consequences: 'Площадь спорит, чей это знак.',
    },
    [
      { groupId: 'truthArena', tagName: 'HUMAN' },
      { groupId: 'worldRelation', tagName: 'NATIVE' },
    ],
  );
  assert.equal(blank.hook, 'На площади нашли сапог.');
  assert.equal(blank.conflict, 'Хозяин ищет гостя.');
  assert.equal(blank.dynamics, 'Двор держит чужака, пока сапог лежит.');
  assert.equal(blank.consequences, 'Площадь спорит, чей это знак.');
  assert.equal(blank.text, blank.hook);
  assert.equal(blank.urgency, undefined);
  assert.equal(blank.arena, 'HUMAN');
  assert.match(formatFreeformVariants([blank]), /затравка: На площади/);
  assert.match(formatFreeformVariants([blank]), /конфликт: Хозяин ищет/);
  assert.match(formatFreeformVariants([blank]), /последствия: Площадь спорит/);
  assert.equal(normalizeSeedBlank({ hook: 'только затравка' }), null);
  assert.equal(
    openStoryTitlesLine({
      plotlines: [
        { kind: 'story', status: 'open', title: 'Белый налёт' },
        { kind: 'errand', status: 'open', title: 'Поручение' },
      ],
    }),
    'Уже открытые истории (не продолжай и не делай близнеца): Белый налёт.',
  );
});

test('архитектор не видит бриф города, конструктор видит', async () => {
  const CITY_MARK = 'ЦИСТЕРНЫ_МАРКЕР';
  const seedText = 'На площади нашли чужой сапог.';
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Сапог зовёт в путь ${i}`));
  const calls = [];
  const runtime = {
    async run(opts) {
      calls.push({
        agentId: opts.agentId,
        extraSystem: String(opts.extraSystem || ''),
        user: String(opts.userMessages?.[0]?.content || ''),
        required: opts.tools?.[0]?.parameters?.required,
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 2, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        await tool.handler({
          title: 'Сапог на площади',
          synopsis: 'Гость оставил сапог и ушёл к створу.',
          entry: '',
          closeWhen: ['Найти хозяина 2', 'Бросить сапог'],
          whyMoves: 'Пока сапог лежит на площади, хозяин ищет его, а двор держит чужака.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({ verdict: 'PASS', summary: 'шарнир на месте', issues: [] });
      }
    },
  };
  const domain = {
    id: 'd1',
    name: 'Грасток',
    cityBrief: `${CITY_MARK} питают водосборы и колёса.`,
    stats: { prosperity: 10 },
    plotlines: [],
    lore: [],
  };
  const world = { tickIndex: 3, gameDate: { year: 1, month: 3 } };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain,
    world,
    seedText,
    gravity: 'RUPTURE',
  });
  assert.equal(started.ok, true);
  assert.equal(started.winner.title, 'Сапог на площади');
  assert.equal(started.winner.gravity, 'RUPTURE');
  assert.match(started.winner.whyMoves, /сапог/);
  assert.equal(started.rejected.length, 2);
  assert.match(started.rejected[0].hook, /Сапог зовёт в путь 1/);
  assert.match(started.rejected[0].text, /конфликт: Конфликт сапога 1/);
  assert.ok(started.rejected[0].arena);
  assert.ok(started.rejected[0].worldRelation);
  assert.ok(started.winner.arena);
  assert.ok(started.winner.worldRelation);
  const architect = calls.find((c) => c.agentId === 'freeformArchitectStart');
  const judge = calls.find((c) => c.agentId === 'freeformJudge');
  const ctor = calls.find((c) => c.agentId === 'freeformStart');
  const cardJudge = calls.find((c) => c.agentId === 'freeformCardJudge');
  assert.ok(architect && judge && ctor && cardJudge);
  assert.match(cardJudge.extraSystem, new RegExp(CITY_MARK));
  assert.match(cardJudge.user, /GRAVITY: RUPTURE/);
  assert.equal(started.judge.card.verdict, 'PASS');
  assert.equal(architect.extraSystem, '');
  assert.doesNotMatch(architect.user, new RegExp(CITY_MARK));
  assert.match(architect.user, /1\. \w+ · \w+/);
  assert.match(architect.user, /^threatArena$/m);
  assert.match(architect.user, /^HUMAN — /m);
  assert.match(architect.user, /^worldRelation$/m);
  assert.match(architect.user, /^NATIVE — /m);
  assert.equal((architect.user.match(/^\d+\. /gm) || []).length, 3);
  assert.match(architect.user, /четыре поля/);
  assert.match(architect.user, /Gravity — посадка/);
  assert.match(architect.user, /ассоциативн/);
  assert.match(judge.extraSystem, new RegExp(CITY_MARK));
  assert.match(ctor.extraSystem, new RegExp(CITY_MARK));
  assert.match(ctor.user, /Сапог зовёт в путь 2/);
  assert.match(started.winner.hook, /Сапог зовёт в путь 2/);
  assert.match(started.winner.consequences, /Последствия сапога 2/);
  assert.match(architect.user, /GRAVITY: RUPTURE/);
  assert.match(architect.user, /Не CRISIS/);
  assert.doesNotMatch(architect.user, /SITUATION/);
  assert.doesNotMatch(architect.user, /EPISODE/);
  assert.doesNotMatch(architect.user, /изгородь|венок|помолвк/);
  assert.match(judge.user, /GRAVITY: RUPTURE/);
  assert.match(ctor.user, /whyMoves/);
  assert.ok(!ctor.required.includes('urgency'));
  assert.match(ctor.user, /Urgency не ставь/);
  assert.equal(started.winner.urgency, undefined);
  assert.match(judge.user, /чужой остров/);
  assert.doesNotMatch(ctor.user, /urgency: /);
  assert.match(started.architectPrompt, /На площади нашли чужой сапог/);
  assert.match(started.architectPrompt, /GRAVITY: RUPTURE/);
});

test('FAIL судьи карточки — одна доработка конструктора', async () => {
  let startCalls = 0;
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Горький корень гуще у стены ${i}.`));
  const runtime = {
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 1, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        startCalls += 1;
        const user = String(opts.userMessages?.[0]?.content || '');
        if (startCalls === 2) {
          assert.match(user, /HINGE/);
          assert.match(user, /густоте/);
        }
        await tool.handler({
          title: startCalls === 1 ? 'Корень' : 'Корень у стены',
          synopsis:
            startCalls === 1
              ? 'Горький корень гуще, значит есть неучтённые жильцы.'
              : 'Горький корень гуще у стены, потому что там течёт скрытый сток, и по густоте судят о числе жильцов.',
          closeWhen: ['Признать жильцов', 'Срезать корень'],
          whyMoves: 'Корень растёт и закрывает сток.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({
          verdict: 'FAIL',
          summary: 'нет шарнира',
          issues: [{ code: 'HINGE', location: 'synopsis', reason: 'по густоте судят о жильцах без механизма' }],
        });
      }
    },
  };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', cityBrief: 'двор', plotlines: [], lore: [] },
    world: { tickIndex: 3, gameDate: { year: 1, month: 3 } },
    seedText: 'У стены гуще горький корень.',
    gravity: 'EPISODE',
  });
  assert.equal(started.ok, true);
  assert.equal(startCalls, 2);
  assert.equal(started.winner.title, 'Корень у стены');
  assert.equal(started.judge.card.verdict, 'FAIL');
  assert.equal(started.judge.card.repaired, true);
  assert.match(started.judge.card.issues[0].code, /HINGE/);
});

test('UNCERTAIN судьи карточки не гоняет конструктора на починку', async () => {
  let startCalls = 0;
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Сапог ${i}`));
  const runtime = {
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 1, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        startCalls += 1;
        await tool.handler({
          title: 'Сапог',
          synopsis: 'Гость оставил сапог.',
          closeWhen: ['Найти', 'Бросить'],
          whyMoves: 'Хозяин ищет сапог.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({ verdict: 'UNCERTAIN', summary: 'неясно', issues: [] });
      }
    },
  };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', cityBrief: 'двор', plotlines: [], lore: [] },
    world: { tickIndex: 3, gameDate: { year: 1, month: 3 } },
    seedText: 'На площади нашли сапог.',
  });
  assert.equal(started.ok, true);
  assert.equal(startCalls, 1);
  assert.equal(started.judge.card.verdict, 'UNCERTAIN');
  assert.equal(started.judge.card.repaired, false);
});

test('ход: архитектор без города, конструктор с городом', async () => {
  const CITY_MARK = 'ЦИСТЕРНЫ_МАРКЕР';
  const blanks = [1, 2, 3].map((i) => ({
    title: `Ход ${i}`,
    whatHappens: `Гость показал второй сапог ${i}`,
    situationNow: `Хозяин двора держит гостя ${i}`,
    closed: false,
  }));
  const calls = [];
  const runtime = {
    async run(opts) {
      calls.push({
        agentId: opts.agentId,
        extraSystem: String(opts.extraSystem || ''),
        user: String(opts.userMessages?.[0]?.content || ''),
      });
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectTell') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 1, why: 'острее' });
      } else if (opts.agentId === 'freeformTell') {
        await tool.handler({
          chronicle: 'Гость показал второй сапог у створа.',
          synopsis: 'Хозяин двора держит гостя у створа.',
          closed: false,
        });
      }
    },
  };
  const plot = createPlotline({
    title: 'Чужой сапог',
    kind: 'story',
    storyType: 'freeform',
    closeWhen: ['Найти хозяина', 'Выбросить сапог'],
    synopsis: 'На площади нашли сапог.',
    urgency: 40,
  });
  const domain = {
    id: 'd1',
    name: 'Грасток',
    cityBrief: `${CITY_MARK} питают водосборы.`,
    plotlines: [plot],
    lore: [],
  };
  const told = await tellFreeformBeat({
    config: loadConfig(),
    runtime,
    domain,
    world: { tickIndex: 4, gameDate: { year: 1, month: 4 } },
    plot,
    deed: { summary: 'Искали хозяина сапога', detail: '', durationMonths: 1, finish: 'ok' },
  });
  assert.equal(told.ok, true);
  assert.match(told.winner.chronicle, /створа/);
  assert.equal(told.rejected[0].text, 'Гость показал второй сапог 2');
  const architect = calls.find((c) => c.agentId === 'freeformArchitectTell');
  const ctor = calls.find((c) => c.agentId === 'freeformTell');
  assert.equal(architect.extraSystem, '');
  assert.doesNotMatch(architect.user, new RegExp(CITY_MARK));
  assert.doesNotMatch(architect.user, /threatArena/);
  assert.match(ctor.extraSystem, new RegExp(CITY_MARK));
});

test('жребий завязки — арена и worldRelation из саспенс-аннотаций', () => {
  const tags = pickFreeformSeedAxes(loadConfig(), () => 0);
  assert.equal(tags.length, 2);
  assert.equal(tags[0].groupId, 'truthArena');
  assert.equal(tags[0].tagId, 'human');
  assert.equal(tags[1].groupId, 'worldRelation');
  assert.equal(tags[1].tagId, 'native');
  assert.match(formatFreeformSeedAxesForPrompt(tags), /threatArena: HUMAN/);
  assert.match(formatFreeformSeedAxesForPrompt(tags), /worldRelation: NATIVE/);
  assert.match(formatFreeformSeedAxesForPrompt(tags), /уклад|долг|права/);
  assert.match(formatFreeformSeedAxesForPrompt(tags), /решения|обещания|мода/);
  const contactLine = formatFreeformSeedAxesForPrompt([
    { groupId: 'truthArena', tagName: 'HUMAN' },
    { groupId: 'worldRelation', tagId: 'contact', tagName: 'CONTACT' },
  ]);
  assert.match(contactLine, /привычное вошло/);
  assert.doesNotMatch(contactLine, /прибыл/);
  const pairText = formatFreeformSeedAxisPairsForPrompt([[tags[0], tags[1]]]);
  assert.match(pairText, /1\. HUMAN · NATIVE/);
  assert.match(pairText, /четыре поля/);
  assert.match(pairText, /ассоциативн/);
  const skyOnly = formatFreeformSeedAxisPairsForPrompt([
    [
      { groupId: 'truthArena', tagId: 'sky', tagName: 'SKY' },
      { groupId: 'worldRelation', tagId: 'native', tagName: 'NATIVE' },
    ],
  ]);
  assert.match(skyOnly, /^threatArena$/m);
  assert.match(skyOnly, /^HUMAN — /m);
  assert.match(skyOnly, /существа живущие в небесах/);
  assert.match(skyOnly, /^worldRelation$/m);
  assert.match(skyOnly, /^NATIVE — /m);
  const freeText = formatFreeformSeedAxisPairsForPrompt([
    tags,
    [
      { groupId: 'truthArena', tagId: 'free', tagName: 'FREE' },
      { groupId: 'worldRelation', tagId: 'free', tagName: 'FREE' },
    ],
  ]);
  assert.match(freeText, /2\. FREE · FREE/);
  assert.match(freeText, /вайлдкард/i);
  assert.equal((freeText.match(/FREE · FREE/g) || []).length, 1);
  const pairs = pickFreeformSeedAxisPairs(loadConfig(), 5, () => 0);
  assert.equal(pairs.length, 5);
  const freeSlots = pairs.filter((p) => p[0].tagId === 'free' && p[1].tagId === 'free');
  assert.equal(freeSlots.length, 1);
  assert.ok(pairs.filter((p) => p[0].tagId !== 'free').every((p) => p[0].tagId === 'human' && p[1].tagId === 'native'));
});

test('жребий брейншторма — уникальные conflictSource и temporalShape, один FREE/FREE', () => {
  const cfg = loadConfig();
  const zero = pickFreeformBrainstormRolls(cfg, 3, () => 0);
  assert.equal(zero.length, 3);
  assert.equal(zero.filter((r) => r.pair[0].tagId === 'free' && r.pair[1].tagId === 'free').length, 1);
  assert.equal(zero[0].conflictSource.id, 'EXTERNAL_THREAT');
  assert.equal(zero[0].temporalShape.id, 'FRESH_INCIDENT');
  assert.equal(new Set(zero.map((r) => r.conflictSource.id)).size, 3);
  assert.equal(new Set(zero.map((r) => r.temporalShape.id)).size, 3);
  for (let i = 0; i < 20; i += 1) {
    const rolls = pickFreeformBrainstormRolls(cfg, 3);
    assert.equal(new Set(rolls.map((r) => r.conflictSource.id)).size, 3);
    assert.equal(new Set(rolls.map((r) => r.temporalShape.id)).size, 3);
    assert.equal(rolls.filter((r) => r.pair[0].tagId === 'free' && r.pair[1].tagId === 'free').length, 1);
  }
  const text = formatFreeformBrainstormRollsForPrompt(zero);
  assert.match(text, /conflictSource/);
  assert.match(text, /temporalShape/);
  assert.match(text, /SYSTEMIC_CRISIS/);
  assert.match(text, /DELAYED_BOMB/);
  assert.match(text, /FREE · FREE · EXTERNAL_THREAT · FRESH_INCIDENT/);
  assert.match(text, /не канцелярия/);
  assert.match(text, /четыре поля/);
  const blank = normalizeBrainstormCandidate(
    {
      hook: 'На площади нашли сапог.',
      conflict: 'Хозяин ищет гостя.',
      dynamics: 'Двор держит чужака.',
      consequences: 'Площадь спорит, чей это знак.',
      conflictSource: 'MORAL_DILEMMA',
      temporalShape: 'ALREADY_CLIMAX',
    },
    zero[0],
    1,
  );
  assert.equal(blank.conflictSource, 'EXTERNAL_THREAT');
  assert.equal(blank.temporalShape, 'FRESH_INCIDENT');
  assert.equal(blank.index, 1);
});

test('брейншторм не видит город, не зовёт судью и конструктора, оси берёт из броска', async () => {
  const real = new AgentRuntime(loadConfig());
  const calls = [];
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      calls.push(opts.agentId);
      const tool = opts.tools?.[0];
      if (opts.agentId !== 'freeformBrainstorm' || !tool) return;
      await tool.handler({
        candidates: [1, 2, 3].map((i) => ({
          hook: `Затравка сапога ${i}`,
          conflict: `Конфликт сапога ${i}`,
          dynamics: `Динамика сапога ${i}`,
          consequences: `Последствия сапога ${i}`,
          conflictSource: 'MORAL_DILEMMA',
          temporalShape: 'ALREADY_CLIMAX',
        })),
      });
    },
  };
  const drafted = await brainstormFreeformSeeds({
    config: loadConfig(),
    runtime,
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
  });
  assert.equal(drafted.ok, true);
  assert.equal(drafted.gravity, 'RUPTURE');
  assert.equal(drafted.candidates.length, 3);
  assert.deepEqual(calls, ['freeformBrainstorm']);
  drafted.candidates.forEach((c, i) => {
    assert.equal(c.conflictSource, drafted.rolls[i].conflictSource.id);
    assert.equal(c.temporalShape, drafted.rolls[i].temporalShape.id);
    assert.equal(c.hook, `Затравка сапога ${i + 1}`);
  });
  assert.match(drafted.prompt, /=== SYSTEM ===/);
  assert.match(drafted.prompt, /=== USER ===/);
  assert.match(drafted.prompt, /=== TOOLS ===/);
  assert.match(drafted.prompt, /агент брейншторма/);
  assert.match(drafted.prompt, /На площади нашли чужой сапог/);
  assert.match(drafted.prompt, /GRAVITY: RUPTURE/);
  assert.match(drafted.prompt, /посадк/);
  assert.match(drafted.prompt, /emit_freeform_candidates/);
  assert.match(drafted.prompt, /conflictSource/);
  assert.match(drafted.prompt, /temporalShape/);
  assert.doesNotMatch(drafted.prompt, /ЦИСТЕРНЫ/);
  assert.doesNotMatch(drafted.prompt, /судья|конструктор|позже подставит/);
  const packed = real.assembleChat({
    agentId: 'freeformBrainstorm',
    extraSystem: '',
    userMessages: [{ role: 'user', content: 'хроника' }],
  });
  assert.doesNotMatch(packed.systemContent, /cityBrief/i);
  assert.match(packed.systemContent, /фитиль/);
});

test('лабораторный payload отдаёт затравки без сюжета', () => {
  const payload = sessionPayload({
    mode: 'seeds',
    cityName: 'Грасток',
    world: { tickIndex: 1, gameDate: { year: 1, month: 1 } },
    domain: { name: 'Грасток', lore: [], plotlines: [] },
    lastChronicle: 'На площади нашли чужой сапог и двор его держит.',
    lastGravity: 'RUPTURE',
    lastCandidates: [
      {
        index: 1,
        hook: 'Сапог зовёт.',
        conflict: 'Хозяин ищет.',
        dynamics: 'Двор держит.',
        consequences: 'Площадь спорит.',
      },
    ],
    lastArchitectPrompt: 'agent: freeformBrainstorm',
    lastRejected: [],
    lastJudge: null,
    lastWarning: null,
    plotId: null,
  });
  assert.equal(payload.mode, 'seeds');
  assert.equal(payload.plot, null);
  assert.equal(payload.lastCandidates.length, 1);
  assert.equal(payload.lastGravity, 'RUPTURE');
  assert.equal(payload.lastChronicle, 'На площади нашли чужой сапог и двор его держит.');
  assert.match(payload.lastArchitectPrompt, /freeformBrainstorm/);
});

test('системный пакет архитекторов без cityBrief', () => {
  const runtime = new AgentRuntime(loadConfig());
  for (const agentId of ['freeformArchitectStart', 'freeformArchitectTell']) {
    const packed = runtime.assembleChat({
      agentId,
      extraSystem: '',
      userMessages: [{ role: 'user', content: 'хроника' }],
    });
    assert.doesNotMatch(packed.systemContent, /cityBrief/i);
    if (agentId === 'freeformArchitectStart') {
      assert.match(packed.systemContent, /придумываешь завязки/);
      assert.match(packed.systemContent, /не обязательно прямое и мгновенное/);
      assert.match(packed.systemContent, /вайлдкард/);
      assert.doesNotMatch(packed.systemContent, /плесень|ANTI-ATTRACTOR/);
    } else {
      assert.match(packed.systemContent, /архитектор/);
    }
  }
});

test('завязка возвращает полный промпт архитектора (system + user + tools)', async () => {
  const real = new AgentRuntime(loadConfig());
  const blanks = [1, 2, 3].map((i) => seedArchitectBlank(i, `Сапог зовёт ${i}`));
  const runtime = {
    assembleChat: (opts) => real.assembleChat(opts),
    async run(opts) {
      const tool = opts.tools?.[0];
      if (!tool) return;
      if (opts.agentId === 'freeformArchitectStart') {
        await tool.handler({ variants: blanks });
      } else if (opts.agentId === 'freeformJudge') {
        await tool.handler({ pick: 1, why: 'живее' });
      } else if (opts.agentId === 'freeformStart') {
        await tool.handler({
          title: 'Сапог',
          synopsis: 'Гость оставил сапог.',
          closeWhen: ['Найти', 'Бросить'],
          whyMoves: 'Хозяин ищет сапог.',
          hiddenPremises: [],
        });
      } else if (opts.agentId === 'freeformCardJudge') {
        await tool.handler({ verdict: 'PASS', summary: 'ок', issues: [] });
      }
    },
  };
  const started = await startFreeformStory({
    config: loadConfig(),
    runtime,
    domain: { id: 'd1', name: 'Грасток', cityBrief: 'ЦИСТЕРНЫ_МАРКЕР', plotlines: [], lore: [] },
    world: { tickIndex: 3, gameDate: { year: 1, month: 3 } },
    seedText: 'На площади нашли чужой сапог и двор его держит.',
    gravity: 'RUPTURE',
  });
  assert.equal(started.ok, true);
  assert.match(started.architectPrompt, /=== SYSTEM ===/);
  assert.match(started.architectPrompt, /=== USER ===/);
  assert.match(started.architectPrompt, /=== TOOLS ===/);
  assert.match(started.architectPrompt, /придумываешь завязки/);
  assert.match(started.architectPrompt, /На площади нашли чужой сапог/);
  assert.match(started.architectPrompt, /GRAVITY: RUPTURE/);
  assert.match(started.architectPrompt, /submit_freeform_seed_blanks/);
  assert.match(started.architectPrompt, /ассоциативн/);
  assert.doesNotMatch(started.architectPrompt, /ЦИСТЕРНЫ_МАРКЕР/);
  assert.doesNotMatch(started.architectPrompt, /плесень|ANTI-ATTRACTOR/);
});

test('GET /freeform отдаёт лабораторию', async () => {
  const server = createWebServer({
    config: { web: { play: true, admin: false }, telegram: {} },
    app: { onOutbound() {} },
    runtime: {},
    storage: {},
  });
  const http = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = http.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/freeform`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Промпт генератора затравок/);
  } finally {
    await new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
  }
});

test('лаборатория не требует Basic auth админки', async () => {
  const server = createWebServer({
    config: {
      web: { play: true, admin: true },
      admin: { user: 'admin', password: 'secret' },
      telegram: {},
    },
    app: { onOutbound() {} },
    runtime: {},
    storage: {},
  });
  const http = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = http.address().port;
    const page = await fetch(`http://127.0.0.1:${port}/freeform`);
    assert.equal(page.status, 200);
    const state = await fetch(`http://127.0.0.1:${port}/api/freeform/state`);
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.cityName, 'Грасток');
  } finally {
    await new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
  }
});
