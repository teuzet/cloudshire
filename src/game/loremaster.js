import { newId } from './ids.js';
import { createLoreFact, formatCastForPrompt } from './models.js';
import { formatFullChronicleForPrompt, formatFactsForPrompt } from './memory.js';
import { findActiveConfluxForDomain, monthsUntilDock } from './conflux.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function visibleLoreForDomain(lore, domainId) {
  return (lore || []).filter((f) => {
    if (!f?.secret) return true;
    return String(f.secretForDomainId || '') === String(domainId);
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
  const conflux = await findActiveConfluxForDomain(storage, working.id);
  const docked = conflux?.status === 'docked';
  let partner = null;
  if (conflux) {
    const otherId = (conflux.domainIds || []).find((id) => id !== working.id);
    if (otherId) partner = await storage.getDomain(otherId);
  }

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
          reminder:
            'Хроника приложена целиком — это твой главный источник, рядом с ним knownPeople: ' +
            'судьбы названных людей записаны там, даже если хроника о них молчит. Ты их только читаешь: ' +
            'писать и менять записи хроники нельзя, твой инструмент — факты. ' +
            'Если хроника упоминает явление без деталей — add_fact с конкретными именами/деталями. ' +
            '«Неизвестно» при уже упомянутом явлении запрещено. ' +
            'Факт, противоречащий хронике или текущему состоянию, — устарел: update_fact или retire_fact.',
        };

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
        });
        working.lore.push(fact);
        addedFacts.push(fact);
        log.info('loremaster.add_fact', { factId: fact.id, text: truncate(body, 300) });
        return { ok: true, factId: fact.id };
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
          'Порядок: read_lore → при пробелах add_fact (СУХО, без пафоса), при противоречиях update_fact / retire_fact → submit_answers.',
          'Перед ответом сверь факты с хроникой и состоянием: устаревшие обнови или сними, не пересказывай их как правду.',
          'Факты как справочник, не проза. Пример: «Местный продукт — виноград; сладкий, тонкая кожица.»',
        ]
          .filter((line) => line !== undefined)
          .join('\n'),
      },
    ],
    tools,
    maxTurns: 10,
    toolChoice: { type: 'function', function: { name: 'read_lore' } },
    log,
    scene: 'loremaster',
    domainId: working.id,
  });

  await storage.saveDomain(working);

  log.info('loremaster.done', {
    answerCount: (answers || []).length,
    newFacts: addedFacts.length,
    answers: truncate(answers, 800),
  });

  return {
    answers: answers || [],
    addedFacts,
    loreTextForAsker: (answers || [])
      .map((a) => `Q: ${a.question}\nA: ${a.answer}${a.invented ? ' (уточнено)' : ''}`)
      .join('\n\n'),
  };
}
