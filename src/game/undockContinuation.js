import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { stripPlotSecrets } from './plotlines.js';

/**
 * Может ли эта предпосылка жить в городе без соседа.
 * Хозяин не получает «да» автоматически: судят причинную локальность.
 */
export async function decideUndockContinuation({
  runtime,
  plot,
  domain,
  partner = null,
  world = null,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({
    scope: 'conflux.undock_keep',
    plotId: plot?.id,
    domainId: domain?.id,
  });
  const draft = { keep: null };
  const publicPlot = stripPlotSecrets({
    title: plot?.title,
    synopsis: plot?.synopsis,
    closeWhen: plot?.closeWhen,
    storyType: plot?.storyType,
    hostDomainId: plot?.hostDomainId,
    concernsDomainIds: plot?.concernsDomainIds,
    source: plot?.source,
    situation: plot?.situation,
  });
  const hidden =
    plot?.storyType === 'mystery'
      ? plot.truthGraph || plot.truth || null
      : plot?.storyType === 'suspense'
        ? { hiddenPremises: plot.hiddenPremises, discoveryLadder: plot.discoveryLadder }
        : null;

  try {
    await runtime.run({
      agentId: 'undockContinuation',
      tools: [
        {
          name: 'submit_continuation',
          description: 'Может ли эта история дальше жить в названном городе без соседа.',
          parameters: {
            type: 'object',
            required: ['keep'],
            properties: {
              keep: {
                type: 'boolean',
                description: 'true — предпосылка локальна для этого города; false — без соседа история здесь не стоит.',
              },
              reason: { type: 'string' },
            },
          },
          handler: async ({ keep }) => {
            if (typeof keep !== 'boolean') {
              return toolFail('keep_required', 'Нужен keep: true или false.');
            }
            draft.keep = keep;
            return { ok: true };
          },
        },
      ],
      maxTurns: 3,
      toolChoice: { type: 'function', function: { name: 'submit_continuation' } },
      log,
      scene: 'conflux_undock_keep',
      domainId: domain.id,
      userMessages: [
        {
          role: 'user',
          content: [
            `Дата: ${world?.gameDate?.label || ''}.`,
            `Город, о котором вопрос: «${domain.name}» (id ${domain.id}).`,
            partner ? `Сосед, который уходит: «${partner.name}».` : null,
            `История «${publicPlot.title}». Тип: ${publicPlot.storyType || 'story'}.`,
            `Сейчас: ${publicPlot.synopsis || ''}`,
            publicPlot.closeWhen ? `Закроется, когда: ${publicPlot.closeWhen}` : null,
            publicPlot.hostDomainId === domain.id ? 'Этот город был хозяином нити.' : 'Этот город не хозяин нити.',
            hidden
              ? `Внутренний канон (игроку не отдавать, только для суждения локальности): ${JSON.stringify(hidden)}`
              : null,
            'Спроси себя: может ли эта предпосылка продолжаться ЗДЕСЬ, если соседнего острова больше нет?',
            'Да: холодный ход в скале этого острова, местный культ, местный спор.',
            'Нет: украденную соседом вещь хозяин уже не держит; мост между островами; общий двор, который распался.',
            'Хозяин не значит «да». Смотри причинную локальность, не титул.',
            'Вызови submit_continuation.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('conflux.undock_keep_failed', { error: err.message });
  }

  if (draft.keep == null) {
    // Сбой агента: не забираем нить, чтобы не плодить ложные продолжения.
    return false;
  }
  log.info('conflux.undock_keep', { plotId: plot.id, domainId: domain.id, keep: draft.keep });
  return draft.keep;
}
