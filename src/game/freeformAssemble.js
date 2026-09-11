/**
 * Сборка freeform-карточки из прошедшей хроники: конструктор в городе.
 * Концовки и urgency ставит лаборатория после посадки плота.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX } from './plotlines.js';
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

export function fallbackAssembledStory(candidate) {
  const split = splitChronicleHiddenLayer(candidate?.chronicle || candidate?.text || candidate?.hook || '');
  const chronicle = split.chronicle;
  const title = clipPlotText(candidate?.title, PLOT_TITLE_MAX) || clipPlotText(chronicle, PLOT_TITLE_MAX) || 'История';
  return {
    title,
    chronicle,
    synopsis: chronicle,
    whyMoves: lastSentence(chronicle),
    hiddenPremises: keepSeedReveals(split.hiddenPremises),
  };
}

export function normalizeAssembledStory(raw, candidate, maxChars = PLOT_SUMMARY_MAX) {
  const fallback = fallbackAssembledStory(candidate);
  const split = splitChronicleHiddenLayer(raw?.chronicle || raw?.entry || '');
  const chronicle = clipPlotText(split.chronicle || fallback.chronicle, maxChars);
  if (!chronicle) return null;
  const title = clipPlotText(raw?.title, PLOT_TITLE_MAX) || fallback.title;
  const whyMoves = clipPlotText(raw?.whyMoves, PLOT_SUMMARY_MAX) || fallback.whyMoves;
  const hiddenFromTool = keepSeedReveals(raw?.hiddenPremises);
  const hidden = hiddenFromTool.length
    ? hiddenFromTool
    : keepSeedReveals(split.hiddenPremises.length ? split.hiddenPremises : fallback.hiddenPremises);
  return {
    title: title || 'История',
    chronicle,
    synopsis: chronicle,
    whyMoves,
    hiddenPremises: hidden,
  };
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
            ? ['title', 'chronicle', 'whyMoves', 'hiddenPremises']
            : ['title', 'chronicle', 'whyMoves'],
          properties: {
            title: { type: 'string', description: 'Короткое имя истории.' },
            chronicle: {
              type: 'string',
              description: 'Стартовая хроника: наблюдаемый слой, посаженный в этот город. Без блока «На самом деле:».',
            },
            whyMoves: {
              type: 'string',
              description: 'Одно-два предложения: что ситуация сделает следующим, если город ею не займётся.',
            },
            hiddenPremises: {
              type: 'array',
              items: { type: 'string' },
              description: requireMystery
                ? 'Конкретная разгадка из «На самом деле:»: что произошло, кто действует, почему. Не отговорка.'
                : 'Истины из блока «На самом деле:». Пустой массив, если скрытого слоя нет.',
            },
          },
        },
        handler: async (args) => {
          const card = normalizeAssembledStory(args, candidate, maxChars);
          if (!card) return toolFail('thin', 'Нужны title, chronicle и whyMoves.');
          if (!card.whyMoves) return toolFail('thin', 'Нужен whyMoves: следующий ход ситуации, если ею не занимаются.');
          if (requireMystery && !hasSeedReveal(card.hiddenPremises)) {
            return toolFail(
              'no_reveal',
              'Нужна конкретная разгадка в hiddenPremises, не «неизвестно» и не «мнения расходятся».',
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
          requireMystery
            ? [
                'hiddenPremises обязательны: полная разгадка из блока «На самом деле:».',
                'Не клади отговорки: «неизвестно», «мнения расходятся», «проверка не дала ответа».',
                'Разгадка конкретна и проверяема: что произошло, кто знает или врёт, какая улика это подтвердит.',
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
  if (requireMystery && !hasSeedReveal(story.hiddenPremises)) {
    return { ...story, hiddenPremises: [], ok: false, error: 'no_reveal' };
  }
  return {
    ...story,
    gravity: parseFreeformGravity(gravity ?? candidate?.gravity),
    arena: candidate?.arena || '',
    worldRelation: candidate?.worldRelation || '',
    target: candidate?.target || '',
    knowledge: candidate?.knowledge || '',
    engine: candidate?.engine || '',
    timing: candidate?.timing || '',
    assemblePrompt: constructed.prompt || '',
  };
}
