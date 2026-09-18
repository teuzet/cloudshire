/**
 * Сборка freeform-карточки из прошедшей хроники: конструктор в городе.
 * Концовки и urgency ставит лаборатория после посадки плота.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_SUMMARY_MAX } from './plotlines.js';
import { captureAgentPrompt } from './freeformArchitect.js';
import { normalizeHiddenPremises } from './premises.js';
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
  const cause = clipPlotText(raw?.cause, PLOT_SUMMARY_MAX) || fallback.cause;
  const answer = keepSeedAnswer(raw?.hiddenAnswer);
  const hidden = uniqueHiddenLines([
    ...(Array.isArray(raw?.hiddenPremises) ? raw.hiddenPremises : []),
    ...split.hiddenPremises,
  ]).filter((item) => item !== answer);
  return {
    title: keepStoryTitle(raw?.title, chronicle) || fallback.title || 'История',
    chronicle,
    synopsis: chronicle,
    cause,
    hiddenAnswer: answer,
    hiddenPremises: hidden,
  };
}

function uniqueHiddenLines(list) {
  const seen = new Set();
  const out = [];
  for (const item of keepSeedReveals(list)) {
    const key = item.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function collectAssembledHiddenLines(story, candidate) {
  const fromStory = splitChronicleHiddenLayer(story?.chronicle || '');
  const fromCandidate = splitChronicleHiddenLayer(candidate?.chronicle || candidate?.text || candidate?.hook || '');
  return uniqueHiddenLines([
    story?.hiddenAnswer,
    ...(Array.isArray(story?.hiddenPremises) ? story.hiddenPremises : []),
    ...fromStory.hiddenPremises,
    ...fromCandidate.hiddenPremises,
  ]);
}

export function heuristicHiddenSplit(lines) {
  const layer = uniqueHiddenLines(lines);
  const hiddenAnswer = keepSeedAnswer(layer[0]);
  return {
    hiddenAnswer,
    hiddenPremises: layer.slice(1).filter((item) => item !== hiddenAnswer),
  };
}

function formatHiddenBlob(lines) {
  return uniqueHiddenLines(lines)
    .map((item, i) => `${i + 1}. ${item}`)
    .join('\n');
}

/** Разрез скрытого слоя: разгадка отдельно, подступы — только то, что уже сказано. */
export async function splitAssembledHidden({
  runtime,
  story,
  candidate,
  requireMystery = false,
  log: parentLog,
  domainId = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.hidden' });
  const fromStory = splitChronicleHiddenLayer(story?.chronicle || '');
  const chronicle = fromStory.chronicle || String(story?.chronicle || '').trim();
  const lines = collectAssembledHiddenLines(story, candidate);
  const base = {
    ...story,
    chronicle,
    synopsis: chronicle,
  };
  if (!lines.length) {
    return { ...base, hiddenAnswer: '', hiddenPremises: [], prompt: '' };
  }
  const fallback = heuristicHiddenSplit(lines);
  if (!runtime?.run) {
    return { ...base, ...fallback, prompt: '' };
  }
  const draft = { hiddenAnswer: '', hiddenPremises: null };
  const runOpts = {
    agentId: 'freeformHiddenSplit',
    tools: [
      {
        name: 'submit_hidden_layer',
        description: 'Разгадка и подступы из уже данного скрытого слоя. Новых фактов нет.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['hiddenAnswer'],
          properties: {
            hiddenAnswer: {
              type: 'string',
              description: 'Разгадка одной строкой: что произошло, кто действует, почему. Не отговорка.',
            },
            hiddenPremises: {
              type: 'array',
              items: { type: 'string' },
              description: 'Подступы, которые уже есть в тексте. Пусто, если сказано только разгадку.',
            },
          },
        },
        handler: async (args) => {
          const hiddenAnswer = keepSeedAnswer(args?.hiddenAnswer);
          if (requireMystery && !hiddenAnswer) {
            return toolFail(
              'no_reveal',
              'Нужна конкретная разгадка в hiddenAnswer, не «неизвестно» и не «мнения расходятся».',
            );
          }
          draft.hiddenAnswer = hiddenAnswer;
          draft.hiddenPremises = keepSeedReveals(args?.hiddenPremises).filter((item) => item !== hiddenAnswer);
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_hidden_layer' } },
    log,
    scene: 'freeform_hidden_split',
    domainId,
    userMessages: [
      {
        role: 'user',
        content: [
          'Скрытый слой. Разрежь. Нового не выдумывай.',
          '',
          formatHiddenBlob(lines),
        ].join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.hidden_split_failed', { error: err.message });
  }
  const hiddenAnswer = draft.hiddenAnswer || fallback.hiddenAnswer;
  const hiddenPremises = Array.isArray(draft.hiddenPremises) ? draft.hiddenPremises : fallback.hiddenPremises;
  return { ...base, hiddenAnswer, hiddenPremises, prompt };
}

/**
 * Имя по наблюдаемому слою. Тайну сюда не кладём: иначе заголовок сам её выдаёт.
 */
export async function nameAssembledStory({ runtime, chronicle, cityName, log: parentLog, domainId = null }) {
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
    domainId,
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
  const maxChars = freeformConfig(config).chronicleMaxChars.seed;
  const draft = { card: null };
  const runOpts = {
    agentId: 'freeformAssemble',
    tools: [
      {
        name: 'submit_freeform_story',
        description: 'Карточка истории: стартовая хроника в этом городе и скрытый слой.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['chronicle', 'cause'],
          properties: {
            chronicle: {
              type: 'string',
              description:
                'Стартовая хроника: наблюдаемый слой, посаженный в этот город. Без блока «На самом деле:».',
            },
            cause: {
              type: 'string',
              description: [
                'Первопричина одним предложением: вещь или процесс в мире, из-за которого вопрос вообще стоит.',
                'Не спор сторон и не чьё-то упрямство: то, что останется, даже если все спорщики разойдутся.',
                'Пример: «гон костоломов — сезонный цикл карьерных птиц, из-за которого нельзя работать в выработке».',
              ].join(' '),
            },
            hiddenPremises: {
              type: 'array',
              items: { type: 'string' },
              description: 'Истины из блока «На самом деле:», вынесенные из хроники. Отговорки не клади.',
            },
          },
        },
        handler: async (args) => {
          const card = normalizeAssembledStory(args, candidate, maxChars);
          if (!card) return toolFail('thin', 'Нужна chronicle.');
          if (!card.cause) {
            return toolFail(
              'no_cause',
              'Нужна cause: вещь или процесс в мире, из-за которого вопрос стоит. Не спор сторон.',
            );
          }
          if (requireMystery && !collectAssembledHiddenLines(card, candidate).length) {
            return toolFail(
              'no_reveal',
              'Нужна конкретная разгадка из блока «На самом деле:», не «неизвестно» и не «мнения расходятся».',
            );
          }
          draft.card = card;
          return { ok: true };
        },
      },
    ],
    maxTurns: 4,
    log,
    scene: 'freeform_assemble',
    domainId: domain?.id,
    extraSystem: cityStateForPrompt(domain, world, { officers: false, cast: true }),
    userMessages: [
      {
        role: 'user',
        content: [
          formatFreeformGravityForPrompt(g, config),
          '',
          formatBrainstormCandidateForPrompt(candidate, candidate?.index || 1),
          '',
          'Собери из этой хроники историю в этом городе через submit_freeform_story.',
          'Имя истории ставится отдельно по готовой хронике; скрытый слой туда не попадает.',
          [
            'cause — первопричина: вещь или процесс в мире, из-за которого вопрос стоит.',
            'Проверь себя: если все спорщики разойдутся по домам, cause останется на месте.',
            'Разойдётся вместе с ними — значит это не первопричина, а спор.',
          ].join(' '),
          requireMystery
            ? 'Разгадка обязательна: перенеси блок «На самом деле:» в hiddenPremises, отговорки не клади.'
            : 'Если есть блок «На самом деле:» — перенеси его в hiddenPremises, в хронику не пиши.',
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
  const layered = await splitAssembledHidden({
    runtime,
    story,
    candidate,
    requireMystery,
    log,
    domainId: domain?.id,
  });
  if (requireMystery && !layered.hiddenAnswer) {
    return { ...layered, hiddenAnswer: '', hiddenPremises: [], ok: false, error: 'no_reveal' };
  }
  const named = await nameAssembledStory({
    runtime,
    chronicle: layered.chronicle,
    cityName: domain?.name,
    log,
    domainId: domain?.id,
  });
  return {
    ...layered,
    title: named.title || layered.title,
    gravity: parseFreeformGravity(gravity ?? candidate?.gravity),
    cause: layered.cause || '',
    arena: candidate?.arena || '',
    worldRelation: candidate?.worldRelation || '',
    target: candidate?.target || '',
    knowledge: candidate?.knowledge || '',
    engine: candidate?.engine || '',
    timing: candidate?.timing || '',
    assemblePrompt: constructed.prompt || '',
    hiddenPrompt: layered.prompt || '',
    titlePrompt: named.prompt || '',
  };
}
