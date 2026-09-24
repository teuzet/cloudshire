/**
 * Автор бед стадии.
 *
 * Движок решает, сколько бед и какого масштаба. Автор пишет их разом,
 * не зная, какая сработает. На последней стадии каждая беда обязана
 * снять первопричину.
 */

import { getLogger } from '../log.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { formatStoryFactsBlock, storyLinkedFacts } from './memory.js';
import { plotChronicleTail } from './chronicler.js';
import { formatFreeformGravityForPrompt } from './freeform.js';
import { attachThreat, createThreat, formatKnownUnknown, stagePoolRequest } from './threats.js';

const THREAT_TEXT_MAX = 240;
const THREAT_FINALE_MAX = 600;

function threatStageBrief(config, final) {
  const prompts = config?.agents?.threatSmith?.prompts || {};
  const text = String(final ? prompts.finale : prompts.wound || '').trim();
  return text;
}

function chronicleBlock(entries) {
  const list = (entries || []).map((text) => String(text || '').trim()).filter(Boolean);
  if (!list.length) return 'ХРОНИКА\nЗаписей этой истории ещё нет.';
  return [
    'ХРОНИКА',
    'От старых к новым. Это уже случилось: пиши беды после этих записей.',
    ...list.map((text) => `- ${text}`),
  ].join('\n');
}

/**
 * Заказ одной стадии.
 *
 * Сначала история и её хроника, потом масштаб и правила стадии.
 * Хроника должна уже лежать на домене: пул пишется после записи, которая
 * открыла эту стадию.
 */
export function formatThreatStageRequest(req, plot, config = null, { chronicle = [], storyFacts = [] } = {}) {
  const stage = threatStageBrief(config, req.final);
  const story = [
    'ИСТОРИЯ',
    `Название: ${plot?.title || ''}`,
    plot?.synopsis ? `Сейчас: ${plot.synopsis}` : '',
    plot?.cause ? `Первопричина: ${plot.cause}` : '',
  ].filter(Boolean);
  const order = [
    'ЗАКАЗ',
    `МАСШТАБ СТАДИИ: ${req.scale}.`,
    formatFreeformGravityForPrompt(req.scale, config),
    'Вред каждой беды для города держи на этом уровне.',
    `НУЖНО БЕД: ${req.count}.`,
    stage,
  ].filter(Boolean);
  const sections = [
    story.join('\n'),
    chronicleBlock(chronicle),
    formatStoryFactsBlock(storyFacts),
    order.join('\n'),
    formatKnownUnknown(plot),
  ];
  return sections.filter(Boolean).join('\n\n');
}

/** Один вызов на стадию. Возвращает список формулировок. */
export async function draftStageThreats({ runtime, domain, plot, request, config = null, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'threat.smith', plotId: plot?.id });
  const draft = { texts: [] };
  const runOpts = {
    agentId: 'threatSmith',
    tools: [
      {
        name: 'submit_threats',
        description: 'Список бед этой стадии. Ровно столько, сколько заказано.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['threats'],
          properties: {
            threats: {
              type: 'array',
              items: { type: 'string' },
              description: request.final
                ? 'Каждая беда — два или три предложения. Снятие первопричины вытекает из того же события.'
                : 'Каждая беда — одно предложение с предметом и людьми.',
            },
          },
        },
        handler: async (args) => {
          const list = Array.isArray(args?.threats) ? args.threats : [];
          draft.texts = list
            .map((text) =>
              String(text || '')
                .trim()
                .slice(0, request.final ? THREAT_FINALE_MAX : THREAT_TEXT_MAX),
            )
            .filter(Boolean)
            .slice(0, request.count);
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_threats' } },
    log,
    scene: request.final ? 'threat_finale' : 'threat_stage',
    domainId: domain?.id,
    userMessages: [
      {
        role: 'user',
        content: formatThreatStageRequest(request, plot, config, {
          chronicle: plotChronicleTail(domain, plot?.id),
          storyFacts: storyLinkedFacts(domain, plot),
        }),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('threat.smith_failed', { error: err.message });
  }
  if (!draft.texts.length) return { texts: [], prompt, failed: true };
  return { texts: draft.texts, prompt };
}

/**
 * Наполнить пул текущей стадии. Без рантайма и при молчании агента пул
 * остаётся пустым: шкала тогда некому вредить.
 */
export async function fillStageThreats({ runtime, domain, plot, day = 0, config = null, rng = Math.random, log } = {}) {
  const request = stagePoolRequest(plot, { config, rng });
  if (!request) return [];
  const drafted = runtime ? await draftStageThreats({ runtime, domain, plot, request, config, log }) : null;
  const texts = drafted?.texts || [];
  const created = [];
  for (const text of texts) {
    const threat = createThreat(plot, { text, stage: request.stage, final: request.final, day });
    attachThreat(plot, threat);
    created.push(threat);
  }
  return created;
}
