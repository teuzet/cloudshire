import { getLogger } from '../log.js';
import { formatCloseWhen } from './plotlines.js';
import { captureAgentPrompt } from './agentPrompt.js';

/**
 * Бинарно: связано ли дело с freeform-сюжетом.
 * RELATED — может интересно развить историю при любом исходе или коррелирует с closeWhen.
 */
export async function judgeFreeformRelated({ runtime, domain, plot, summary, detail = '', log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.align', plotId: plot?.id });
  const draft = { related: true };
  const runOpts = {
    agentId: 'freeformAlign',
    tools: [
      {
        name: 'submit_freeform_related',
        description: 'RELATED или UNRELATED.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['relation'],
          properties: {
            relation: { type: 'string', enum: ['RELATED', 'UNRELATED'] },
            why: { type: 'string' },
          },
        },
        handler: async (args) => {
          const rel = String(args?.relation || '').toUpperCase();
          draft.related = rel !== 'UNRELATED';
          draft.why = String(args?.why || '').trim();
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
          `closeWhen:\n${formatCloseWhen(plot)}`,
          `Дело: ${summary}`,
          detail ? `Подробности: ${detail}` : '',
          'RELATED, если дело связано с сюжетом: может интересно развить его и при провале, и при успехе, либо явно бьёт в один из closeWhen.',
          'UNRELATED — даже полный успех сюжет не двигает. Не ставь RELATED за случайную улику, которую рассказчик мог бы придумать.',
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
    draft.related = true;
  }

  log.info('freeform.align', { related: draft.related, summary });
  return { related: Boolean(draft.related), why: draft.why || '', prompt };
}
