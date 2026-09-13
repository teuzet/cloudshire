/**
 * Рассказчик события. Заменяет `tickNews`.
 *
 * Письма месяца больше нет — есть одно событие, о котором жрец говорит сразу.
 * Поэтому и контекст другой: не сводка за месяц, а одна запись хроники плюс
 * нить, которая её породила.
 *
 * `ask` считает движок, а не настроение модели: иначе жрец будет спрашивать
 * в каждом сообщении, и вопрос перестанет что-либо значить.
 */

import { getLogger } from '../log.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { chronicleEntries } from './models.js';
import { dreadFlag, knownThreatsForSpeech, livesLeft } from './threats.js';
import { revealedPremises, revealedAnswer } from './premises.js';
import { remainingWork } from './deedMath.js';

export const OCCASIONS = ['новая история', 'дело', 'угроза', 'разрешение', 'развязка', 'доклад'];

export const ASKS = ['нет', 'нужна помощь', 'подтверди паузу', 'можно закрыть'];

/** Хроника нити ограничена сверху числом битов, но страховка нужна. */
export const THREAD_HISTORY_LIMIT = 15;
export const THREAD_HISTORY_TAIL = 8;
export const CHAT_WINDOW = 10;

export function parseOccasion(raw, fallback = 'дело') {
  const key = String(raw || '').trim().toLowerCase();
  return OCCASIONS.includes(key) ? key : fallback;
}

export function parseAsk(raw, fallback = 'нет') {
  const key = String(raw || '').trim().toLowerCase();
  return ASKS.includes(key) ? key : fallback;
}

/**
 * Что жрец просит у покровителя. Ровно один вопрос, по приоритету:
 * подтверждение паузы важнее всего, потому что без ответа дело истлеет.
 * Что сановник свободен — не повод для вопроса: в вести называют, кто довёл
 * работу, и на этом молчат.
 */
export function decideAsk({
  pausedAwaitingConfirmation = false,
  plotClosable = false,
  needsHelp = false,
} = {}) {
  if (pausedAwaitingConfirmation) return 'подтверди паузу';
  if (plotClosable) return 'можно закрыть';
  if (needsHelp) return 'нужна помощь';
  return 'нет';
}

/**
 * Хроника нити. Обычно она короткая сама по себе, но если история разрослась,
 * отдаём синопсис плюс хвост, а не всё подряд.
 */
export function threadHistory(domain, plotId, { limit = THREAD_HISTORY_LIMIT, tail = THREAD_HISTORY_TAIL } = {}) {
  const id = String(plotId);
  const rows = chronicleEntries(domain?.lore).filter((f) => {
    if (!f) return false;
    if (String(f.sourcePlotId || '') === id) return true;
    return (f.relatedPlotlineIds || []).some((x) => String(x) === id);
  });
  if (rows.length <= limit) return { facts: rows, truncated: false };
  return { facts: rows.slice(-tail), truncated: true, skipped: rows.length - tail };
}

export function recentChat(domain, { limit = CHAT_WINDOW } = {}) {
  const rows = domain?.characters?.[0]?.dialogHistory || [];
  return rows
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-limit)
    .map((m) => ({
      role: m.role === 'assistant' ? 'жрец' : 'покровитель',
      text: String(m.content || m.text || '').slice(0, 600),
    }));
}

/**
 * Карточка нити глазами жреца: полосы и формулировки, без чисел механики.
 *
 * У закрытой истории нависшего и жизней уже нет: если их отдать, жрец говорит
 * о развязке так, будто впереди ещё ходы.
 */
export function threadCard(plot, day, { closed = false } = {}) {
  if (!plot) return null;
  if (closed) {
    return {
      title: plot.title || '',
      synopsis: plot.synopsis || '',
      gravity: plot.gravity || null,
      closed: true,
      livesLeft: null,
      workLeft: null,
      knownThreats: [],
      dread: null,
    };
  }
  return {
    title: plot.title || '',
    synopsis: plot.synopsis || '',
    gravity: plot.gravity || null,
    closed: false,
    livesLeft: livesLeft(plot),
    workLeft: remainingWork(plot),
    knownThreats: knownThreatsForSpeech(plot, day),
    // Выясненное городом. Жрецу это можно говорить — в отличие от того,
    // что ещё скрыто и ему вовсе не показывается.
    established: [
      revealedAnswer(plot) ? `разгадка: ${revealedAnswer(plot)}` : '',
      ...revealedPremises(plot),
    ].filter(Boolean),
    dread: dreadFlag(plot, day),
  };
}

/** Чем история кончилась: вид развязки и обещание, которое она сняла. */
export function closingCard(plot) {
  const ending = plot?.ending;
  if (!ending) return null;
  const id = String(ending.endingId || '').trim();
  const full = id ? (plot?.endings || []).find((e) => e.id === id) : null;
  const text = String(ending.text || full?.text || '').trim();
  return {
    kind: ending.kind || full?.kind || 'NEUTRAL_ENDING',
    text,
    questionGone: full?.questionGone || '',
    nowDifferent: full?.nowDifferent || '',
    cause: plot?.cause || '',
  };
}

export function buildHeraldContext({
  domain,
  plot = null,
  fact = null,
  occasion = 'дело',
  ask = 'нет',
  day = 0,
  memory = '',
  reportSubject = '',
  closed = false,
  actor = '',
} = {}) {
  const history = plot ? threadHistory(domain, plot.id) : { facts: [], truncated: false };
  const isClosed = Boolean(closed) || parseOccasion(occasion) === 'развязка';
  return {
    occasion: parseOccasion(occasion),
    ask: parseAsk(ask),
    fact: fact ? { text: fact.text || '', kind: fact.kind || null } : null,
    thread: threadCard(plot, day, { closed: isClosed }),
    closing: isClosed ? closingCard(plot) : null,
    threadHistory: history,
    chat: recentChat(domain),
    memory: String(memory || '').slice(0, 1200),
    reportSubject: String(reportSubject || '').slice(0, 200),
    actor: String(actor || '').trim(),
  };
}

const CLOSING_KIND_LINE = {
  GOOD_ENDING: 'Кончилась хорошо: вопрос снят, и город на этом что-то приобрёл. Но и цена была.',
  NEUTRAL_ENDING: 'Кончилась без победы и без крушения: вопрос снят, город за это заплатил.',
  BAD_ENDING: 'Кончилась плохо: города лишился того, из-за чего всё это стояло. Это утрата, а не трудность.',
};

function formatThreats(rows = []) {
  if (!rows.length) return '';
  return rows
    .map((t) => `- ${t.kind}: ${t.text} — срок: ${t.remainingBand}`)
    .join('\n');
}

export function formatHeraldPrompt(ctx) {
  const lines = [`ПОВОД: ${ctx.occasion}`];
  if (ctx.reportSubject) lines.push(`О ЧЁМ ПРОСИЛИ ДОКЛАДЫВАТЬ: ${ctx.reportSubject}`);
  if (ctx.fact?.text) {
    lines.push(
      '',
      'ЗАПИСЬ ЛЕТОПИСИ (это правда, и это единственное, о чём ты говоришь):',
      ctx.fact.text,
    );
  }
  if (ctx.actor) {
    lines.push(
      `Кто довёл эту работу: ${ctx.actor}. Назови должность и имя.`,
      'Не говори, что он свободен, и не спрашивай, чем его занять или кого занять делом.',
    );
  }
  if (ctx.thread) {
    lines.push('', `ИСТОРИЯ: «${ctx.thread.title}»`);
    if (ctx.thread.synopsis) lines.push(`Сейчас: ${ctx.thread.synopsis}`);
    const threats = formatThreats(ctx.thread.knownThreats);
    if (threats) lines.push('Город знает о нависшем:', threats);
    if (ctx.thread.established?.length) {
      lines.push('Город это уже выяснил, и об этом ты говоришь как об установленном:');
      for (const text of ctx.thread.established) lines.push(`- ${text}`);
    }
    if (ctx.thread.dread) lines.push(`Смутное чувство: ${ctx.thread.dread}. Что именно — ты не знаешь.`);
  }
  if (ctx.closing) {
    lines.push(
      '',
      'ЭТИМ ИСТОРИЯ КОНЧИЛАСЬ. Это твоё последнее слово о ней.',
      CLOSING_KIND_LINE[ctx.closing.kind] || CLOSING_KIND_LINE.NEUTRAL_ENDING,
    );
    if (ctx.closing.cause) lines.push(`Из-за чего всё это стояло: ${ctx.closing.cause}`);
    if (ctx.closing.questionGone) lines.push(`Почему вопроса больше нет: ${ctx.closing.questionGone}`);
    if (ctx.closing.nowDifferent) lines.push(`Что в городе теперь по-другому: ${ctx.closing.nowDifferent}`);
    lines.push(
      'Скажи так, чтобы покровитель понял: возвращаться к этому нечем и незачем.',
      'Не проси помощи и не обещай заняться этим дальше. Не подводи мораль.',
    );
  }
  if (ctx.threadHistory?.facts?.length) {
    lines.push('', 'ЧТО БЫЛО В ЭТОЙ ИСТОРИИ ДО СЕГО ДНЯ (контекст, не пересказывай):');
    if (ctx.threadHistory.truncated) lines.push(`(ранее было ещё ${ctx.threadHistory.skipped} записей)`);
    for (const f of ctx.threadHistory.facts) lines.push(`- ${f.text}`);
  }
  if (ctx.chat?.length) {
    lines.push('', 'ПОСЛЕДНИЙ РАЗГОВОР:');
    for (const m of ctx.chat) lines.push(`${m.role}: ${m.text}`);
  }
  if (ctx.memory) lines.push('', 'ТВОЯ ПАМЯТЬ:', ctx.memory);
  lines.push('', `ПРОСЬБА В КОНЦЕ: ${ctx.ask}`);
  if (ctx.ask === 'нет') lines.push('Ничего не проси и не задавай вопросов. Просто расскажи.');
  return lines.filter((l) => l != null).join('\n');
}

/**
 * Рассказать об одном событии. Возвращает текст; хроника уже написана движком.
 */
export async function narrateEvent({ runtime, domain, log: parentLog, ...ctxArgs }) {
  const log = (parentLog || getLogger()).child({ scope: 'herald', domainId: domain?.id });
  const ctx = buildHeraldContext({ domain, ...ctxArgs });
  const runOpts = {
    agentId: 'herald',
    tools: [],
    maxTurns: 1,
    log,
    scene: `herald_${ctx.occasion}`,
    domainId: domain?.id,
    userMessages: [{ role: 'user', content: formatHeraldPrompt(ctx) }],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    const res = await runtime.run(runOpts);
    const text = String(res?.text || res?.content || '').trim();
    if (text) return { text, prompt, ctx };
  } catch (err) {
    log.warn('herald.failed', { error: err.message });
  }
  return { text: ctx.fact?.text || '', prompt, ctx, fallback: true };
}
