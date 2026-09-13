/**
 * Канон пары: одно событие — одна нейтральная запись — два взгляда.
 *
 * Пометка места обязательна: проход не происходит ни в одном из городов.
 * Фон архива субъектификатору даётся отдельно от того, что городу можно знать.
 */

import { writeChronicle } from './chronicler.js';
import { appendChronicle } from './freeform.js';
import { createLoreFact } from './models.js';
import { newId } from './ids.js';
import { plotHostId, plotConcerns } from './confluxBoard.js';
import { gameDateFromDay } from './gameClock.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { afterPairLoreWrite } from './confluxForecast.js';

export const PLACE_PAIR = 'pair';
export const FROZEN_SYNOPSIS_PREFIX = 'Что случилось в этой истории на данный момент:';

export function confluxEvent({
  kind,
  day = 0,
  actorDomainId = null,
  targetDomainId = null,
  deed = null,
  outcome = null,
  plotId = null,
  passageState = null,
  learnedHow = null,
  statDeltas = null,
  textHint = '',
} = {}) {
  return {
    kind: String(kind || 'event'),
    day: Math.round(Number(day) || 0),
    actorDomainId: actorDomainId ? String(actorDomainId) : null,
    targetDomainId: targetDomainId ? String(targetDomainId) : null,
    deed: deed || null,
    outcome: outcome || null,
    plotId: plotId || null,
    passageState: passageState || null,
    learnedHow: learnedHow || null,
    statDeltas: statDeltas || null,
    textHint: String(textHint || '').trim(),
  };
}

function touches(event, domainId) {
  if (!event || !domainId) return false;
  const id = String(domainId);
  if (event.actorDomainId === id) return true;
  if (event.targetDomainId === id) return true;
  if (!event.actorDomainId && !event.targetDomainId) return true;
  return false;
}

function oneSidedVictim(event, domainId) {
  const id = String(domainId);
  return (
    event.targetDomainId === id &&
    event.actorDomainId &&
    event.actorDomainId !== id &&
    (event.outcome === 'secret_ok' || event.kind === 'sabotage_hidden')
  );
}

function viewpointPrompt(event, domain, partner) {
  const self = domain?.name || 'этот город';
  const other = partner?.name || 'соседний город';
  const actorIsSelf = event.actorDomainId === domain.id;
  const targetIsSelf = event.targetDomainId === domain.id;
  const who =
    actorIsSelf && targetIsSelf
      ? `Событие произошло у нас в «${self}».`
      : actorIsSelf
        ? `Действовали мы («${self}»), сторона — «${other}».`
        : targetIsSelf
          ? `Действовал сосед («${other}»), задеты мы («${self}»).`
          : `Событие на сопряжении «${self}» и «${other}».`;
  const hidden = oneSidedVictim(event, domain.id)
    ? 'Мы видели следствие, причины не знаем. Причину не выдумывай и не раскрывай.'
    : '';
  return [
    who,
    event.textHint ? `Что случилось: ${event.textHint}` : '',
    event.deed?.summary ? `Поручение (не повторяй как отчёт): ${event.deed.summary}` : '',
    event.outcome ? `Исход: ${event.outcome}` : '',
    event.passageState ? `Проход сейчас: ${event.passageState}` : '',
    event.learnedHow ? `Как узнали: ${event.learnedHow}` : '',
    hidden,
    'Пиши летопись ЭТОГО города. Соседа не делай «нами».',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Записать событие пары. Город, которого оно не коснулось, записи не получает.
 * Старый вход для стыковки и расстыковки: у них нет городской хроники-источника.
 */
export async function writePairChronicle({
  runtime,
  world,
  event,
  domains = [],
  conflux = null,
  log,
} = {}) {
  const facts = [];
  if (!event) return facts;
  for (const domain of domains) {
    if (!touches(event, domain.id)) continue;
    const partner = domains.find((d) => d.id !== domain.id) || null;
    const prompt = viewpointPrompt(event, domain, partner);
    const written = runtime
      ? await writeChronicle({
          runtime,
          domain,
          occasion: 'дело',
          prompt,
          log,
        })
      : null;
    const text = String(written?.text || event.textHint || '').trim();
    if (!text) continue;
    const fact = appendChronicle(domain, world, {
      text,
      plotId: event.plotId || conflux?.container?.id || conflux?.mainPlotId || null,
      author: 'chronicler',
      importance: 'major',
      tags: ['chronicle', 'conflux', conflux?.id ? `conflux:${conflux.id}` : null].filter(Boolean),
      day: event.day,
    });
    facts.push({ domainId: domain.id, fact });
  }
  return facts;
}

export function hasLeakedToPair(plot) {
  return plot?.leakedToConfluxAt != null && plot.leakedToConfluxAt !== '';
}

export function markLeakedToPair(plot, day = 0) {
  if (!plot || hasLeakedToPair(plot)) return plot;
  plot.leakedToConfluxAt = Math.round(Number(day) || 0);
  return plot;
}

/**
 * Один бинарный вопрос: запись касается одного города или обоих.
 * Судья зовётся только когда ответа нет в данных.
 */
export function chronicleConcernFromData({
  process = null,
  plot = null,
  domain = null,
  partner = null,
  conflux = null,
} = {}) {
  if (!conflux || conflux.status !== 'docked' || !partner || !domain) return 'one';
  const partnerId = String(partner.id);
  const domainId = String(domain.id);
  if (process?.targetDomainId && String(process.targetDomainId) === partnerId) return 'both';
  if (plot?.isMainConflux) return 'both';
  const host = plotHostId(plot);
  if (host && host === partnerId) return 'both';
  if (plot && plotConcerns(plot, partnerId) && plotConcerns(plot, domainId)) return 'both';
  if (plot && !plot.isMainConflux) return 'judge';
  return 'one';
}

export function placeForBeat({ process = null, domain = null, partner = null } = {}) {
  if (process?.targetDomainId && partner && String(process.targetDomainId) === String(partner.id)) {
    return PLACE_PAIR;
  }
  return domain?.id ? String(domain.id) : PLACE_PAIR;
}

function dateLabel(world, day) {
  if (day != null && day !== '' && Number.isFinite(Number(day))) {
    return gameDateFromDay(Number(day)).label;
  }
  return world?.gameDate?.label || '';
}

export function appendPairEntry(
  conflux,
  world,
  { text, place, plotId = null, day = null, author = 'conflux-canon', frozen = false, tags = [] } = {},
) {
  if (!conflux || !String(text || '').trim()) return null;
  const fact = createLoreFact({
    id: newId('lore'),
    text: String(text).trim(),
    tags: [
      'chronicle',
      'conflux',
      conflux.id ? `conflux:${conflux.id}` : null,
      frozen ? 'frozen-synopsis' : 'pair-canon',
      ...tags,
    ].filter(Boolean),
    gameDateLabel: dateLabel(world, day),
    tick: world?.tickIndex ?? null,
    day,
    author,
    importance: frozen ? 'minor' : 'major',
    relatedPlotlineIds: plotId ? [plotId] : null,
    sourcePlotId: plotId || null,
  });
  fact.place = place || PLACE_PAIR;
  if (frozen) fact.frozenSynopsis = true;
  conflux.lore = Array.isArray(conflux.lore) ? conflux.lore : [];
  conflux.lore.push(fact);
  return fact;
}

export function freezePlotSynopsis(conflux, world, plot, { day = null, hostId = null } = {}) {
  const synopsis = String(plot?.synopsis || '').trim();
  if (!synopsis) return null;
  return appendPairEntry(conflux, world, {
    text: `${FROZEN_SYNOPSIS_PREFIX} ${synopsis}`,
    place: hostId || plotHostId(plot) || PLACE_PAIR,
    plotId: plot.id,
    day,
    author: 'conflux-archive',
    frozen: true,
  });
}

function placeCaption(place, domains = []) {
  if (!place || place === PLACE_PAIR) return 'на проходе';
  const city = (domains || []).find((d) => String(d.id) === String(place));
  return city?.name ? `в «${city.name}»` : 'в одном из городов';
}

/** Полный архив пары с пометкой места. Не выжимка. */
export function formatPairArchive(conflux, domains = []) {
  const rows = [];
  for (const fact of conflux?.lore || []) {
    if (fact?.secret) continue;
    const where = placeCaption(fact.place, domains);
    const frozen = fact.frozenSynopsis ? ' [архив: не новость]' : '';
    rows.push(`- (${fact.gameDateLabel || '?'}, ${where}${frozen}) ${fact.text}`);
  }
  return rows.join('\n');
}

export async function judgeChronicleLeak({
  runtime,
  text,
  domain,
  partner,
  log,
} = {}) {
  if (!runtime || !String(text || '').trim()) return 'one';
  const draft = { both: false };
  try {
    await runtime.run({
      agentId: 'confluxLeak',
      scene: 'conflux_leak',
      log,
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_leak' } },
      tools: [
        {
          name: 'submit_leak',
          description: 'Затрагивает ли событие второй город напрямую.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['both'],
            properties: {
              both: {
                type: 'boolean',
                description:
                  'true, если событие напрямую коснулось второго города, прохода между островами или берега второго острова.',
              },
            },
          },
          handler: async (args) => {
            draft.both = Boolean(args?.both);
            return { ok: true };
          },
        },
      ],
      extraSystem:
        'Смотри только текст события, не сюжет вокруг. ' +
        'both=true, если оно напрямую коснулось второго города, прохода между островами или берега второго острова. ' +
        'Намёка недостаточно. Иначе both=false. Верни submit_leak.',
      userMessages: [
        {
          role: 'user',
          content: [
            `Первый город: «${domain?.name || '?'}». Второй город: «${partner?.name || '?'}».`,
            'Событие связано с первым городом. Решай только по тексту ниже, не по догадке о теме.',
            `Событие:\n${String(text).trim()}`,
            'Затрагивает ли это второй город, проход или берег второго острова напрямую? Вызови submit_leak.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    (log || getLogger()).warn('conflux.leak_judge_failed', { error: err.message });
    return 'one';
  }
  return draft.both ? 'both' : 'one';
}

export async function renderCityView({
  runtime,
  world,
  conflux,
  domain,
  partner,
  plot,
  sourceText,
  archive,
  day,
  log,
}) {
  const knows = String(sourceText || '').trim();
  if (!knows) return null;
  let text = knows;
  if (runtime) {
    const draft = { text: null };
    try {
      await runtime.run({
        agentId: 'subjectificator',
        scene: 'conflux_subjectify',
        log,
        domainId: domain.id,
        maxTurns: 4,
        toolChoice: { type: 'function', function: { name: 'submit_chronicle' } },
        tools: [
          {
            name: 'submit_chronicle',
            description: `Запись в летопись «${domain.name}».`,
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['text'],
              properties: { text: { type: 'string' } },
            },
            handler: async (args) => {
              const body = String(args?.text || '').trim();
              if (body.length < 8) return toolFail('too_short', 'Нужна связная запись.');
              draft.text = body;
              return { ok: true };
            },
          },
        ],
        extraSystem: [
          `Есть два города на летающих островах. Края вместе, между ними проход.`,
          `Пиши летопись ТОЛЬКО города «${domain.name}». Сосед — «${partner?.name || '?'}».`,
          'Соседа не делай «нами». Не переворачивай стороны.',
        ].join(' '),
        userMessages: [
          {
            role: 'user',
            content: [
              `Это летопись города «${domain.name}».`,
              `Что этому городу можно знать и записать:\n${knows}`,
              archive
                ? `Уже известное этому берегу о времени, пока острова вместе (не пересказывай чужое):\n${archive}`
                : '',
              plot?.title ? `История, из которой это пришло: «${plot.title}».` : '',
              'Вызови submit_chronicle.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });
    } catch (err) {
      (log || getLogger()).warn('conflux.subjectify_failed', { error: err.message, domainId: domain.id });
    }
    if (draft.text) text = draft.text;
  }
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'conflux', conflux?.id ? `conflux:${conflux.id}` : null, 'subjective'].filter(Boolean),
    gameDateLabel: dateLabel(world, day),
    tick: world?.tickIndex ?? null,
    day,
    author: 'subjectificator',
    importance: 'major',
    relatedPlotlineIds: plot?.id ? [plot.id] : null,
    sourcePlotId: plot?.id || null,
  });
  domain.lore = domain.lore || [];
  domain.lore.push(fact);
  return fact;
}

/**
 * После того как хозяин уже записал свою хронику: если она касается обоих,
 * нейтральный слепок идёт в архив пары, сосед получает свой взгляд.
 */
export async function spreadChronicleToPair({
  runtime,
  world,
  conflux,
  domain,
  partner,
  plot = null,
  process = null,
  fact = null,
  day = null,
  log = null,
  storage = null,
} = {}) {
  if (!fact?.text || fact.secret) return null;
  if (!conflux || conflux.status !== 'docked' || !partner || !domain) return null;

  let concern = chronicleConcernFromData({ process, plot, domain, partner, conflux });
  const fromData = concern;
  if (concern === 'judge') {
    concern = await judgeChronicleLeak({
      runtime,
      text: fact.text,
      plot,
      domain,
      partner,
      log,
    });
  }
  if (concern !== 'both') return { concern, fromData };

  const first = Boolean(plot) && !hasLeakedToPair(plot);
  let frozen = null;
  if (first && fromData === 'judge') {
    frozen = freezePlotSynopsis(conflux, world, plot, { day, hostId: domain.id });
  }
  if (plot) markLeakedToPair(plot, day);

  const place = placeForBeat({ process, domain, partner });
  const pairFact = appendPairEntry(conflux, world, {
    text: fact.text,
    place,
    plotId: plot?.id || null,
    day,
    author: 'conflux-canon',
  });

  const archive = formatPairArchive(conflux, [domain, partner]);
  const cityFact = await renderCityView({
    runtime,
    world,
    conflux,
    domain: partner,
    partner: domain,
    plot,
    sourceText: fact.text,
    archive,
    day,
    log,
  });

  if (storage) {
    await storage.saveDomain(partner);
    if (storage.saveConflux) await storage.saveConflux(conflux);
  }
  const cityFacts = [];
  if (cityFact) cityFacts.push({ domainId: partner.id, fact: cityFact });
  await afterPairLoreWrite({
    runtime,
    conflux,
    domains: [domain, partner],
    world,
    day,
    cityFacts,
    log,
  });
  return { concern, fromData, first, frozen, pairFact, cityFact, hostile: place === PLACE_PAIR };
}

/**
 * Одна нейтральная запись в архив пары и взгляды задетых городов.
 * Для стыковки и расставания, у которых нет городской хроники-источника.
 */
export async function publishPairCanon({
  runtime,
  world,
  conflux,
  domains = [],
  text,
  place = PLACE_PAIR,
  plot = null,
  day = null,
  log = null,
} = {}) {
  const body = String(text || '').trim();
  if (!conflux || !body) return { pairFact: null, cityFacts: [] };
  const pairFact = appendPairEntry(conflux, world, {
    text: body,
    place,
    plotId: plot?.id || conflux.container?.id || null,
    day,
    author: 'conflux-canon',
  });
  const archive = formatPairArchive(conflux, domains);
  const cityFacts = [];
  for (const domain of domains || []) {
    const partner = (domains || []).find((d) => d.id !== domain.id) || null;
    const cityFact = await renderCityView({
      runtime,
      world,
      conflux,
      domain,
      partner,
      plot,
      sourceText: body,
      archive,
      day,
      log,
    });
    if (cityFact) cityFacts.push({ domainId: domain.id, fact: cityFact });
  }
  await afterPairLoreWrite({
    runtime,
    conflux,
    domains,
    world,
    day,
    cityFacts,
    log,
  });
  return { pairFact, cityFacts };
}
