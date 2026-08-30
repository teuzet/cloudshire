import { newId } from './ids.js';
import { createLoreFact, formatCastForPrompt, chronicleEntries, formatChroniclePriestMark } from './models.js';
import { formatFullChronicleForPrompt, formatFactsForPrompt } from './memory.js';
import { findActiveConfluxForDomain, monthsUntilDock } from './conflux.js';
import { attachFactToPlotlines, isOrderPlot } from './plotlines.js';
import { dehydrateDomainToConflux, hydrateDomainFromConflux, plotVisibleToRuler } from './confluxBoard.js';
import { formatTruthGraphForPrompt } from './mysteryGraph.js';
import { formatLadderForPrompt } from './suspenseGraph.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function visibleLoreForDomain(lore, domainId) {
  return (lore || []).filter((f) => {
    if (!f?.secret) return true;
    return String(f.secretForDomainId || '') === String(domainId);
  });
}

export function storiesForLoremaster(domain, conflux = null) {
  const byId = new Map();
  for (const p of domain?.plotlines || []) {
    if (p && !isOrderPlot(p)) byId.set(p.id, p);
  }
  if (conflux) {
    for (const p of conflux.plotlines || []) {
      if (!p || isOrderPlot(p)) continue;
      if (plotVisibleToRuler(p, domain.id, conflux)) {
        if (!byId.has(p.id)) byId.set(p.id, p);
      }
    }
  }
  return [...byId.values()];
}

/** Идущая история с доски или конфлюкса; закрытая и указ — null. */
export function resolveLoremasterStory(domain, plotId, conflux = null) {
  const id = String(plotId || '').trim();
  if (!id) return null;
  return storiesForLoremaster(domain, conflux).find((p) => String(p.id) === id) || null;
}

export function formatOpenStoriesBrief(plots = []) {
  if (!plots.length) return 'Открытых историй нет.';
  const lines = plots.map((p) => {
    const kind =
      p.storyType === 'mystery'
        ? 'тайна'
        : p.kind === 'errand'
          ? 'поручение'
          : p.isMainConflux || p.shared
            ? 'общая история сопряжения'
            : 'история';
    const syn = p.synopsis ? ` — ${p.synopsis}` : '';
    return `- ${p.id} (${kind})${syn}`;
  });
  return [
    'Открытые истории (не решай их и не выдумывай развязку, виновника, скрытую причину):',
    ...lines,
    'Канон истины и скрытые посылки здесь не приведены. Если вопрос про конкретную идущую нить — её должен передать спрашивающий как plotId.',
  ].join('\n');
}

/** @deprecated краткие карточки без канона; полный канон — formatFocusedStoryForLoremaster */
export function formatStoriesForLoremaster(plots = [], { viewerId = null, focusId = null } = {}) {
  if (focusId) {
    const focused = plots.find((p) => String(p.id) === String(focusId));
    if (focused) return formatFocusedStoryForLoremaster(focused, { viewerId });
  }
  return formatOpenStoriesBrief(plots);
}

export function formatFocusedStoryForLoremaster(p, { viewerId = null } = {}) {
  if (!p) return '';
  const host = p.hostDomainId || null;
  const own = !viewerId || p.isMainConflux || !host || String(host) === String(viewerId);
  const kind =
    p.storyType === 'mystery'
      ? 'ТАЙНА'
      : p.kind === 'errand'
        ? 'поручение'
        : p.isMainConflux || p.shared
          ? 'общая история сопряжения'
          : 'история';
  const lines = [
    `ФОКУС: нить ${p.id} (${kind}). Это идущая история — не закрытая.`,
    p.synopsis ? `Как сейчас: ${p.synopsis}` : null,
    p.closeWhen ? `Успешный исход: ${p.closeWhen}` : null,
    p.mootWhen ? `Теряет смысл, когда: ${p.mootWhen}` : null,
    'Можно дописать мелкие детали места, обычая, материала, имени фона — если они не заводят новое направление сюжета и не ломают повествование.',
    'Нельзя: раскрывать скрытое, ставить исход, виновника, мотив, причину странности; заводить новую интригу, конфликт или расследование.',
  ];
  if (!own) {
    lines.push(
      'Чужая история: канон истины и скрытые посылки этому городу не открыты. Отвечай по видимой хронике. Не раскрывай, не достраивай скрытое и не записывай его в fact.',
    );
    return lines.filter(Boolean).join('\n');
  }
  if (p.storyType === 'mystery' && (p.truthGraph || p.truth)) {
    lines.push(
      'КАНОН ТАЙНЫ (только чтобы не противоречить). Скрытое нельзя раскрывать, объяснять или писать в fact/ответы.',
    );
    if (p.truthGraph) {
      lines.push(
        formatTruthGraphForPrompt(p.truthGraph).replace(
          'ПРИЧИННЫЙ ГРАФ (канон истины; узлы и рёбра не переписывай, меняй только статусы знания):',
          'ПРИЧИННЫЙ ГРАФ (канон истины; только читать. Скрытое не раскрывай и не достраивай.):',
        ),
      );
    } else if (p.truth) {
      lines.push(`Канон (не раскрывай): ${p.truth}`);
    }
    lines.push(
      'В ответы и add_fact — только уже «замеченное» или «понятое», плюс нейтральные детали фона, которые не намекают на скрытые узлы.',
    );
  } else if (p.storyType === 'suspense' && (p.hiddenPremises?.length || p.discoveryLadder?.length)) {
    lines.push(
      'СКРЫТАЯ ПРИРОДА НАСТОЯЩЕГО (только чтобы не противоречить). Не раскрывай, не пересказывай игроку/правителю и не пиши в fact.',
    );
    if (p.hiddenPremises?.length) {
      lines.push('hiddenPremises:');
      lines.push(formatHiddenPremisesForLoremaster(p.hiddenPremises));
    }
    if (p.discoveryLadder?.length) {
      lines.push('Лестница открытия:');
      lines.push(formatLadderForPrompt(p.discoveryLadder));
    }
  } else {
    lines.push(
      'Не выдумывай исход, виновника, скрытый мотив или причину нерешённого в этой истории.',
    );
  }
  return lines.filter(Boolean).join('\n');
}

function formatHiddenPremisesForLoremaster(premises = []) {
  return premises.map((text, i) => `- [${i}] СКРЫТО (не в ответы, не в fact): ${text}`).join('\n');
}

function loreLinkedToPlot(lore, plot) {
  if (!plot?.id) return [];
  const chron = new Set((plot.chronicleIds || []).map(String));
  const facts = new Set((plot.factIds || []).map(String));
  const pid = String(plot.id);
  return (lore || []).filter((e) => {
    const id = String(e?.id || '');
    if (chron.has(id) || facts.has(id)) return true;
    if (String(e.sourcePlotId || '') === pid) return true;
    return (e.relatedPlotlineIds || []).map(String).includes(pid);
  });
}

function partnerBrief(partner, viewerDomainId) {
  const desc = String(partner.description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  const visible = visibleLoreForDomain(partner.lore, viewerDomainId);
  // Partner's own secrets must never leak — only public entries (no secret flag)
  const publicOnly = (visible || []).filter((f) => !f.secret);
  const chron = chronicleEntries(publicOnly).slice(-6);
  return {
    id: partner.id,
    name: partner.name,
    ruler: partner.characters?.[0]?.name || null,
    population: partner.population,
    descriptionBrief: desc || '(нет)',
    recentPublicChronicle: chron.length
      ? chron.map((f) => `- (${f.gameDateLabel || '?'}) ${f.text}`).join('\n')
      : '(пусто)',
  };
}

/**
 * Лормастер: отвечает на вопросы, при необходимости дописывает факты (тег fact).
 * В фазе docked: shared lore + урезанный partner brief без чужих secret.
 */
export async function askLoremaster({
  config,
  runtime,
  storage,
  domain,
  questions,
  asker = 'agent',
  plotId = null,
  conflux: confluxArg = null,
  maxTurns = 10,
}) {
  const log = getLogger().child({
    scope: 'loremaster',
    domainId: domain.id,
    asker,
  });
  const world = await storage.getWorld();
  const working = domain;
  const addedFacts = [];
  let answers = null;

  // approaching тоже канон: сближение чужого острова — подтверждённый факт мира.
  const conflux = confluxArg || (await findActiveConfluxForDomain(storage, working.id));
  const docked = conflux?.status === 'docked';
  let partner = null;
  if (conflux) {
    const otherId = (conflux.domainIds || []).find((id) => id !== working.id);
    if (otherId) partner = await storage.getDomain(otherId);
  }
  const openStories = storiesForLoremaster(working, conflux);
  const focusPlot = resolveLoremasterStory(working, plotId, conflux);

  const description =
    String(working.description || '').slice(0, 3000) ||
    Object.entries(working.aspects || {})
      .map(([k, v]) => `${k}: ${String(v).slice(0, 180)}`)
      .join('\n')
      .slice(0, 3000);

  const tools = [
    {
      name: 'read_lore',
      description: conflux
        ? 'Прочитать описание города, факты, хронику и (если сопряжение) контакт/соседа'
        : 'Прочитать описание города, факты и хронику',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const visible = visibleLoreForDomain(working.lore, working.id);
        const payload = {
          ok: true,
          cosmology: config.world.cosmology,
          gameDate: world.gameDate,
          domainName: working.name,
          ruler: working.characters?.[0]?.name,
          description,
          // Лормастеру нужна вся история: часть фактов выводится только из неё.
          chronicle: formatFullChronicleForPrompt({ ...working, lore: visible }),
          facts: formatFactsForPrompt(visible, { limit: 60 }),
          // Каст — такой же источник, как хроника: там живут судьбы названных людей.
          knownPeople: formatCastForPrompt(visible, { limit: 30 }),
          // Без состояния лормастер противоречит сам себе («переписи нет», пока процесс идёт).
          standingOrders: (working.state?.modifiers || []).map((m) => m.text),
          currentEvents: (working.state?.events || []).map((e) =>
            typeof e === 'string' ? e : e?.text,
          ),
          activeProcesses: (working.state?.pendingActions || [])
            .filter((a) => a.status === 'active')
            .map((a) => ({
              summary: a.summary,
              monthsLeft: a.monthsLeft,
              expectedMonths: a.expectedMonths,
            })),
          openStories: formatOpenStoriesBrief(openStories),
          reminder: focusPlot
            ? 'Хроника — главный источник произошедшего; ты её только читаешь. Инструмент — факты. ' +
              'focusStory — идущая нить, о которой спросили: канон дан, чтобы не противоречить и не разрушить повествование. ' +
              'Дописывай только мелкие детали фона. Не заводи новое направление сюжета. Скрытое не раскрывай и не пиши в fact. ' +
              'Новый fact по этой нити система сама привяжет к истории.'
            : 'Хроника приложена целиком — это твой главный источник, рядом с ним knownPeople. Ты хронику только читаешь: ' +
              'писать её нельзя, инструмент — факты. ' +
              'openStories — краткие карточки идущих историй без канона истины. Не решай их и не выдумывай скрытое. ' +
              'Сыгранную историю читай только по хронике. ' +
              'Если у записи есть пометка [ЭТА ЗАПИСЬ ЗАКРЫЛА ПРОБЛЕМУ] — история закрыта этой записью; не описывай её как текущую беду. ' +
              'Если хроника упоминает явление без деталей и это не защищённый вопрос — add_fact. ' +
              '«Неизвестно» — редко: только когда ответ защищён или противоречил бы канону. ' +
              'Факт, противоречащий хронике или состоянию, — устарел: update_fact или retire_fact.',
        };
        if (focusPlot) {
          const linked = loreLinkedToPlot(visible, focusPlot);
          payload.focusStory = formatFocusedStoryForLoremaster(focusPlot, {
            viewerId: working.id,
          });
          const chronLines = chronicleEntries(linked).map(
            (f) => `- (${f.gameDateLabel || '?'}) ${f.text}${formatChroniclePriestMark(f)}`,
          );
          payload.storyChronicle = chronLines.length
            ? chronLines.join('\n')
            : '(по этой нити в хронике пока пусто)';
          payload.storyFacts = formatFactsForPrompt(linked, { limit: 40 });
        }

        if (conflux) {
          payload.conflux = {
            id: conflux.id,
            status: conflux.status,
            partnerName: partner?.name || null,
            rematch: Boolean(conflux.rematch),
          };
          if (docked) {
            payload.conflux.contact = conflux.contact;
            payload.conflux.monthsDocked = conflux.monthsDocked || 0;
            payload.conflux.durationMonths = conflux.durationMonths || null;
            payload.conflux.sharedLoreRecent = (conflux.sharedLore || []).slice(-8).map((f) => ({
              date: f.gameDateLabel,
              text: f.text,
            }));
            if (partner) {
              payload.partner = partnerBrief(partner, working.id);
              payload.reminder +=
                ' Соседний остров при сопряжении — реальный; чужие secret тебе не видны. Не выдумывай третий остров.';
            }
          } else {
            payload.conflux.monthsUntilDock = monthsUntilDock(conflux, world);
            payload.reminder +=
              ` СБЛИЖЕНИЕ ПОДТВЕРЖДЕНО: чужой остров${partner?.name ? ` «${partner.name}»` : ''}` +
              ` реально приближается, сопряжение примерно через ${monthsUntilDock(conflux, world)} мес.` +
              ' Это факт мира, а не слух. Отвечать «не подтверждено» ЗАПРЕЩЕНО.' +
              ' Про внутреннюю жизнь соседа сведений пока нет — только сам факт и срок.';
          }
        }

        return payload;
      },
    },
    {
      name: 'add_fact',
      description: 'Зафиксировать новый выведенный факт (не хроника событий месяца)',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description:
              'Сухой факт: 1–2 короткие фразы, без эпитетов и пафоса. Пример: «Местный продукт — виноград; сладкий, тонкая кожица.» ' +
              'Только утверждение о том, ЧТО ЕСТЬ. Незнание — не факт: «не установлено», ' +
              '«сведений нет», «смерть или исчезновение», «возможно» в факт не пишутся. ' +
              'Не переписывай формулировку вопроса: спросили «смерть или исчезновение» — ' +
              'запиши то, что знаешь («Неван мёртв, тело нашли у соляного поля»), или не пиши ничего.',
          },
        },
      },
      handler: async ({ text }) => {
        const body = String(text || '').trim();
        // Факт-незнание — мусор в лоре навсегда: он потом читается как правда о мире.
        if (/не установлен|сведений нет|неизвестн|или исчезновени|возможно,|предположительно/i.test(body)) {
          return toolFail(
            'not_a_fact',
            'Это не факт, а запись незнания. Факт — утверждение о том, что есть. ' +
              'Если знаешь по хронике или knownPeople — сформулируй утвердительно; если не знаешь — ' +
              'просто ответь в submit_answers, без add_fact.',
          );
        }
        const fact = createLoreFact({
          id: newId('lore'),
          text: body,
          tags: ['fact'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: `loremaster:${asker}`,
          relatedPlotlineIds: focusPlot ? [focusPlot.id] : null,
          sourcePlotId: focusPlot ? focusPlot.id : null,
        });
        working.lore.push(fact);
        if (focusPlot) {
          attachFactToPlotlines(working, fact.id, [focusPlot.id]);
          if (conflux) attachFactToPlotlines(conflux, fact.id, [focusPlot.id]);
        }
        addedFacts.push(fact);
        log.info('loremaster.add_fact', {
          factId: fact.id,
          plotId: focusPlot?.id || null,
          text: truncate(body, 300),
        });
        return { ok: true, factId: fact.id, plotId: focusPlot?.id || null };
      },
    },
    {
      name: 'update_fact',
      description:
        'Переписать устаревший факт (например, событие уже произошло или условие изменилось). factId — id из facts.',
      parameters: {
        type: 'object',
        required: ['factId', 'text'],
        properties: {
          factId: { type: 'string', description: 'Id факта (lore_…)' },
          text: { type: 'string', description: 'Новая формулировка: сухо, 1–2 фразы' },
          reason: { type: 'string', description: 'Чем прежний факт противоречит хронике/состоянию' },
        },
      },
      handler: async ({ factId, text, reason }) => {
        const body = String(text || '').trim();
        const fact = (working.lore || []).find((f) => f.id === factId);
        if (!fact) {
          return {
            ok: false,
            error: 'fact_not_found',
            agentMessage:
              'Факт с таким id не найден. Возьми id из facts в read_lore или создай новый через add_fact.',
          };
        }
        if (body.length < 3) {
          return {
            ok: false,
            error: 'too_short',
            agentMessage: 'Новая формулировка слишком короткая. Напиши сухой факт в 1–2 фразы.',
          };
        }
        fact.previousText = fact.text;
        fact.text = body;
        fact.updatedTick = world.tickIndex;
        fact.updatedAt = new Date().toISOString();
        if (reason) fact.updateReason = String(reason).slice(0, 300);
        log.info('loremaster.update_fact', { factId, text: truncate(body, 200) });
        return { ok: true, factId };
      },
    },
    {
      name: 'retire_fact',
      description:
        'Снять факт, который больше не верен (событие отменено, условие исчезло). Факт не удаляется, а помечается устаревшим.',
      parameters: {
        type: 'object',
        required: ['factId'],
        properties: {
          factId: { type: 'string', description: 'Id факта (lore_…)' },
          reason: { type: 'string' },
          supersededByFactId: {
            type: 'string',
            description: 'Id нового факта, если он уже создан через add_fact',
          },
        },
      },
      handler: async ({ factId, reason, supersededByFactId }) => {
        const fact = (working.lore || []).find((f) => f.id === factId);
        if (!fact) {
          return {
            ok: false,
            error: 'fact_not_found',
            agentMessage: 'Факт с таким id не найден. Возьми id из facts в read_lore.',
          };
        }
        fact.retiredAt = new Date().toISOString();
        fact.retiredTick = world.tickIndex;
        if (reason) fact.retireReason = String(reason).slice(0, 300);
        if (supersededByFactId) fact.supersededBy = supersededByFactId;
        if (!Array.isArray(fact.tags)) fact.tags = [];
        if (!fact.tags.includes('retired')) fact.tags.push('retired');
        log.info('loremaster.retire_fact', { factId, reason: truncate(reason, 200) });
        return { ok: true, factId };
      },
    },
    {
      name: 'submit_answers',
      description: 'Итоговые ответы на вопросы (после нужных add_fact)',
      parameters: {
        type: 'object',
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['question', 'answer'],
              properties: {
                question: { type: 'string' },
                answer: { type: 'string' },
                invented: {
                  type: 'boolean',
                  description: 'true, если деталь дописана поверх хроники/пробела',
                },
              },
            },
          },
        },
      },
      handler: async (args) => {
        answers = args.answers;
        return { ok: true };
      },
    },
  ];

  const qText = (questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n');
  log.info('loremaster.ask', {
    questions: questions || [],
    confluxId: conflux?.id || null,
    plotId: plotId || null,
    focusPlotId: focusPlot?.id || null,
  });

  const dockHint = !conflux
    ? ''
    : docked
      ? [
          '',
          `Сейчас сопряжение (conflux ${conflux.id}) с соседом` +
            (partner ? ` «${partner.name}»` : '') +
            '. В read_lore есть contact и краткий partner brief без чужих тайн.',
        ].join('\n')
      : [
          '',
          `К острову ПОДТВЕРЖДЁННО приближается чужой остров${partner ? ` «${partner.name}»` : ''}; ` +
            `сопряжение примерно через ${monthsUntilDock(conflux, world)} мес. Это факт мира.`,
          'Отвечать «сближение не подтверждено» или «таких сведений нет» ЗАПРЕЩЕНО.',
          'О внутренней жизни соседа сведений пока нет — только факт сближения и срок.',
        ].join('\n');

  await runtime.run({
    agentId: 'loremaster',
    userMessages: [
      {
        role: 'user',
        content: [
          `Спрашивает: ${asker}`,
          `Город: ${working.name}`,
          dockHint,
          '',
          'Вопросы:',
          qText || '(нет вопросов)',
          '',
          focusPlot
            ? `Фокус — идущая история ${focusPlot.id}. Канон и инструкция — в read_lore.focusStory. Детали фона можно дописать; новое направление сюжета — нельзя. Скрытое не раскрывай.`
            : 'Фокуса на идущей истории нет: канон тайн не дан. Сыгранное читай только по хронике. Не решай открытые истории.',
          'Порядок: read_lore → при пробелах add_fact (СУХО, без пафоса), при противоречиях update_fact / retire_fact → submit_answers.',
          'Перед ответом сверь факты с хроникой, openStories и состоянием: устаревшие обнови или сними, не пересказывай их как правду.',
          'Факты как справочник, не проза. Пример: «Местный продукт — виноград; сладкий, тонкая кожица.»',
        ]
          .filter((line) => line !== undefined)
          .join('\n'),
      },
    ],
    tools,
    maxTurns,
    toolChoice: { type: 'function', function: { name: 'read_lore' } },
    log,
    scene: 'loremaster',
    domainId: working.id,
  });

  if (conflux) {
    dehydrateDomainToConflux(working, conflux);
    await storage.saveDomain(working);
    await storage.saveConflux(conflux);
    hydrateDomainFromConflux(working, conflux, { mode: 'ruler' });
  } else {
    await storage.saveDomain(working);
  }

  log.info('loremaster.done', {
    answerCount: (answers || []).length,
    newFacts: addedFacts.length,
    focusPlotId: focusPlot?.id || null,
    answers: truncate(answers, 800),
  });

  return {
    answers: answers || [],
    addedFacts,
    focusPlotId: focusPlot?.id || null,
    loreTextForAsker: (answers || [])
      .map((a) => `Q: ${a.question}\nA: ${a.answer}${a.invented ? ' (уточнено)' : ''}`)
      .join('\n\n'),
  };
}
