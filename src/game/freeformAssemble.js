/**
 * Сборка freeform-карточки из прошедшей хроники: конструктор в городе.
 * Концовки и urgency ставит лаборатория после посадки плота.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_SUMMARY_MAX } from './plotlines.js';
import { captureAgentPrompt } from './freeformArchitect.js';
import { normalizeHiddenPremises } from './suspenseGraph.js';
import {
  cityStateForPrompt,
  parseFreeformGravity,
  formatFreeformGravityForPrompt,
  formatBrainstormCandidateForPrompt,
  freeformConfig,
} from './freeform.js';

const HIDDEN_SPLIT = /\n*[ \t]*На самом деле:\s*/i;

const IGNORANCE_HEAD =
  /^(неизвестно|неясно|никто не знает|нет ответа|без ответа|тайна оста|оста[её]тся загадк|просто сквозняк|просто ошибк|просто так|так вышло)/i;
const IGNORANCE_BODY = /расходятся во мнениях|не дал[аои]?\s+внятн|проверка ничего не дала/i;
const ANSWER_MARK =
  /кроме|но |а это |это не |клад[её]т|сеет|льёт|роет|прячет|врёт|скрывает|потому что|чтобы /i;

/** Отговорка вместо разгадки: «неизвестно», «мнения расходятся» и т.п. */
export function isHollowHiddenPremise(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (raw.length < 8) return true;
  if (!IGNORANCE_HEAD.test(raw) && !IGNORANCE_BODY.test(raw)) return false;
  return !ANSWER_MARK.test(raw);
}

export function keepSeedReveals(list) {
  return normalizeHiddenPremises(list).filter((item) => !isHollowHiddenPremise(item));
}

export function hasSeedReveal(list) {
  return keepSeedReveals(list).length > 0;
}

/** Разгадка — одна строка, и отговоркой она быть не может. */
export function keepSeedAnswer(raw) {
  const text = clipPlotText(raw, PLOT_SUMMARY_MAX);
  return text && !isHollowHiddenPremise(text) ? text : '';
}

function lastSentence(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const parts = t.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || t;
}

export function splitChronicleHiddenLayer(text) {
  const raw = String(text || '').trim();
  if (!raw) return { chronicle: '', hiddenPremises: [] };
  const parts = raw.split(HIDDEN_SPLIT);
  const chronicle = String(parts[0] || '').trim();
  const rest = parts.slice(1).join('\n').trim();
  const hiddenPremises = [];
  if (rest) {
    for (const line of rest.split(/\n+/)) {
      const item = line.replace(/^[-–—•]\s*/, '').trim();
      if (item.length >= 8) hiddenPremises.push(item);
    }
    if (!hiddenPremises.length && rest.length >= 8) hiddenPremises.push(rest);
  }
  return { chronicle, hiddenPremises };
}

const TITLE_WORD_MAX = 8;
const TITLE_CHAR_MAX = 64;

function foldTitleText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Заголовок, который просто повторяет начало хроники. */
export function titleRetellsChronicle(title, chronicle) {
  const t = foldTitleText(title);
  const c = foldTitleText(chronicle);
  if (!t || !c) return false;
  if (c === t) return true;
  if (c.startsWith(t) && t.split(' ').length >= 3) return true;
  const head = c.split(' ').slice(0, 4).join(' ');
  if (head.length >= 8 && (t === head || t.startsWith(`${head} `))) return true;
  return false;
}

/**
 * Короткое имя карточки. Не первое предложение хроники и не пересказ.
 * Пустая строка — брать нельзя: иначе заголовок совпадает с записью.
 */
export function keepStoryTitle(raw, chronicle = '') {
  const title = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["«']+|["»']+$/g, '');
  if (!title || title.length > TITLE_CHAR_MAX) return '';
  if (/[.!?…]|:/.test(title)) return '';
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > TITLE_WORD_MAX) return '';
  if (titleRetellsChronicle(title, chronicle)) return '';
  return title;
}

export function fallbackAssembledStory(candidate) {
  const split = splitChronicleHiddenLayer(candidate?.chronicle || candidate?.text || candidate?.hook || '');
  const chronicle = split.chronicle;
  const title = keepStoryTitle(candidate?.title, chronicle) || 'История';
  // В блоке «На самом деле:» разгадка идёт первой строкой, остальное — подступы.
  const layer = keepSeedReveals(split.hiddenPremises);
  return {
    title,
    chronicle,
    synopsis: chronicle,
    whyMoves: lastSentence(chronicle),
    cause: '',
    hiddenAnswer: keepSeedAnswer(layer[0]),
    hiddenPremises: layer.slice(1),
  };
}

export function normalizeAssembledStory(raw, candidate, maxChars = PLOT_SUMMARY_MAX) {
  const fallback = fallbackAssembledStory(candidate);
  const split = splitChronicleHiddenLayer(raw?.chronicle || raw?.entry || '');
  const chronicle = clipPlotText(split.chronicle || fallback.chronicle, maxChars);
  if (!chronicle) return null;
  const whyMoves = clipPlotText(raw?.whyMoves, PLOT_SUMMARY_MAX) || fallback.whyMoves;
  const cause = clipPlotText(raw?.cause, PLOT_SUMMARY_MAX) || fallback.cause;
  const answer = keepSeedAnswer(raw?.hiddenAnswer) || fallback.hiddenAnswer;
  const hiddenFromTool = keepSeedReveals(raw?.hiddenPremises);
  const hidden = hiddenFromTool.length
    ? hiddenFromTool
    : keepSeedReveals(split.hiddenPremises).filter((item) => item !== answer);
  return {
    title: keepStoryTitle(raw?.title, chronicle) || fallback.title || 'История',
    chronicle,
    synopsis: chronicle,
    whyMoves,
    cause,
    hiddenAnswer: answer,
    hiddenPremises: hidden,
  };
}

/**
 * Имя по наблюдаемому слою. Тайну сюда не кладём: иначе заголовок сам её выдаёт.
 */
export async function nameAssembledStory({ runtime, chronicle, cityName, log: parentLog }) {
  const publicChronicle = String(chronicle || '').trim();
  if (!publicChronicle || !runtime?.run) return { title: 'История', prompt: '' };
  const log = (parentLog || getLogger()).child({ scope: 'freeform.title' });
  const draft = { title: '' };
  const runOpts = {
    agentId: 'freeformTitle',
    tools: [
      {
        name: 'submit_freeform_title',
        description: 'Короткое имя истории: заголовок, не пересказ хроники.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['title'],
          properties: {
            title: { type: 'string', description: 'Два-шесть слов, не первое предложение записи.' },
          },
        },
        handler: async (args) => {
          const title = keepStoryTitle(args?.title, publicChronicle);
          if (!title) {
            return toolFail(
              'thin',
              'Нужно короткое имя из 2–6 слов, не пересказ и не первое предложение хроники.',
            );
          }
          draft.title = title;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_title' } },
    log,
    scene: 'freeform_title',
    userMessages: [
      {
        role: 'user',
        content: [
          cityName ? `Город: ${cityName}.` : '',
          'Хроника (то, что город уже знает):',
          publicChronicle,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.title_failed', { error: err.message });
  }
  return { title: draft.title || 'История', prompt };
}

export async function constructFreeformStory({
  runtime,
  domain,
  world,
  candidate,
  gravity,
  config,
  requireMystery = false,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.assemble' });
  const g = parseFreeformGravity(gravity);
  const maxChars = freeformConfig(config).chronicleMaxChars;
  const draft = { card: null };
  const runOpts = {
    agentId: 'freeformAssemble',
    tools: [
      {
        name: 'submit_freeform_story',
        description: 'Карточка истории: стартовая хроника в этом городе, скрытый слой и следующий ход ситуации.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: requireMystery
            ? ['chronicle', 'cause', 'whyMoves', 'hiddenAnswer', 'hiddenPremises']
            : ['chronicle', 'cause', 'whyMoves'],
          properties: {
            chronicle: {
              type: 'string',
              description:
                'Стартовая хроника: наблюдаемый слой, посаженный в этот город. ' +
                'Механизм должен читаться: что за вещь, кто действует, что случилось. Без блока «На самом деле:».',
            },
            cause: {
              type: 'string',
              description: [
                'Первопричина одним предложением: вещь или процесс в мире, из-за которого вопрос вообще стоит.',
                'Не спор сторон и не чьё-то упрямство: то, что останется, даже если все спорщики разойдутся.',
                'Пример: «гон костоломов — сезонный цикл карьерных птиц, из-за которого нельзя работать в выработке».',
              ].join(' '),
            },
            whyMoves: {
              type: 'string',
              description: 'Одно-два предложения: что ситуация сделает следующим, если город ею не займётся.',
            },
            hiddenAnswer: {
              type: 'string',
              description:
                'Разгадка одной строкой: что произошло на самом деле, кто действует, почему. ' +
                'Одна, самая сердцевина. Не отговорка.',
            },
            hiddenPremises: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Подступы к разгадке, каждый сам по себе: улика, человек, который знает, ' +
                'старая запись, причина, по которой до сих пор не поняли. ' +
                'Независимые друг от друга, не ступени одной лестницы. Саму разгадку сюда не кладут.',
            },
          },
        },
        handler: async (args) => {
          const card = normalizeAssembledStory(args, candidate, maxChars);
          if (!card) return toolFail('thin', 'Нужны chronicle и whyMoves.');
          if (!card.whyMoves) return toolFail('thin', 'Нужен whyMoves: следующий ход ситуации, если ею не занимаются.');
          if (!card.cause) {
            return toolFail(
              'no_cause',
              'Нужна cause: вещь или процесс в мире, из-за которого вопрос стоит. Не спор сторон.',
            );
          }
          if (requireMystery && !card.hiddenAnswer) {
            return toolFail(
              'no_reveal',
              'Нужна конкретная разгадка в hiddenAnswer, не «неизвестно» и не «мнения расходятся».',
            );
          }
          draft.card = card;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_story' } },
    log,
    scene: 'freeform_assemble',
    domainId: domain?.id,
    extraSystem: cityStateForPrompt(domain, world),
    userMessages: [
      {
        role: 'user',
        content: [
          formatFreeformGravityForPrompt(g, config),
          '',
          formatBrainstormCandidateForPrompt(candidate, candidate?.index || 1),
          '',
          'Собери из этой хроники историю в этом городе через submit_freeform_story.',
          'Имя не твоё: его даст другой агент по готовой хронике.',
          'Стартовая хроника — первая запись, не месячная заметка: наблюдаемый механизм оставь целым.',
          'Не схлопывай цепочку «знак → кто его читает → решение». Объявляет человек, не вещь и не тварь.',
          [
            'cause — первопричина: вещь или процесс в мире, из-за которого вопрос стоит.',
            'Проверь себя: если все спорщики разойдутся по домам, cause останется на месте.',
            'Разойдётся вместе с ними — значит это не первопричина, а спор.',
          ].join(' '),
          requireMystery
            ? [
                'Скрытый слой из блока «На самом деле:» разложи на два поля.',
                'hiddenAnswer — сама разгадка, одной строкой: что произошло, кто действует, почему.',
                'Конкретно и проверяемо. Не отговорки: ни «неизвестно», ни «мнения расходятся»,',
                'ни «проверка не дала ответа».',
                'hiddenPremises — подступы к ней: улика, человек, который знает и молчит,',
                'старая запись, причина, по которой до сих пор не поняли.',
                'Каждый подступ должен работать сам по себе, независимо от остальных:',
                'город может прийти к разгадке любым из них, и порядка между ними нет.',
                'Не пиши подступы как ступени одной лестницы и не повторяй в них разгадку.',
              ].join(' ')
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.assemble_failed', { error: err.message });
  }
  return { card: draft.card, prompt };
}

export async function assembleFreeformLabStory({
  runtime,
  domain,
  world,
  candidate,
  gravity,
  config,
  requireMystery = false,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.assemble.pack' });
  const constructed = await constructFreeformStory({
    runtime,
    domain,
    world,
    candidate,
    gravity,
    config,
    requireMystery,
    log,
  });
  const story = constructed.card || fallbackAssembledStory(candidate);
  if (requireMystery && !story.hiddenAnswer) {
    return { ...story, hiddenAnswer: '', hiddenPremises: [], ok: false, error: 'no_reveal' };
  }
  const named = await nameAssembledStory({
    runtime,
    chronicle: story.chronicle,
    cityName: domain?.name,
    log,
  });
  return {
    ...story,
    title: named.title || story.title,
    gravity: parseFreeformGravity(gravity ?? candidate?.gravity),
    cause: story.cause || '',
    arena: candidate?.arena || '',
    worldRelation: candidate?.worldRelation || '',
    target: candidate?.target || '',
    knowledge: candidate?.knowledge || '',
    engine: candidate?.engine || '',
    timing: candidate?.timing || '',
    assemblePrompt: constructed.prompt || '',
    titlePrompt: named.prompt || '',
  };
}
