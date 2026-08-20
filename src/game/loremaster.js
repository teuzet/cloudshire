import { newId } from './ids.js';
import { createLoreFact, loreToPromptText } from './models.js';

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
  const world = await storage.getWorld();
  const working = domain;
  const addedFacts = [];
  let answers = null;

  const tools = [
    {
      name: 'read_lore',
      description: 'Прочитать все факты и хронику домена',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        cosmology: config.world.cosmology,
        domainName: working.name,
        ruler: working.characters?.[0]?.name,
        loreText: loreToPromptText(working.lore),
      }),
    },
    {
      name: 'add_fact',
      description: 'Зафиксировать новый выведенный факт (не хроника событий месяца)',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Сухой факт' },
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
        return { ok: true, factId: fact.id };
      },
    },
    {
      name: 'submit_answers',
      description: 'Итоговые ответы на вопросы',
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
                invented: { type: 'boolean' },
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
          'Прочитай лор, при необходимости add_fact, затем submit_answers.',
        ].join('\n'),
      },
    ],
    tools,
    maxTurns: 8,
    toolChoice: { type: 'function', function: { name: 'read_lore' } },
  });

  await storage.saveDomain(working);

  return {
    answers: answers || [],
    addedFacts,
    loreTextForAsker: (answers || []).map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n'),
  };
}
