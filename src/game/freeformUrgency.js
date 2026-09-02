import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { parseFreeformUrgency, FREEFORM_URGENCY } from './plotlines.js';
import { plotCardForPrompt, plotChronicleForPrompt, rollFreeformCountdown } from './freeform.js';

/**
 * Темп автотика: агент ставит FAST/MEDIUM/SLOW, код бросает месяцы в диапазоне.
 * После смены полосы (и если срока ещё нет) countdown перебрасывается.
 */
export async function setFreeformUrgency({
  runtime,
  domain,
  plot,
  log: parentLog,
  rng = Math.random,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.urgency', plotId: plot?.id });
  if (!plot) return { urgency: 'MEDIUM', countdown: 3, prompt: '' };
  const prev = parseFreeformUrgency(plot.urgency);
  const draft = { urgency: prev };
  const runOpts = {
    agentId: 'freeformUrgency',
    tools: [
      {
        name: 'set_freeform_urgency',
        description: 'Темп, с которым история сама сдвинется, если ею не занимаются.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['urgency'],
          properties: {
            urgency: { type: 'string', enum: [...FREEFORM_URGENCY] },
          },
        },
        handler: async (args) => {
          const urgency = parseFreeformUrgency(args?.urgency, null);
          if (!urgency) return toolFail('thin', 'Нужно FAST, MEDIUM или SLOW.');
          draft.urgency = urgency;
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'set_freeform_urgency' } },
    log,
    scene: 'freeform_urgency',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          plotCardForPrompt(plot, { revealHidden: true }),
          '',
          plotChronicleForPrompt(domain, plot),
          '',
          'Поставь темп через set_freeform_urgency. Срок в месяцах не ставь.',
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
    log.warn('freeform.urgency_failed', { error: err.message });
  }
  const urgency = parseFreeformUrgency(draft.urgency);
  plot.urgency = urgency;
  plot.countdown = rollFreeformCountdown(urgency, rng);
  log.info('freeform.urgency', { urgency, prev, countdown: plot.countdown });
  return { urgency, countdown: plot.countdown, prompt };
}
