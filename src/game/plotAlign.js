import { isThreeActPlot, plotsForProcess } from './plotlines.js';
import { getLogger } from '../log.js';

export const PLOT_ENGAGEMENTS = ['DIRECT', 'RELEVANT', 'UNRELATED'];

/**
 * DIRECT / RELEVANT / UNRELATED.
 * Старый boolean: true → DIRECT, false → RELEVANT (дело на нити, но не closeWhen).
 * Нет данных → UNRELATED.
 */
export function engagementOf(process) {
  const raw = String(process?.plotEngagement || '').toUpperCase();
  if (PLOT_ENGAGEMENTS.includes(raw)) return raw;
  if (process?.plotAligned === true) return 'DIRECT';
  if (process?.plotAligned === false) return 'RELEVANT';
  return 'UNRELATED';
}

export function engagementAttends(engagement) {
  return engagement === 'DIRECT' || engagement === 'RELEVANT';
}

export function applyEngagement(process, engagement) {
  const value = PLOT_ENGAGEMENTS.includes(engagement) ? engagement : 'UNRELATED';
  if (process) {
    process.plotEngagement = value;
    process.plotAligned = value === 'DIRECT';
  }
  return value;
}

/**
 * Крошечный судья: цель дела к closeWhen — DIRECT / RELEVANT / UNRELATED.
 * На старте — чтобы не глушить urgency посторонним делом.
 * На финише вызывается снова: closeWhen и цель могли измениться.
 * Ошибка агента → UNRELATED, иначе сломанный align заморозит сюжет.
 */
export async function judgeProcessAlignment({ runtime, domain, process, plot, log: parentLog }) {
  if (!process || !isThreeActPlot(plot)) return null;
  const log = (parentLog || getLogger()).child({ scope: 'plot.align', plotId: plot.id });
  const draft = { engagement: 'UNRELATED' };

  try {
    await runtime.run({
      agentId: 'plotAlign',
      tools: [
        {
          name: 'submit_alignment',
          description: 'Отношение цели дела к условию закрытия истории.',
          parameters: {
            type: 'object',
            required: ['relation'],
            properties: {
              relation: {
                type: 'string',
                enum: PLOT_ENGAGEMENTS,
                description:
                  'DIRECT — цель сама закрывает closeWhen. RELEVANT — естественный шаг к closeWhen. UNRELATED — даже полный успех сюжет не двигает.',
              },
            },
          },
          handler: async (args) => {
            const rel = String(args?.relation || '').toUpperCase();
            draft.engagement = PLOT_ENGAGEMENTS.includes(rel) ? rel : 'UNRELATED';
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
            `История (${plot.storyType || ''}).`,
            `Успешный исход: ${plot.closeWhen || '—'}`,
            plot.mootWhen ? `История теряет смысл, когда: ${plot.mootWhen}` : '',
            plot.synopsis ? `Сейчас: ${plot.synopsis}` : '',
            plot.storyType === 'suspense' && plot.closureGate
              ? `Порог закрытия: ${plot.closureGate}`
              : '',
            plot.storyType === 'suspense' && plot.hiddenPremises?.length
              ? `Скрытые посылки (двигатель, не для хроники): ${plot.hiddenPremises.join(' | ')}`
              : '',
            `Дело: ${process.summary || ''}`,
            process.goal ? `Цель дела: ${process.goal}` : '',
            process.detail ? `Поручение: ${process.detail}` : '',
            'Верни ровно DIRECT, RELEVANT или UNRELATED по цели process, не по броску.',
            'DIRECT: успех сам устанавливает closeWhen или делает историю бессмысленной (mootWhen).',
            'RELEVANT: естественный промежуточный шаг к closeWhen, сам его не закрывает.',
            'UNRELATED: даже полный успех closeWhen не двигает. Не ставь RELEVANT за случайную улику, которую рассказчик мог бы придумать.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('plot.align_failed', { error: err.message });
    draft.engagement = 'UNRELATED';
  }

  const engagement = applyEngagement(process, draft.engagement);
  log.info('plot.align', { summary: process.summary, engagement });
  return engagement;
}

function findProcess(domain, processId) {
  return (domain?.state?.pendingActions || []).find((a) => String(a.id) === String(processId)) || null;
}

/** Пересчитать relation завершившихся дел к текущему closeWhen. */
export async function realignFinishedOutcomes({ runtime, domain, outcomes = [], log } = {}) {
  for (const outcome of outcomes) {
    if (!outcome?.finished) continue;
    const process = findProcess(domain, outcome.processId);
    if (!process) continue;
    const plot = plotsForProcess(domain, outcome.processId).find((p) => isThreeActPlot(p));
    if (!plot) continue;
    const engagement = await judgeProcessAlignment({ runtime, domain, process, plot, log });
    outcome.plotEngagement = engagement || 'UNRELATED';
    outcome.plotAligned = outcome.plotEngagement === 'DIRECT';
  }
  return outcomes;
}
