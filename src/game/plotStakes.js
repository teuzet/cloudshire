import { isThreeActPlot } from './plotlines.js';
import { getLogger } from '../log.js';

function clampStakes(n, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(5, Math.min(95, v));
}

/** Простой контракт: выставить urgency и gravity новой истории. */
export async function assignPlotStakes({ runtime, domain, plot, world, log: parentLog }) {
  if (!isThreeActPlot(plot)) return plot;
  const log = (parentLog || getLogger()).child({ scope: 'plot.stakes', plotId: plot.id });
  const draft = { data: null };
  const type = plot.storyType === 'mystery' ? 'тайна (неизвестно, что было)' : 'саспенс (неизвестно, что будет)';

  try {
    await runtime.run({
      agentId: 'plotStakes',
      tools: [
        {
          name: 'submit_stakes',
          description: 'Срочность и масштаб этой истории, 0–100.',
          parameters: {
            type: 'object',
            required: ['urgency', 'gravity'],
            properties: {
              urgency: {
                type: 'number',
                description: 'Как скоро история сама ударит, если ею не заняться. 20 — может подождать, 80 — каждый месяц давит.',
              },
              gravity: {
                type: 'number',
                description: 'Насколько это судьбоносно для города. Квартал ≈ 30, город ≈ 55, весь остров ≈ 75.',
              },
            },
          },
          handler: async (args) => {
            draft.data = args;
            return { ok: true };
          },
        },
      ],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_stakes' } },
      log,
      scene: 'plot_stakes',
      domainId: domain.id,
      userMessages: [
        {
          role: 'user',
          content: [
            `Город «${domain.name}». Дата: ${world?.gameDate?.label || ''}.`,
            `История «${plot.title}» (${type}).`,
            `Сейчас: ${plot.synopsis || ''}`,
            plot.closeWhen ? `Кончится, когда: ${plot.closeWhen}` : '',
            'Поставь urgency (давление времени) и gravity (масштаб для города). Только числа, без сюжета.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('plot.stakes_failed', { error: err.message });
  }

  plot.urgency = clampStakes(draft.data?.urgency, 40);
  plot.gravity = clampStakes(draft.data?.gravity, 40);
  plot.urgency0 = plot.urgency;
  plot.gravity0 = plot.gravity;
  plot.importance = Math.min(100, plot.gravity);
  log.info('plot.stakes', { title: plot.title, urgency: plot.urgency, gravity: plot.gravity });
  return plot;
}
