/**
 * Сборка freeform-карточки из затравки: конструктор пишет стартовое наблюдаемое событие.
 * Исходная завязка кладётся в seed; скрытый слой выносит hiddenSplit из того, что не вошло в хронику.
 * Концовки и urgency ставит лаборатория после посадки плота.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_SUMMARY_MAX } from './plotlines.js';
import { captureAgentPrompt } from './freeformArchitect.js';
import { normalizeHiddenPremises, normalizeKnownFacts } from './premises.js';
import {
  cityStateForPrompt,
  parseFreeformGravity,
  formatFreeformGravityForPrompt,
  formatBrainstormCandidateForPrompt,
  freeformConfig,
} from './freeform.js';
import { formatCityForAgents } from './cityContext.js';

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
  return {
    title,
    chronicle,
    synopsis: chronicle,
    cause: '',
    hiddenAnswer: '',
    hiddenPremises: [],
  };
}

export function normalizeAssembledStory(raw, candidate, maxChars = PLOT_SUMMARY_MAX) {
  const fallback = fallbackAssembledStory(candidate);
  const split = splitChronicleHiddenLayer(raw?.chronicle || raw?.entry || '');
  const chronicle = clipPlotText(split.chronicle || fallback.chronicle, maxChars);
  if (!chronicle) return null;
  const cause = clipPlotText(raw?.cause, PLOT_SUMMARY_MAX) || fallback.cause;
  return {
    title: keepStoryTitle(raw?.title, chronicle) || fallback.title || 'История',
    chronicle,
    synopsis: chronicle,
    cause,
    hiddenAnswer: '',
    hiddenPremises: [],
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

export function heuristicHiddenSplit(lines) {
  const layer = uniqueHiddenLines(lines);
  const hiddenAnswer = keepSeedAnswer(layer[0]);
  return {
    hiddenAnswer,
    hiddenPremises: layer.slice(1).filter((item) => item !== hiddenAnswer),
  };
}

export function candidateSeedText(candidate) {
  const raw = String(candidate?.chronicle || candidate?.text || candidate?.hook || '').trim();
  return splitChronicleHiddenLayer(raw).chronicle;
}

export function candidateHiddenLayer(candidate) {
  const field = String(candidate?.hiddenLayer || '').trim();
  if (field) {
    const split = splitChronicleHiddenLayer(field);
    return [split.chronicle, ...split.hiddenPremises].filter(Boolean).join('\n').trim();
  }
  return splitChronicleHiddenLayer(
    candidate?.chronicle || candidate?.text || candidate?.hook || '',
  ).hiddenPremises.join('\n');
}

export function formatCandidateSeed(candidate) {
  const publicLayer = candidateSeedText(candidate);
  const hidden = candidateHiddenLayer(candidate);
  if (!hidden) return publicLayer;
  return `${publicLayer}\n\nhiddenLayer:\n${hidden}`;
}

function hiddenLayerLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const split = splitChronicleHiddenLayer(raw);
  const blob = [split.chronicle, ...split.hiddenPremises].filter(Boolean).join('\n');
  const lines = [];
  for (const line of blob.split(/\n+/)) {
    const item = line.replace(/^[-–—•]\s*/, '').trim();
    if (item.length >= 8) lines.push(item);
  }
  if (!lines.length && blob.length >= 8) lines.push(blob);
  return lines;
}

export function leftoverSeedFacts(seed, chronicle, hiddenLayer = '') {
  const fromSeed = splitChronicleHiddenLayer(seed);
  const publicChronicle = splitChronicleHiddenLayer(chronicle).chronicle;
  return uniqueHiddenLines([...fromSeed.hiddenPremises, ...hiddenLayerLines(hiddenLayer)]).filter((item) => {
    const folded = item.replace(/\s+/g, ' ').trim().toLowerCase();
    return folded && !publicChronicle.toLowerCase().includes(folded);
  });
}

function formatStoryForHiddenSplit(story, seed, { gravity, config, hiddenLayer } = {}) {
  const fromStory = splitChronicleHiddenLayer(story?.chronicle || '');
  const chronicle = fromStory.chronicle || String(story?.chronicle || '').trim();
  const hidden = String(hiddenLayer || '').trim();
  return [
    'ИСТОРИЯ',
    chronicle ? `Хроника:\n${chronicle}` : '',
    story?.cause ? `Первопричина: ${story.cause}` : '',
    gravity != null ? formatFreeformGravityForPrompt(gravity, config) : '',
    '',
    'ЗАТРАВКА',
    seed || '(нет)',
    hidden ? `hiddenLayer:\n${hidden}` : '',
    '',
    'Вынеси в скрытый слой части затравки, которые не вошли в хронику.',
    'Если среди них есть самый главный — он обнажает первопричину и позволяет решать историю — это hiddenAnswer.',
    'Дальше сделай новый набор hiddenPremises: каждый намекает на эту разгадку или на способ её получить.',
    'Если главного факта нет — hiddenAnswer пустой, скрытые факты не переписывай в подступы.',
    'Новых тайн и фактов не выдумывай.',
  ]
    .filter((line) => line != null && line !== '')
    .join('\n');
}

function formatHiddenBrief(domain) {
  if (!domain) return '';
  const brief = formatCityForAgents(domain);
  return [
    domain.name ? `Город «${domain.name}».` : '',
    'БРИФ ГОРОДА (стандартный бриф для агентов, не полное описание)',
    brief,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Скрытый слой: части затравки, которые не вошли в наблюдаемую хронику. */
export async function splitAssembledHidden({
  runtime,
  story,
  seed = '',
  hiddenLayer = '',
  domain = null,
  gravity = null,
  config = null,
  requireMystery = false,
  log: parentLog,
  domainId = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.hidden' });
  const fromStory = splitChronicleHiddenLayer(story?.chronicle || '');
  const chronicle = fromStory.chronicle || String(story?.chronicle || '').trim();
  const seedText = String(seed || '').trim();
  const hiddenText = String(hiddenLayer || '').trim();
  const leftover = leftoverSeedFacts(seedText, chronicle, hiddenText);
  const base = {
    ...story,
    chronicle,
    synopsis: chronicle,
  };
  if (!seedText && !hiddenText) {
    return {
      ...base,
      hiddenAnswer: '',
      hiddenPremises: [],
      prompt: '',
    };
  }
  const fallback = heuristicHiddenSplit(leftover);
  if (!runtime?.run) {
    return { ...base, ...fallback, prompt: '' };
  }
  const draft = { submitted: false, hiddenAnswer: '', hiddenPremises: [] };
  const runOpts = {
    agentId: 'freeformHiddenSplit',
    tools: [
      {
        name: 'submit_hidden_layer',
        description:
          'Главный скрытый факт, если он решает историю, и подступы к нему. Новых тайн нет.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['hiddenAnswer'],
          properties: {
            hiddenAnswer: {
              type: 'string',
              description:
                'Самый главный скрытый факт: обнажает первопричину и позволяет решать историю. Пусто, если среди фактов такого нет.',
            },
            hiddenPremises: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Подступы: каждый намекает на hiddenAnswer или на способ его получить. Если разгадки нет — части затравки, не вошедшие в хронику.',
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
          const hints = keepSeedReveals(args?.hiddenPremises).filter((item) => item !== hiddenAnswer);
          draft.submitted = true;
          draft.hiddenAnswer = hiddenAnswer;
          draft.hiddenPremises = hiddenAnswer
            ? hints
            : leftover.length
              ? leftover.filter((item) => item !== hiddenAnswer)
              : hints;
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_hidden_layer' } },
    log,
    scene: 'freeform_hidden_split',
    domainId: domainId || domain?.id,
    extraSystem: formatHiddenBrief(domain),
    userMessages: [
      {
        role: 'user',
        content: formatStoryForHiddenSplit(story, seedText, { gravity, config, hiddenLayer: hiddenText }),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.hidden_split_failed', { error: err.message });
  }
  if (!draft.submitted) {
    return { ...base, ...fallback, prompt };
  }
  return {
    ...base,
    hiddenAnswer: draft.hiddenAnswer,
    hiddenPremises: draft.hiddenPremises,
    prompt,
  };
}

function formatHiddenForKnown(story) {
  const answer = String(story?.hiddenAnswer || '').trim();
  const premises = Array.isArray(story?.hiddenPremises) ? story.hiddenPremises : [];
  const rows = [
    answer ? `- разгадка: ${answer}` : '',
    ...premises.map((item) => `- ${item}`),
  ].filter(Boolean);
  return rows.join('\n');
}

function factAlreadyPlaced(fact, chronicle, hidden) {
  const folded = String(fact || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!folded) return true;
  const hay = `${chronicle}\n${hidden}`.toLowerCase();
  return hay.includes(folded);
}

/**
 * Остаток завязки: то, что город уже знает, но чего нет ни в хронике, ни в скрытом слое.
 * Пустой список — норма: всё уже разложили.
 */
export async function extractKnownFacts({
  runtime,
  story,
  seed = '',
  log: parentLog,
  domainId = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.known' });
  const chronicle = String(story?.chronicle || '').trim();
  const seedText = String(seed || '').trim();
  const hidden = formatHiddenForKnown(story);
  if (!seedText || !runtime?.run) return { knownFacts: [], prompt: '' };
  const draft = { knownFacts: [] };
  const runOpts = {
    agentId: 'freeformKnownFacts',
    tools: [
      {
        name: 'submit_known_facts',
        description: 'Факты завязки, которые город уже знает и которые не вошли в хронику и скрытый слой.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['knownFacts'],
          properties: {
            knownFacts: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Открытые факты завязки, которых нет в хронике и нет в скрытом слое. Пустой массив, если раскладывать нечего.',
            },
          },
        },
        handler: async (args) => {
          draft.knownFacts = normalizeKnownFacts(args?.knownFacts).filter(
            (item) => !factAlreadyPlaced(item, chronicle, hidden),
          );
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_known_facts' } },
    log,
    scene: 'freeform_known_facts',
    domainId,
    userMessages: [
      {
        role: 'user',
        content: [
          'ЗАТРАВКА',
          seedText,
          '',
          'ХРОНИКА',
          chronicle || '(нет)',
          '',
          'СКРЫТЫЙ СЛОЙ',
          hidden || '(нет)',
          '',
          'Вынеси в knownFacts открытые факты затравки, которых нет ни в хронике, ни в скрытом слое.',
          'Это то, что город уже знает. Тайну, разгадку и подступы сюда не клади.',
          'Новых фактов не выдумывай. Если всё уже разложено — верни пустой массив.',
        ].join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.known_facts_failed', { error: err.message });
  }
  return { knownFacts: draft.knownFacts, prompt };
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
        description: 'Карточка истории',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['chronicle', 'cause'],
          properties: {
            chronicle: {
              type: 'string',
              description:
                'Стартовая хроника: наблюдаемое событие, обозначающее конфликт',
            },
            cause: {
              type: 'string',
              description: [
                'Первопричина одним предложением: вещь или процесс в мире, из-за которого вопрос вообще стоит.',
                'Проблема, явление, поведение, предмет, что угодно. Пока эта сущность есть, история будет двигаться',
              ].join(' '),
            },
          },
        },
        handler: async (args) => {
          const card = normalizeAssembledStory(args, candidate, maxChars);
          if (!card) return toolFail('thin', 'Нужна chronicle.');
          if (!card.cause) {
            return toolFail(
              'no_cause',
              'Нужна cause: вещь или процесс в мире, из-за которого вопрос стоит.',
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
          '\n',
          formatBrainstormCandidateForPrompt(candidate, candidate?.index || 1),
          '\n',
          'Собери из этой затравки стартовое наблюдаемое событие в этом городе через submit_freeform_story.',
          'Не обязательно раскрывать всю подноготную — достаточно обозначить конфликт.',
          [
            'cause - Первопричина одним предложением: вещь или процесс в мире, из-за которого вопрос вообще стоит.',
            'Проблема, явление, поведение, предмет, что угодно. Пока эта сущность есть, история будет двигаться',
          ].join(' '),
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
  const seed = formatCandidateSeed(candidate);
  const story = constructed.card || fallbackAssembledStory(candidate);
  const layered = await splitAssembledHidden({
    runtime,
    story,
    seed: candidateSeedText(candidate),
    hiddenLayer: candidateHiddenLayer(candidate),
    domain,
    gravity,
    config,
    requireMystery,
    log,
    domainId: domain?.id,
  });
  if (requireMystery && !layered.hiddenAnswer) {
    return { ...layered, seed, hiddenAnswer: '', hiddenPremises: [], knownFacts: [], ok: false, error: 'no_reveal' };
  }
  const known = await extractKnownFacts({
    runtime,
    story: layered,
    seed: candidateSeedText(candidate),
    log,
    domainId: domain?.id,
  });
  const named = await nameAssembledStory({
    runtime,
    chronicle: layered.chronicle,
    cityName: domain?.name,
    log,
    domainId: domain?.id,
  });
  return {
    ...layered,
    seed,
    title: named.title || layered.title,
    gravity: parseFreeformGravity(gravity ?? candidate?.gravity),
    cause: layered.cause || '',
    arena: candidate?.arena || '',
    worldRelation: candidate?.worldRelation || '',
    target: candidate?.target || '',
    knowledge: candidate?.knowledge || '',
    assemblePrompt: constructed.prompt || '',
    knownFacts: known.knownFacts,
    knownPrompt: known.prompt || '',
    hiddenPrompt: layered.prompt || '',
    titlePrompt: named.prompt || '',
  };
}
