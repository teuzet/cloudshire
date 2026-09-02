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
} from './freeform.js';

const HIDDEN_SPLIT = /\n*[ \t]*На самом деле:\s*/i;

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
    hiddenPremises: normalizeHiddenPremises(split.hiddenPremises),
  };
}

export function normalizeAssembledStory(raw, candidate) {
  const fallback = fallbackAssembledStory(candidate);
  const split = splitChronicleHiddenLayer(raw?.chronicle || raw?.entry || '');
  const chronicle = clipPlotText(split.chronicle || fallback.chronicle, PLOT_SUMMARY_MAX);
  if (!chronicle) return null;
  const title = clipPlotText(raw?.title, PLOT_TITLE_MAX) || fallback.title;
  const whyMoves = clipPlotText(raw?.whyMoves, PLOT_SUMMARY_MAX) || fallback.whyMoves;
  const hiddenFromTool = normalizeHiddenPremises(raw?.hiddenPremises);
  const hidden = hiddenFromTool.length
    ? hiddenFromTool
    : normalizeHiddenPremises(split.hiddenPremises.length ? split.hiddenPremises : fallback.hiddenPremises);
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
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.assemble' });
  const g = parseFreeformGravity(gravity);
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
          required: ['title', 'chronicle', 'whyMoves'],
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
              description: 'Истины из блока «На самом деле:». Пустой массив, если скрытого слоя нет.',
            },
          },
        },
        handler: async (args) => {
          const card = normalizeAssembledStory(args, candidate);
          if (!card) return toolFail('thin', 'Нужны title, chronicle и whyMoves.');
          if (!card.whyMoves) return toolFail('thin', 'Нужен whyMoves: следующий ход ситуации, если ею не занимаются.');
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
    log,
  });
  const story = constructed.card || fallbackAssembledStory(candidate);
  return {
    ...story,
    gravity: parseFreeformGravity(gravity ?? candidate?.gravity),
    arena: candidate?.arena || '',
    worldRelation: candidate?.worldRelation || '',
    conflictSource: candidate?.conflictSource || '',
    temporalShape: candidate?.temporalShape || '',
    assemblePrompt: constructed.prompt || '',
  };
}
