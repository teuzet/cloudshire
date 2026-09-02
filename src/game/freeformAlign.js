import { getLogger } from '../log.js';
import { formatFreeformEndings } from './plotlines.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { findPlotEnding } from './freeform.js';

export const FREEFORM_RELATIONS = ['DIRECT', 'RELATED', 'UNRELATED'];

export function parseFreeformRelation(raw, fallback = null) {
  const key = String(raw || '')
    .trim()
    .toUpperCase();
  if (FREEFORM_RELATIONS.includes(key)) return key;
  return fallback;
}

function endingIdFromPlot(plot, rawId) {
  const found = findPlotEnding(plot, rawId);
  if (found) return found.id;
  return plot?.endings?.[0]?.id || '';
}

/**
 * DIRECT — дело целится в конкретную концовку.
 * RELATED — связано с сюжетом, но не закрывает его успехом.
 * UNRELATED — даже полный успех сюжет не двигает.
 */
export async function judgeFreeformRelated({ runtime, domain, plot, summary, detail = '', log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.align', plotId: plot?.id });
  const draft = { relation: 'RELATED', endingId: '', why: '' };
  const runOpts = {
    agentId: 'freeformAlign',
    tools: [
      {
        name: 'submit_freeform_related',
        description: 'DIRECT, RELATED или UNRELATED. Для DIRECT укажи endingId.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['relation'],
          properties: {
            relation: { type: 'string', enum: [...FREEFORM_RELATIONS] },
            endingId: {
              type: 'string',
              description: 'id концовки из карточки, если relation=DIRECT.',
            },
            why: { type: 'string' },
          },
        },
        handler: async (args) => {
          const relation = parseFreeformRelation(args?.relation, 'RELATED');
          draft.relation = relation;
          draft.why = String(args?.why || '').trim();
          draft.endingId = relation === 'DIRECT' ? String(args?.endingId || '').trim() : '';
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_related' } },
    log,
    scene: 'freeform_align',
    domainId: domain?.id,
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          `История: ${plot?.title || ''}`,
          `Синопсис: ${plot?.synopsis || '—'}`,
          `endings:\n${formatFreeformEndings(plot) || '—'}`,
          `Дело: ${summary}`,
          detail ? `Подробности: ${detail}` : '',
          'DIRECT — цель дела, чтобы случилось одно из endings. Укажи endingId этой концовки.',
          'RELATED — дело связано с сюжетом, но не целится в конкретную концовку.',
          'UNRELATED — даже полный успех сюжет не двигает. Не ставь RELATED/DIRECT за случайную улику.',
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
    log.warn('freeform.align_failed', { error: err.message });
    draft.relation = 'RELATED';
  }

  const relation = parseFreeformRelation(draft.relation, 'RELATED');
  const endingId = relation === 'DIRECT' ? endingIdFromPlot(plot, draft.endingId) : '';
  log.info('freeform.align', { relation, endingId, summary });
  return {
    related: relation !== 'UNRELATED',
    relation,
    endingId,
    why: draft.why || '',
    prompt,
  };
}
