import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OCCASIONS,
  ASKS,
  THREAD_HISTORY_LIMIT,
  THREAD_HISTORY_TAIL,
  parseOccasion,
  parseAsk,
  decideAsk,
  threadHistory,
  recentChat,
  threadCard,
  buildHeraldContext,
  formatHeraldPrompt,
} from '../src/game/herald.js';
import { createThreat, attachThreat } from '../src/game/threats.js';
import { loadConfig } from '../src/config.js';

function plot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    title: 'Трещина в опорном столбе',
    synopsis: 'северное крыло ведёт',
    gravity: 'CRISIS',
    depth: 1.2,
    maxDepth: 3,
    failCount: 0,
    threats: [],
    defenseCount: 0,
    ...extra,
  };
}

function threat(p, opts = {}) {
  const t = createThreat({
    plot: p,
    text: opts.text || 'обвал северного крыла',
    band: 'SEASON',
    day: 0,
    known: opts.known ?? true,
    rng: () => 0.5,
  });
  if (opts.total != null) {
    t.totalDays = opts.total;
    t.dueDay = opts.total;
  }
  attachThreat(p, t);
  return t;
}

/** Домен как в игре: хроника — теги в lore, разговор — dialogHistory жреца. */
function domain({ chronicle = [], dialogue = [] } = {}) {
  return {
    id: 'd1',
    lore: chronicle.map((f) => ({ tags: ['chronicle'], ...f })),
    characters: [{ id: 'priest', dialogHistory: dialogue }],
  };
}

test('поводы и просьбы — закрытые словари', () => {
  assert.deepEqual(OCCASIONS, ['новая история', 'дело', 'угроза', 'разрешение', 'развязка', 'доклад']);
  assert.equal(parseOccasion('УГРОЗА'), 'угроза');
  assert.equal(parseOccasion('что-то'), 'дело');
  assert.equal(parseAsk('НУЖНА ПОМОЩЬ'), 'нужна помощь');
  assert.equal(parseAsk('дай денег'), 'нет');
  assert.equal(parseAsk('сановник свободен'), 'нет', 'слот свободен — не повод спрашивать');
  assert.ok(ASKS.includes('нет'));
  assert.equal(ASKS.includes('сановник свободен'), false);
});

test('просьбу считает движок, а не настроение модели', () => {
  assert.equal(decideAsk({}), 'нет');
  assert.equal(decideAsk({ needsHelp: true }), 'нужна помощь');
  assert.equal(decideAsk({ plotClosable: true, needsHelp: true }), 'можно закрыть');
  assert.equal(
    decideAsk({ pausedAwaitingConfirmation: true, plotClosable: true }),
    'подтверди паузу',
    'без ответа дело истлеет — этот вопрос важнее всех',
  );
});

test('хроника нити берётся только по своей нити', () => {
  const d = domain({
    chronicle: [
      { id: 'f1', text: 'своё', sourcePlotId: 'p1' },
      { id: 'f2', text: 'чужое', sourcePlotId: 'p2' },
      { id: 'f3', text: 'ничьё' },
      { id: 'f4', text: 'своё, но через связь', relatedPlotlineIds: ['p1'] },
      { id: 'f5', text: 'не хроника', tags: ['fact'], sourcePlotId: 'p1' },
    ],
  });
  const res = threadHistory(d, 'p1');
  assert.deepEqual(res.facts.map((f) => f.id), ['f1', 'f4']);
  assert.equal(res.truncated, false);
});

test('разросшаяся нить урезается до хвоста', () => {
  const d = domain({
    chronicle: Array.from({ length: THREAD_HISTORY_LIMIT + 5 }, (_, i) => ({
      id: `f${i}`,
      text: 'запись',
      sourcePlotId: 'p1',
    })),
  });
  const res = threadHistory(d, 'p1');
  assert.equal(res.truncated, true);
  assert.equal(res.facts.length, THREAD_HISTORY_TAIL);
  assert.equal(res.skipped, THREAD_HISTORY_LIMIT + 5 - THREAD_HISTORY_TAIL);
  assert.equal(res.facts[0].id, `f${THREAD_HISTORY_LIMIT + 5 - THREAD_HISTORY_TAIL}`);
});

test('в контекст идёт короткий хвост разговора', () => {
  const d = domain({
    dialogue: Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `реплика ${i}`,
    })),
  });
  const chat = recentChat(d);
  assert.equal(chat.length, 10);
  assert.equal(chat.at(-1).text, 'реплика 29');
  assert.equal(chat.at(-1).role, 'жрец');
  assert.equal(chat.at(-2).role, 'покровитель');
});

test('старт острова не попадает в хвост разговора жреца', () => {
  const chat = recentChat(
    domain({
      dialogue: [
        { role: 'assistant', kind: 'island_reveal', content: 'Остров «Варскен» готов.' },
        { role: 'assistant', content: 'Елмир: Пока назову тех, кто держит город: Маршал Нела.' },
        { role: 'user', content: 'что с зерном?' },
        { role: 'assistant', content: 'Зерно держат отдельно.' },
      ],
    }),
  );
  assert.deepEqual(
    chat.map((m) => m.text),
    ['что с зерном?', 'Зерно держат отдельно.'],
  );
});

test('карточка нити отдаёт полосы и работу, но не сроки и не текст беды', () => {
  const p = plot();
  threat(p, { total: 12, text: 'обвал' });
  threat(p, { total: 200, text: 'просадка' });
  const card = threadCard(p, 0);
  assert.equal(card.livesLeft, 2);
  assert.equal(card.workLeft, 1.8);
  assert.equal(card.knownThreats, undefined);
  assert.equal(card.dread, undefined);
  const json = JSON.stringify(card);
  assert.ok(!json.includes('dueDay'));
  assert.ok(!json.includes('maxDepth'));
  assert.ok(!json.includes('обвал'));
  assert.ok(!json.includes('просадка'));
});

test('жрец не видит нависшие беды и их сроки', () => {
  const p = plot({ gravity: 'RUPTURE' });
  threat(p, { total: 10, text: 'обвал крыла' });
  threat(p, { total: 200, text: 'просадка фундамента' });
  const text = formatHeraldPrompt(buildHeraldContext({ domain: domain(), plot: p, day: 0 }));
  assert.doesNotMatch(text, /обвал крыла/);
  assert.doesNotMatch(text, /просадка фундамента/);
  assert.doesNotMatch(text, /Город знает о нависшем/);
});

test('промпт несёт повод, событие, нить и одну просьбу', () => {
  const p = plot();
  threat(p, { total: 12, text: 'обвал северного крыла' });
  const d = domain({
    chronicle: [{ id: 'f1', text: 'подпорки поставлены', sourcePlotId: 'p1' }],
    dialogue: [{ role: 'user', content: 'что там со столбом?' }],
  });
  const ctx = buildHeraldContext({
    domain: d,
    plot: p,
    fact: { text: 'каменщики закрепили опору' },
    occasion: 'дело',
    ask: 'нет',
    actor: 'Канцлер Жален',
    day: 0,
    memory: 'покровитель не любит длинных писем',
  });
  const text = formatHeraldPrompt(ctx);
  assert.match(text, /ПОВОД: дело/);
  assert.match(text, /каменщики закрепили опору/);
  assert.match(text, /Трещина в опорном столбе/);
  assert.doesNotMatch(text, /обвал северного крыла/);
  assert.match(text, /подпорки поставлены/);
  assert.match(text, /покровитель: что там со столбом\?/);
  assert.match(text, /покровитель не любит длинных писем/);
  assert.match(text, /ПРОСЬБА В КОНЦЕ: нет/);
  assert.match(text, /Кто довёл эту работу: Канцлер Жален/);
  assert.match(text, /Не говори, что он свободен/);
  assert.match(text, /ЗАПИСЬ ЛЕТОПИСИ/, 'жрец говорит о записи, а не отчитывается о деле');
  assert.match(text, /слова здесь её, а не твои/, 'запись — тема вести, а не её текст');
});

test('жрец говорит своими словами и не остаётся безучастным', () => {
  const text = loadConfig().agents.herald.instructions;
  assert.match(text, /Её фразами не пересказывай/);
  assert.match(text, /той же записью с переставленными словами/);
  assert.match(text, /ТЫ НЕ БЕЗУЧАСТЕН/);
  assert.match(text, /если оно сильное/);
  // Живость — не повод голосить: сильное чувство и разыгранное чувство не одно и то же.
  assert.match(text, /не разыгрывай горе/);
});

test('жрец согласует род сановницы', () => {
  const ctx = buildHeraldContext({
    domain: domain(),
    fact: { text: 'отряд прошёл к складам' },
    occasion: 'дело',
    ask: 'нет',
    actor: 'Маршал Орена',
    actorGender: 'female',
  });
  const text = formatHeraldPrompt(ctx);
  assert.match(text, /Маршал Орена \(женщина\)/);
  assert.match(text, /она свободна/);
  assert.doesNotMatch(text, /он свободен/);
});

test('без просьбы жрецу прямо запрещают спрашивать', () => {
  const ctx = buildHeraldContext({ domain: domain(), fact: { text: 'что-то случилось' }, ask: 'нет' });
  assert.match(formatHeraldPrompt(ctx), /Ничего не проси/);
});

test('доклад по наказу несёт тему, о которой просили', () => {
  const ctx = buildHeraldContext({
    domain: domain(),
    occasion: 'доклад',
    reportSubject: 'как идут дела в порту',
  });
  const text = formatHeraldPrompt(ctx);
  assert.match(text, /ПОВОД: доклад/);
  assert.match(text, /как идут дела в порту/);
});

test('скрытая угроза в промпт жреца не попадает', () => {
  const p = plot();
  threat(p, { total: 100, known: false, text: 'опора треснет насквозь' });
  const ctx = buildHeraldContext({ domain: domain(), plot: p, occasion: 'дело', day: 80 });
  const text = formatHeraldPrompt(ctx);
  assert.ok(!text.includes('опора треснет насквозь'));
  assert.doesNotMatch(text, /Смутное чувство|тревожно|dread/i);
  assert.doesNotMatch(text, /Город знает о нависшем/);
});

test('на развязке жрец получает тройку концовки и запрет на продолжение', () => {
  const p = plot({
    cause: 'опорный столб трескается сам по себе',
    endings: [
      {
        id: 'e_bad',
        kind: 'BAD_ENDING',
        text: 'северное крыло обрушилось',
        questionGone: 'крыла нет, спорить не о чем',
        nowDifferent: 'Срединный пояс отрезан от нижних дворов',
      },
    ],
    ending: { kind: 'BAD_ENDING', text: '', endingId: 'e_bad' },
  });
  threat(p, { total: 12, text: 'обвал северного крыла' });
  const ctx = buildHeraldContext({
    domain: domain(),
    plot: p,
    fact: { text: 'северное крыло обрушилось на мостки' },
    occasion: 'развязка',
    closed: true,
  });
  const text = formatHeraldPrompt(ctx);
  assert.match(text, /ПОВОД: развязка/);
  assert.match(text, /ЭТИМ ИСТОРИЯ КОНЧИЛАСЬ/);
  assert.match(text, /Это утрата, а не трудность/);
  assert.match(text, /опорный столб трескается сам по себе/);
  assert.match(text, /крыла нет, спорить не о чем/);
  assert.match(text, /Срединный пояс отрезан/);
  assert.match(text, /возвращаться к этому нечем/);
  assert.doesNotMatch(text, /обвал северного крыла/, 'у закрытой истории нависшего уже нет');
});

test('карточка закрытой нити не отдаёт ни жизней, ни нависшего', () => {
  const p = plot();
  threat(p, { total: 12, known: true, text: 'обвал' });
  const card = threadCard(p, 0, { closed: true });
  assert.equal(card.closed, true);
  assert.equal(card.livesLeft, null);
  assert.equal(card.workLeft, null);
  assert.equal(card.knownThreats, undefined);
  assert.equal(card.dread, undefined);
});

test('без нити промпт всё равно собирается', () => {
  const ctx = buildHeraldContext({
    domain: domain(),
    occasion: 'новая история',
    fact: { text: 'в порту нашли мёртвого досмотрщика' },
  });
  assert.equal(ctx.thread, null);
  assert.match(formatHeraldPrompt(ctx), /мёртвого досмотрщика/);
});
