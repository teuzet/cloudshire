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

function domain(extra = {}) {
  return { id: 'd1', chronicle: [], state: { dialogue: [] }, ...extra };
}

test('поводы и просьбы — закрытые словари', () => {
  assert.deepEqual(OCCASIONS, ['новая история', 'дело', 'угроза', 'разрешение', 'доклад']);
  assert.equal(parseOccasion('УГРОЗА'), 'угроза');
  assert.equal(parseOccasion('что-то'), 'дело');
  assert.equal(parseAsk('НУЖНА ПОМОЩЬ'), 'нужна помощь');
  assert.equal(parseAsk('дай денег'), 'нет');
  assert.ok(ASKS.includes('нет'));
});

test('просьбу считает движок, а не настроение модели', () => {
  assert.equal(decideAsk({}), 'нет');
  assert.equal(decideAsk({ needsHelp: true }), 'нужна помощь');
  assert.equal(decideAsk({ officerFreed: true, needsHelp: true }), 'столп свободен');
  assert.equal(decideAsk({ plotClosable: true, officerFreed: true }), 'можно закрыть');
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
    ],
  });
  const res = threadHistory(d, 'p1');
  assert.deepEqual(res.facts.map((f) => f.id), ['f1']);
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
    state: {
      dialogue: Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `реплика ${i}`,
      })),
    },
  });
  const chat = recentChat(d);
  assert.equal(chat.length, 10);
  assert.equal(chat.at(-1).text, 'реплика 29');
  assert.equal(chat.at(-1).role, 'жрец');
  assert.equal(chat.at(-2).role, 'покровитель');
});

test('карточка нити отдаёт полосы и работу, но не сроки в днях', () => {
  const p = plot();
  threat(p, { total: 12, known: true, text: 'обвал' });
  threat(p, { total: 200, known: false });
  const card = threadCard(p, 0);
  assert.equal(card.livesLeft, 2);
  assert.equal(card.workLeft, 1.8);
  assert.deepEqual(card.knownThreats.map((t) => t.remainingBand), ['DAYS']);
  assert.equal(card.dread, 'спокойно');
  const json = JSON.stringify(card);
  assert.ok(!json.includes('dueDay'));
  assert.ok(!json.includes('maxDepth'));
});

test('жрец может противопоставить срочное и медленное', () => {
  const p = plot({ gravity: 'RUPTURE' });
  threat(p, { total: 10, known: true, text: 'обвал крыла' });
  threat(p, { total: 200, known: true, text: 'просадка фундамента' });
  const card = threadCard(p, 0);
  assert.deepEqual(
    card.knownThreats.map((t) => [t.text, t.remainingBand]),
    [
      ['обвал крыла', 'DAYS'],
      ['просадка фундамента', 'YEAR'],
    ],
  );
});

test('промпт несёт повод, событие, нить и одну просьбу', () => {
  const p = plot();
  threat(p, { total: 12, text: 'обвал северного крыла' });
  const d = domain({
    chronicle: [{ id: 'f1', text: 'подпорки поставлены', sourcePlotId: 'p1' }],
    state: { dialogue: [{ role: 'user', content: 'что там со столбом?' }] },
  });
  const ctx = buildHeraldContext({
    domain: d,
    plot: p,
    fact: { text: 'каменщики закрепили опору' },
    occasion: 'дело',
    ask: 'столп свободен',
    day: 0,
    memory: 'покровитель не любит длинных писем',
  });
  const text = formatHeraldPrompt(ctx);
  assert.match(text, /ПОВОД: дело/);
  assert.match(text, /каменщики закрепили опору/);
  assert.match(text, /Трещина в опорном столбе/);
  assert.match(text, /обвал северного крыла/);
  assert.match(text, /подпорки поставлены/);
  assert.match(text, /покровитель: что там со столбом\?/);
  assert.match(text, /покровитель не любит длинных писем/);
  assert.match(text, /ПРОСЬБА В КОНЦЕ: столп свободен/);
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

test('скрытая угроза в промпт не попадает — только чувство', () => {
  const p = plot();
  threat(p, { total: 100, known: false, text: 'опора треснет насквозь' });
  const ctx = buildHeraldContext({ domain: domain(), plot: p, occasion: 'дело', day: 80 });
  const text = formatHeraldPrompt(ctx);
  assert.ok(!text.includes('опора треснет насквозь'));
  assert.match(text, /Смутное чувство: очень тревожно/);
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
