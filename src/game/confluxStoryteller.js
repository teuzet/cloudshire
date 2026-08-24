import { newId } from './ids.js';
import { createLoreFact } from './models.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { attachChronicleToPlotlines, clipPlotText, PLOT_SUMMARY_MAX } from './plotlines.js';
import { mixedChronicleForPrompt, knownPartnerLore, pushInternalChronicle } from './confluxBoard.js';
import { priorPlotChronicle } from './storyteller.js';

function chronicleMaxChars(config) {
  return Math.max(80, Number(config?.tick?.chronicleEntryMaxChars) || 260);
}

/**
 * Бит shared-нити: полная правда во внутреннюю хронику конфлюкса, затем субъективация в летописи городов.
 */
export async function beatSharedPlot({
  config,
  runtime,
  conflux,
  domains,
  world,
  plot,
  beat,
  logLine = null,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({
    scope: 'conflux.storyteller',
    plotId: plot.id,
  });
  const maxChars = chronicleMaxChars(config);
  const finale = Boolean(beat.finale);
  const entryMax = finale ? Math.round(maxChars * 1.6) : maxChars;
  const draft = { data: null };
  const names = (domains || []).map((d) => d.name).join(' и ');

  const tools = [
    {
      name: 'submit_conflux_beat',
      description: 'Объективная запись месяца по общей истории двух островов.',
      parameters: {
        type: 'object',
        required: ['entry', 'synopsis'],
        properties: {
          entry: {
            type: 'string',
            description: `Что случилось, до ${entryMax} символов. Сухой факт. Назови оба города, если задеты оба.`,
          },
          synopsis: {
            type: 'string',
            description: `Как обстоят дела сейчас, до ${PLOT_SUMMARY_MAX} символов.`,
          },
          secret: {
            type: 'boolean',
            description: 'true только для явной тайной операции одной стороны',
          },
          secretForDomainId: { type: 'string' },
          closes: { type: 'boolean' },
          closeReason: { type: 'string' },
        },
      },
      handler: async (args) => {
        if (!String(args.entry || '').trim()) return toolFail('empty', 'Нужна запись хроники.');
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const prior = priorPlotChronicle(
    { lore: [...(conflux.lore || []), ...domains.flatMap((d) => d.lore || [])] },
    plot,
    30,
  );
  const mixed = mixedChronicleForPrompt(domains, { limit: 36 });
  const outcome = beat.processOutcome;
  const processLine = outcome
    ? outcome.finished
      ? `Связанное дело «${outcome.summary}» ЗАВЕРШЕНО (${outcome.finishLabel || outcome.finish || 'успех'}).`
      : outcome.kind === 'stall'
        ? `Дело «${outcome.summary}» встало.`
        : `Дело «${outcome.summary}» пошло быстрее обычного.`
    : null;

  try {
    await runtime.run({
      agentId: 'confluxStoryteller',
      tools,
      maxTurns: 5,
      toolChoice: { type: 'function', function: { name: 'submit_conflux_beat' } },
      log,
      scene: 'conflux_story_beat',
      domainId: (conflux.domainIds || []).join('+'),
      userMessages: [
        {
          role: 'user',
          content: [
            `Дата: ${world.gameDate?.label || ''}. Города: ${names}.`,
            `История: «${plot.title}».`,
            plot.isMainConflux ? 'Это ГЛАВНАЯ нить стыка двух островов.' : 'Это общая нить двух городов.',
            `Синопсис: ${plot.synopsis}`,
            `Закрыть, когда: ${plot.closeWhen || '—'}`,
            `Окраска месяца: ${beat.tintLabel || beat.tint || 'двойственно'}.`,
            processLine,
            logLine ? `Журнал дня: ${logLine}` : '',
            prior.length ? `Уже записано по этой нити:\n${prior.join('\n')}` : '',
            mixed ? `Смешанная хроника обоих (публичная, по дате):\n${mixed}` : '',
            `Контакт: ${conflux.contact?.kind || 'ещё сближение'} ${conflux.contact?.description || ''}`,
            `Запись до ${entryMax} символов. Вызови submit_conflux_beat.`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('conflux.beat_failed', { error: err.message, plotId: plot.id });
  }

  const d = draft.data;
  const entry = String(d?.entry || '').trim() || fallbackSharedEntry(plot, beat, domains);
  if (d?.synopsis) plot.synopsis = clipPlotText(d.synopsis, PLOT_SUMMARY_MAX);
  plot.lastBeatTick = world.tickIndex;
  plot.beatCount = Number(plot.beatCount || 0) + 1;

  const internal = pushInternalChronicle(conflux, {
    text: entry,
    world,
    plotIds: [plot.id],
    tags: plot.isMainConflux ? ['conflux-main'] : ['conflux-shared'],
    author: 'storyteller:conflux',
  });
  if (d?.secret && d.secretForDomainId) {
    internal.secret = true;
    internal.secretForDomainId = String(d.secretForDomainId);
  }

  const cityFacts = [];
  for (const domain of domains || []) {
    if (!(plot.concernsDomainIds || []).includes(domain.id) && !plot.isMainConflux) continue;
    const cityFact = await subjectifyEntry({
      config,
      runtime,
      conflux,
      domain,
      partner: domains.find((x) => x.id !== domain.id) || null,
      plot,
      internal,
      world,
      log,
    });
    if (cityFact) cityFacts.push({ domainId: domain.id, fact: cityFact });
  }

  log.info('conflux.beat', {
    plotId: plot.id,
    preview: truncate(entry, 160),
    cities: cityFacts.length,
  });

  return {
    fact: internal,
    plot,
    closed: Boolean(d?.closes),
    closeReason: d?.closeReason || '',
    cityFacts,
  };
}

function fallbackSharedEntry(plot, beat, domains) {
  const names = (domains || []).map((d) => `«${d.name}»`).join(' и ');
  return beat?.finale
    ? `История «${plot.title}» на стыке ${names} подошла к концу.`
    : `На стыке ${names} история «${plot.title}» сдвинулась.`;
}

async function subjectifyEntry({
  config,
  runtime,
  conflux,
  domain,
  partner,
  plot,
  internal,
  world,
  log,
}) {
  const known = partner ? knownPartnerLore(partner, conflux, domain.id) : [];
  const awareness = Number(conflux.awareness?.[domain.id] || 0);
  const draft = { text: null };
  const maxChars = chronicleMaxChars(config);

  const tools = [
    {
      name: 'submit_subjective',
      description: 'Как ЭТОТ город запишет событие в свою летопись, исходя из того, что ему известно.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: `Запись для летописи «${domain.name}», до ${maxChars} символов.` },
        },
      },
      handler: async ({ text }) => {
        const body = String(text || '').trim();
        if (body.length < 12) return toolFail('too_short', 'Нужна связная запись.');
        draft.text = body.slice(0, maxChars * 2);
        return { ok: true };
      },
    },
  ];

  const knownBlock = known.length
    ? known.slice(-20).map((f) => `- ${f.text}`).join('\n')
    : '(о соседе почти ничего не известно)';

  try {
    await runtime.run({
      agentId: 'subjectificator',
      tools,
      maxTurns: 4,
      toolChoice: { type: 'function', function: { name: 'submit_subjective' } },
      log,
      scene: 'conflux_subjectify',
      domainId: domain.id,
      userMessages: [
        {
          role: 'user',
          content: [
            `Город летописи: «${domain.name}». Сосед: «${partner?.name || '?'}».`,
            `Информированность: ${awareness}/100.`,
            `История: «${plot.title}».`,
            `Объективное событие (внутренняя правда стыка): ${internal.text}`,
            internal.secret && internal.secretForDomainId !== domain.id
              ? 'Эта внутренняя запись SECRET чужого города — не раскрывай её.'
              : '',
            'Что этому городу уже известно о соседе:',
            knownBlock,
            'Перепиши событие так, как его могли зафиксировать ЗДЕСЬ: неполно, со своей стороны.',
            'Не выдумывай факты, которых нет ни в событии, ни в известных записях.',
            'Если почти ничего не известно — опиши только то, что видно с этого острова.',
            'Вызови submit_subjective.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('conflux.subjectify_failed', { error: err.message, domainId: domain.id });
  }

  const text =
    String(draft.text || '').trim() ||
    (plotConcernsFallback(plot, domain.id)
      ? internal.text
      : `Слышали об истории «${plot.title}» на стыке, но подробностей мало.`);

  if (internal.secret && internal.secretForDomainId && internal.secretForDomainId !== domain.id) {
    return null;
  }

  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'subjective'],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author: 'subjectificator',
    importance: plot.isMainConflux ? 'critical' : 'major',
    relatedPlotlineIds: [plot.id],
    secret: Boolean(internal.secret && internal.secretForDomainId === domain.id),
    secretForDomainId: internal.secretForDomainId === domain.id ? domain.id : null,
  });
  domain.lore = domain.lore || [];
  domain.lore.push(fact);
  attachChronicleToPlotlines({ plotlines: [plot] }, fact.id, [plot.id]);
  plot.chronicleIds = plot.chronicleIds || [];
  if (!plot.chronicleIds.includes(fact.id)) plot.chronicleIds.push(fact.id);
  return fact;
}

function plotConcernsFallback(plot, domainId) {
  return (plot.concernsDomainIds || []).includes(domainId) || plot.isMainConflux;
}
