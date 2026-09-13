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
    hostDomainId: plot?.hostDomainId,
    concernsDomainIds: plot?.concernsDomainIds,
  });
  const hidden = Array.isArray(plot?.hiddenPremises) && plot.hiddenPremises.length
    ? plot.hiddenPremises.join('; ')
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
      extraSystem:
        'Есть два города на летающих островах. Проход только что исчез: острова разошлись. ' +
        'Может ли уже идущая история продолжаться в названном городе без соседа? Верни submit_continuation.',
      userMessages: [
        {
          role: 'user',
          content: [
            world?.gameDate?.label ? `Сейчас ${world.gameDate.label}.` : '',
            `Город, о котором вопрос: «${domain.name}».`,
            partner ? `Соседний город уходит: «${partner.name}».` : null,
            `История «${publicPlot.title}».`,
            `Сейчас: ${publicPlot.synopsis || ''}`,
            publicPlot.closeWhen ? `Закроется, когда: ${publicPlot.closeWhen}` : null,
            publicPlot.hostDomainId === domain.id ? 'Этот город вёл историю.' : 'Этот город историю не вёл.',
            hidden ? `Скрытый слой (только чтобы судить, живёт ли причина здесь): ${hidden}` : null,
            'Может ли эта причина продолжаться ЗДЕСЬ, если соседнего острова больше нет?',
            'Да: место, люди, вещь, обряд этого острова.',
            'Нет: вещь, которую унёс сосед; проход между островами; общий двор, которого больше нет.',
            'Тот, кто вёл историю, не получает «да» автоматически.',
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
