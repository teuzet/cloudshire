import { newId } from './ids.js';
import {
  createLoreFact,
  loreToPromptText,
  recentChronicleText,
  chronicleEntries,
} from './models.js';
import { findDockedConfluxForDomain } from './conflux.js';
import { getLogger, truncate } from '../log.js';

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

  const conflux = await findDockedConfluxForDomain(storage, working.id);
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
        ? 'Прочитать описание города, факты, хронику и (если стык) контакт/соседа'
        : 'Прочитать описание города, факты и хронику',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const visible = visibleLoreForDomain(working.lore, working.id);
        const payload = {
          ok: true,
          cosmology: config.world.cosmology,
          domainName: working.name,
          ruler: working.characters?.[0]?.name,
          description,
          recentChronicle: recentChronicleText(visible, 16),
          loreText: loreToPromptText(visible),
          reminder:
            'Если хроника упоминает явление без деталей — add_fact с конкретными именами/деталями. «Неизвестно» при уже упомянутом явлении запрещено.',
        };

        if (conflux) {
          payload.conflux = {
            id: conflux.id,
            status: conflux.status,
            contact: conflux.contact,
            sharedLoreRecent: (conflux.sharedLore || []).slice(-8).map((f) => ({
              date: f.gameDateLabel,
              text: f.text,
            })),
          };
          if (partner) {
            payload.partner = partnerBrief(partner, working.id);
            payload.reminder +=
              ' Соседний остров на стыке — реальный; чужие secret тебе не видны. Не выдумывай третий остров.';
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
              'Сухой факт: 1–2 короткие фразы, без эпитетов и пафоса. Пример: «Облачные ягоды — виноград; сладкий, тонкая кожица.»',
          },
        },
      },
      handler: async ({ text }) => {
        const fact = createLoreFact({
          id: newId('lore'),
          text,
          tags: ['fact'],
          gameDateLabel: world.gameDate.label,
          tick: world.tickIndex,
          author: `loremaster:${asker}`,
        });
        working.lore.push(fact);
        addedFacts.push(fact);
        log.info('loremaster.add_fact', { factId: fact.id, text: truncate(text, 300) });
        return { ok: true, factId: fact.id };
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

  const dockHint = conflux
    ? [
        '',
        `Сейчас стык (conflux ${conflux.id}) с соседом` +
          (partner ? ` «${partner.name}»` : '') +
          '. В read_lore есть contact и краткий partner brief без чужих тайн.',
      ].join('\n')
    : '';

  await runtime.run({
    agentId: 'loremaster',
    userMessages: [
      {
        role: 'user',
        content: [
          `Спрашивает: ${asker}`,
          `Город: ${working.name}`,
          config.world.cosmology || '',
          dockHint,
          '',
          'Вопросы:',
          qText || '(нет вопросов)',
          '',
          'Порядок: read_lore → при пробелах add_fact (СУХО, без пафоса) → submit_answers.',
          'Факты как справочник, не проза. Пример: «Облачные ягоды — виноград; сладкий, тонкая кожица.»',
        ]
          .filter((line) => line !== undefined)
          .join('\n'),
      },
    ],
    tools,
    maxTurns: 10,
    toolChoice: { type: 'function', function: { name: 'read_lore' } },
    log,
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
