import { newId } from './ids.js';
import { createLoreFact, loreToPromptText, recentChronicleText } from './models.js';
import { getLogger, truncate } from '../log.js';

/**
 * Лормастер: отвечает на вопросы, при необходимости дописывает факты (тег fact).
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

  const description =
    String(working.description || '').slice(0, 3000) ||
    Object.entries(working.aspects || {})
      .map(([k, v]) => `${k}: ${String(v).slice(0, 180)}`)
      .join('\n')
      .slice(0, 3000);

  const tools = [
    {
      name: 'read_lore',
      description: 'Прочитать описание города, факты и хронику',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        cosmology: config.world.cosmology,
        domainName: working.name,
        ruler: working.characters?.[0]?.name,
        description,
        recentChronicle: recentChronicleText(working.lore, 16),
        loreText: loreToPromptText(working.lore),
        reminder:
          'Если хроника упоминает явление без деталей — add_fact с конкретными именами/деталями. «Неизвестно» при уже упомянутом явлении запрещено.',
      }),
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
  log.info('loremaster.ask', { questions: questions || [] });

  await runtime.run({
    agentId: 'loremaster',
    userMessages: [
      {
        role: 'user',
        content: [
          `Спрашивает: ${asker}`,
          `Город: ${working.name}`,
          config.world.cosmology || '',
          '',
          'Вопросы:',
          qText || '(нет вопросов)',
          '',
          'Порядок: read_lore → при пробелах add_fact (СУХО, без пафоса) → submit_answers.',
          'Факты как справочник, не проза. Пример: «Облачные ягоды — виноград; сладкий, тонкая кожица.»',
        ].join('\n'),
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
