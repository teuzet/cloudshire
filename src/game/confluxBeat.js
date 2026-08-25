import { newId } from './ids.js';
import { createLoreFact, createCharacterRecord, formatCastForPrompt, findCharacterByName, newCharactersSchema } from './models.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { attachChronicleToPlotlines, clipPlotText, PLOT_SUMMARY_MAX, PLOT_HOOK_MAX } from './plotlines.js';
import { mixedChronicleForPrompt, knownPartnerLore, pushInternalChronicle, chronicleReceiversForBeat } from './confluxBoard.js';
import { priorPlotChronicle } from './storyteller.js';
import { TINT_LABELS, formatFinishForPrompt } from './rolls.js';
import { formatContactForPrompt } from './conflux.js';
import { offerNames, formatOfferedNamesForPrompt, bindCharacterNames } from './names.js';

function chronicleMaxChars(config) {
  return Math.max(80, Number(config?.tick?.chronicleEntryMaxChars) || 260);
}

function cityBrief(domain, max = 500) {
  const text = String(domain?.description || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || '(описание пусто)';
}

function rulerName(domain) {
  return String(domain?.characters?.[0]?.name || '').trim();
}

function domainByCityName(domains, raw) {
  const want = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[«»"]/g, '');
  if (!want) return null;
  return (
    (domains || []).find((d) => String(d.name || '').trim().toLowerCase() === want) ||
    (domains || []).find((d) => want.includes(String(d.name || '').trim().toLowerCase())) ||
    null
  );
}

const CHARACTERS_SCHEMA = newCharactersSchema({ withCity: true });

function registerCharacters(domain, list, { world, plotId = null, author = 'storyteller:conflux' }) {
  if (!domain) return [];
  const added = [];
  const ruler = rulerName(domain).toLowerCase();
  domain.lore = domain.lore || [];
  for (const c of list || []) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    if (ruler && name.toLowerCase() === ruler) continue;
    const existing = findCharacterByName(domain.lore, name);
    if (existing) {
      if (plotId && !existing.relatedPlotlineIds.includes(plotId)) {
        existing.relatedPlotlineIds.push(plotId);
      }
      if (['dead', 'gone'].includes(c.status) && existing.status !== c.status) {
        existing.status = c.status;
      } else if (c.status === 'alive' && ['gone', 'dead'].includes(existing.status)) {
        existing.status = 'alive';
      }
      if (!['male', 'female'].includes(existing.gender) && ['male', 'female'].includes(c.gender)) {
        existing.gender = c.gender;
      }
      continue;
    }
    const record = createCharacterRecord({
      id: newId('lore'),
      name,
      role: c.role,
      about: c.about,
      gender: c.gender,
      status: c.status,
      ageYears: c.ageYears,
      tick: world.tickIndex,
      gameDateLabel: world.gameDate?.label || null,
      author,
      relatedPlotlineIds: plotId ? [plotId] : [],
      world,
    });
    domain.lore.push(record);
    added.push(record);
  }
  return added;
}

function packCity(domain) {
  const ruler = rulerName(domain);
  return [
    `Город «${domain.name}». ${cityBrief(domain)}`,
    ruler ? `Правитель — ${ruler}. Этого человека в newCharacters не заводи.` : null,
    `Известные люди:\n${formatCastForPrompt(domain.lore, { limit: 10 })}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Следующая запись общей истории двух островов: полная правда внутрь стыка,
 * затем каждая сторона пишет свою летопись из того, что ей видно.
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
    scope: 'conflux.beat',
    plotId: plot.id,
  });
  const maxChars = chronicleMaxChars(config);
  const finale = Boolean(beat.finale);
  const entryMax = finale ? Math.round(maxChars * 1.6) : maxChars;
  const draft = { data: null };
  const docked = conflux.status === 'docked';
  const receivers = chronicleReceiversForBeat(conflux, plot, beat, domains);
  if (!docked && !receivers.length) {
    return { fact: null, plot, closed: false, closeReason: '', sequelHook: '', cityFacts: [] };
  }
  const visibleCities = docked ? domains || [] : receivers;
  const names = (visibleCities || []).map((d) => d.name).join(' и ');

  const tools = [
    {
      name: 'submit_plot_beat',
      description: 'Запись этого месяца по истории, которая касается обоих островов.',
      parameters: {
        type: 'object',
        required: ['entry', 'synopsis'],
        properties: {
          entry: {
            type: 'string',
            description: finale
              ? `Чем история кончилась, до ${entryMax} символов: кто был, что сделали, что теперь иначе.`
              : docked
                ? `Что случилось в этом месяце, до ${entryMax} символов. Сухой факт. Назови оба города, если задеты оба. Стражу и войско называй с городом, не голое «стража».`
                : `Что случилось в этом месяце на видимом берегу, до ${entryMax} символов. Сухой факт.`,
          },
          synopsis: {
            type: 'string',
            description: `Как обстоят дела сейчас, до ${PLOT_SUMMARY_MAX} символов. Сначала что уже было, потом где история стоит.`,
          },
          newCharacters: CHARACTERS_SCHEMA,
          closes: {
            type: 'boolean',
            description:
              'true только если в ЭТОМ месяце случилось условие закрытия истории. ' +
              'Срок сам по себе не повод. Не выдумывай развязку, потому что «пора кончать».',
          },
          closeReason: { type: 'string' },
          sequelHook: {
            type: 'string',
            description:
              'Только при closes=true: если развязка сама оставила новый нерешённый узел — одна фраза, что осталось. ' +
              'Нет узла — оставь пустым.',
          },
          hiddenFromOther: {
            type: 'boolean',
            description: 'true только если в этом месяце одну сторону сознательно скрывали от другой.',
          },
          hiddenFromCity: {
            type: 'string',
            description: 'Имя города, от которого скрыли. Только вместе с hiddenFromOther.',
          },
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
    {
      lore: docked
        ? [...(conflux.lore || []), ...domains.flatMap((d) => d.lore || [])]
        : visibleCities.flatMap((d) => d.lore || []),
    },
    plot,
    30,
  );
  const mixed = mixedChronicleForPrompt(visibleCities, { limit: 36 });
  const outcome = beat.processOutcome;
  const ownerName =
    (domains || []).find((d) => String(d.id) === String(outcome?.ownerDomainId))?.name || null;
  const processLine = outcome
    ? outcome.finished
      ? [
          ownerName
            ? `Связанное дело города «${ownerName}»: «${outcome.summary}» ЗАВЕРШЕНО в этом месяце.`
            : `Связанное дело «${outcome.summary}» ЗАВЕРШЕНО в этом месяце.`,
          `Исход броска (не спорь): ${formatFinishForPrompt(outcome.finish, { blessed: outcome.blessed })}.`,
          outcome.goal ? `Цель дела: ${outcome.goal}` : null,
          'Если это был удар одного города по другому — покажи сам удар. Не подменяй его обороной и не меняй, кто напал.',
          outcome.detail ? `Поручение было: ${outcome.detail}` : null,
        ]
          .filter(Boolean)
          .join(' ')
      : outcome.kind === 'stall'
        ? `Связанное дело «${outcome.summary}» встало: месяц без сдвига — расскажи, что помешало.`
        : `Связанное дело «${outcome.summary}» пошло быстрее обычного — расскажи, что позволило.`
    : null;

  const nameOffer = offerNames(world, { female: 4, male: 4 });

  try {
    await runtime.run({
      agentId: 'confluxBeat',
      tools,
      maxTurns: 5,
      toolChoice: { type: 'function', function: { name: 'submit_plot_beat' } },
      log,
      scene: 'conflux_story_beat',
      domainId: (conflux.domainIds || []).join('+'),
      extraSystem: visibleCities.map(packCity).join('\n\n'),
      userMessages: [
        {
          role: 'user',
          content: [
            `Дата: ${world.gameDate?.label || ''}. ${docked ? `Города: ${names}.` : `Город: ${names}.`}`,
            `История «${plot.title}».`,
            docked
              ? plot.isMainConflux
                ? 'Это главная история встречи двух островов.'
                : 'Эта история касается обоих городов.'
              : 'Острова ещё не сошлись: внутренней жизни соседнего города не видно, в запись её не пиши.',
            `Сейчас: ${plot.synopsis || 'только началась'}`,
            plot.closeWhen
              ? `Историю можно закрыть, когда случится: ${plot.closeWhen}. Это условие развязки, не срок.`
              : null,
            prior.length ? `\nУже записано по этой истории (не отменяй):\n${prior.join('\n')}` : null,
            mixed
              ? docked
                ? `\nЧто недавно видели оба берега:\n${mixed}`
                : `\nНедавняя хроника этого берега:\n${mixed}`
              : null,
            '',
            `ИСХОД ЭТОГО МЕСЯЦА (решено броском, не спорь): ${TINT_LABELS[beat.tint] || beat.tintLabel || 'двойственно'}.`,
            processLine,
            finale
              ? 'Проходное дело закончилось: покажи итог. closes=true.'
              : outcome?.finished
                ? 'Дело закончилось. Напиши его итог, не отменяя уже записанную хронику. closes=true, только если этим исполнилось условие закрытия самой истории.'
                : 'Сдвинь историю по исходу броска. closes=true — только если в этом месяце случилось условие закрытия, даже если до срока ещё далеко. Не закрывай и не выдумывай развязку просто потому что история старая. Если закрываешь и после развязки остался новый нерешённый узел — sequelHook одной фразой, иначе пусто.',
            docked && conflux.contact?.kind
              ? `${formatContactForPrompt(conflux.contact)} Пиши только то, что при таком проходе возможно.`
              : docked
                ? null
                : 'Прямого прохода между островами ещё нет.',
            logLine ? `Этим месяцем: ${logLine}` : null,
            '',
            formatOfferedNamesForPrompt(nameOffer),
            '',
            'Вызови submit_plot_beat. Только запись этого месяца; карточку истории не переписывай, кроме синопсиса.',
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

  const boundPeople = bindCharacterNames(world, d?.newCharacters || [], {
    offered: nameOffer,
    texts: [entry, d?.synopsis || ''],
  });
  const entryBound = boundPeople.texts[0] || entry;
  if (boundPeople.texts[1] && d?.synopsis) plot.synopsis = clipPlotText(boundPeople.texts[1], PLOT_SUMMARY_MAX);

  const hiddenFrom = d?.hiddenFromOther ? domainByCityName(domains, d.hiddenFromCity) : null;
  const secretOwner = hiddenFrom ? (domains || []).find((x) => x.id !== hiddenFrom.id) || null : null;
  for (const person of boundPeople.list || []) {
    const home =
      domainByCityName(visibleCities, person.city) ||
      domainByCityName(domains, person.city) ||
      secretOwner ||
      visibleCities[0] ||
      domains[0];
    registerCharacters(home, [person], { world, plotId: plot.id });
  }

  const internal = pushInternalChronicle(conflux, {
    text: entryBound,
    world,
    plotIds: [plot.id],
    tags: plot.isMainConflux ? ['conflux-main'] : ['conflux-shared'],
    author: 'storyteller:conflux',
  });
  if (secretOwner) {
    internal.secret = true;
    internal.secretForDomainId = secretOwner.id;
  }

  const cityFacts = [];
  for (const domain of receivers) {
    if (internal.secret && hiddenFrom && domain.id === hiddenFrom.id) continue;
    if (!docked) {
      const fact = createLoreFact({
        id: newId('lore'),
        text: entry,
        tags: ['chronicle', 'conflux', `conflux:${conflux.id}`],
        gameDateLabel: world.gameDate.label,
        tick: world.tickIndex,
        author: 'storyteller:conflux',
        importance: plot.isMainConflux ? 'critical' : 'major',
        relatedPlotlineIds: [plot.id],
      });
      domain.lore = domain.lore || [];
      domain.lore.push(fact);
      attachChronicleToPlotlines({ plotlines: [plot] }, fact.id, [plot.id]);
      plot.chronicleIds = plot.chronicleIds || [];
      if (!plot.chronicleIds.includes(fact.id)) plot.chronicleIds.push(fact.id);
      cityFacts.push({ domainId: domain.id, fact });
      continue;
    }
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

  const sequelHook =
    d?.closes && plot.kind !== 'errand' ? clipPlotText(String(d.sequelHook || '').trim(), PLOT_HOOK_MAX) : '';

  log.info('conflux.beat', {
    plotId: plot.id,
    preview: truncate(entry, 160),
    cities: cityFacts.length,
  });

  return {
    fact: internal,
    plot,
    closed: Boolean(d?.closes || finale),
    closeReason: d?.closeReason || (finale ? 'дело закончилось' : ''),
    sequelHook,
    cityFacts,
  };
}

function fallbackSharedEntry(plot, beat, domains) {
  const names = (domains || []).map((d) => `«${d.name}»`).join(' и ');
  return beat?.finale
    ? `История «${plot.title}» на сопряжении ${names} подошла к концу.`
    : `На сопряжении ${names} история «${plot.title}» сдвинулась.`;
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
  const draft = { text: null };
  const maxChars = chronicleMaxChars(config);

  const tools = [
    {
      name: 'submit_chronicle',
      description: `Запись в летопись «${domain.name}» о том, что увидели при сопряжении.`,
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: `Что записали в «${domain.name}», до ${maxChars} символов.` },
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
    : 'Об этом соседе здесь почти ничего не знают.';

  try {
    await runtime.run({
      agentId: 'subjectificator',
      tools,
      maxTurns: 4,
      toolChoice: { type: 'function', function: { name: 'submit_chronicle' } },
      log,
      scene: 'conflux_subjectify',
      domainId: domain.id,
      extraSystem: [
        packCity(domain),
        `Ты пишешь летопись ТОЛЬКО города «${domain.name}». Сосед — «${partner?.name || '?'}». Не путай берега.`,
      ].join('\n'),
      userMessages: [
        {
          role: 'user',
          content: [
            `ЭТО ЛЕТОПИСЬ ГОРОДА «${domain.name}». Не летопись соседа «${partner?.name || '?'}».`,
            `Пиши, как увидели и записали ЗДЕСЬ, в «${domain.name}».`,
            conflux.contact?.kind ? formatContactForPrompt(conflux.contact) : null,
            `История: «${plot.title}».`,
            `Что случилось (это правда; берег меняет только вид и пробелы, не кто напал): ${internal.text}`,
            'Что этому городу уже известно о соседе:',
            knownBlock,
            `Напиши, как это записали в «${domain.name}». Не переворачивай стороны. Вызови submit_chronicle.`,
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
      : `Слышали об истории «${plot.title}» на сопряжении, но подробностей мало.`);

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
