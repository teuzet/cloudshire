import { isThreeActPlot } from './plotlines.js';
import { getLogger } from '../log.js';

/**
 * Крошечный судья: цель дела совпадает с условием закрытия нити?
 * Результат замораживается на деле (plotAligned).
 */
export async function judgeProcessAlignment({ runtime, domain, process, plot, log: parentLog }) {
  if (!process || !isThreeActPlot(plot)) return null;
  const log = (parentLog || getLogger()).child({ scope: 'plot.align', plotId: plot.id });
  const draft = { aligned: true };

  try {
    await runtime.run({
      agentId: 'plotAlign',
      tools: [
        {
          name: 'submit_alignment',
          description: 'Совпадает ли цель дела с тем, чем должна кончиться история.',
          parameters: {
            type: 'object',
            required: ['aligned'],
            properties: {
              aligned: {
                type: 'boolean',
                description:
                  'true — дело про то же, чем закрывается история. false — дело на этой нити, но закрывает не то.',
              },
            },
          },
          handler: async (args) => {
            draft.aligned = Boolean(args.aligned);
            return { ok: true };
          },
        },
      ],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_alignment' } },
      log,
      scene: 'plot_align',
      domainId: domain?.id,
      userMessages: [
        {
          role: 'user',
          content: [
            `История «${plot.title}». Кончится, когда: ${plot.closeWhen || '—'}`,
            `Дело: ${process.summary || ''}`,
            process.goal ? `Цель дела: ${process.goal}` : '',
            process.detail ? `Поручение: ${process.detail}` : '',
            'aligned=true только если успех дела сам по себе выполняет условие закрытия истории.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('plot.align_failed', { error: err.message });
    draft.aligned = true;
  }

  process.plotAligned = Boolean(draft.aligned);
  log.info('plot.align', { summary: process.summary, aligned: process.plotAligned });
  return process.plotAligned;
}
