import { isThreeActPlot } from './plotlines.js';
import { getLogger } from '../log.js';

function clampStakes(n, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(5, Math.min(95, v));
}

/** Простой контракт: urgency всегда; gravity — только у тайны. У саспенса gravity уже посеял движок. */
export async function assignPlotStakes({ runtime, domain, plot, world, log: parentLog }) {
  if (!isThreeActPlot(plot)) return plot;
  const log = (parentLog || getLogger()).child({ scope: 'plot.stakes', plotId: plot.id });
  const suspense = plot.storyType === 'suspense';
  const draft = { data: null };
  const type = plot.storyType === 'mystery' ? 'тайна (неизвестно, что было)' : 'саспенс (неизвестно, что будет)';
  const seededGravity = Number(plot.gravity);
  const gravitySeeded = suspense || (plot.storyType === 'mystery' && plot.annotationId && Number.isFinite(seededGravity));
  try {
    await runtime.run({
      agentId: 'plotStakes',
      tools: [
        {
          name: 'submit_stakes',
          description: gravitySeeded
            ? 'urgency этой истории, 0–100. Gravity уже задана. Сюжет не пиши.'
            : 'urgency и gravity этой истории, 0–100. Сюжет не пиши.',
          parameters: {
            type: 'object',
            required: gravitySeeded ? ['urgency'] : ['urgency', 'gravity'],
            properties: {
              urgency: {
                type: 'number',
                description:
                  '0–100. Насколько естественно эта история САМА ухудшается со временем, если город ею не занимается. ' +
                  'Не страшность и не желание игрока ответить. 0–15 почти статична; 86–100 почти каждый месяц бездействия ухудшает.',
              },
              gravity: {
                type: 'number',
                description:
                  '0–100. Насколько серьёзны для города последствия, если проблема реализуется или останется нерешённой. ' +
                  'Не связывать автоматически с urgency. 0–15 частный вред; 86–100 угроза существованию города — редко.',
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
            plot.dynamic ? `Динамика без вмешательства (нарративный характер): ${plot.dynamic}.` : '',
            gravitySeeded
              ? `Gravity уже посеяна: ${Number.isFinite(seededGravity) ? seededGravity : 40}. Не ставь и не меняй её.`
              : '',
            gravitySeeded
              ? 'Поставь только urgency (собственная динамика без вмешательства).'
              : 'Поставь urgency (собственная динамика без вмешательства) и gravity (тяжесть последствий для города).',
            'Числа независимы: тяжёлое может быть медленным, быстрое — локальным. Не завышай ради интересности.',
            'Только submit_stakes, без сюжета.',
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
  if (gravitySeeded && Number.isFinite(seededGravity)) {
    plot.gravity = Math.max(0, Math.min(100, Math.round(seededGravity)));
  } else {
    plot.gravity = clampStakes(draft.data?.gravity, 40);
  }
  plot.urgency0 = plot.urgency;
  plot.gravity0 = plot.gravity;
  log.info('plot.stakes', { title: plot.title, urgency: plot.urgency, gravity: plot.gravity, seeded: gravitySeeded });
  return plot;
}
