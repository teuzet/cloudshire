import { getLogger, truncate } from '../log.js';
import { formatFactsForPrompt } from './memory.js';
import { formatCastForPrompt } from './models.js';
import { knownPartnerLore } from './confluxBoard.js';

/**
 * Отвечает только из уже известных зрителю записей соседа. Не выдумывает.
 */
export async function askInformant({
  config,
  runtime,
  conflux,
  viewer,
  partner,
  questions,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({
    scope: 'informant',
    domainId: viewer.id,
    partnerId: partner?.id,
  });
  const known = knownPartnerLore(partner, conflux, viewer.id);
  const draft = { answers: null };

  const tools = [
    {
      name: 'submit_informant',
      description: 'Ответы на вопросы о соседнем городе. Неизвестно — так и скажи.',
      parameters: {
        type: 'object',
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['question', 'answer', 'known'],
              properties: {
                question: { type: 'string' },
                answer: { type: 'string' },
                known: {
                  type: 'boolean',
                  description: 'true если ответ опирается на известные записи, false если неизвестно',
                },
                speculation: {
                  type: 'boolean',
                  description: 'true если это осторожное предположение из известных данных',
                },
              },
            },
          },
        },
      },
      handler: async ({ answers }) => {
        draft.answers = Array.isArray(answers) ? answers : [];
        return { ok: true };
      },
    },
  ];

  const qlist = (questions || []).map(String).filter(Boolean).slice(0, 5);
  if (!qlist.length) {
    return { answers: [], summary: 'Вопросов не было.' };
  }

  const knownBlock = known.length
    ? known
        .slice(-40)
        .map((f) => `- (${f.gameDateLabel || '?'}) ${f.text}`)
        .join('\n')
    : '(ничего не известно)';

  try {
    await runtime.run({
      agentId: 'informant',
      tools,
      maxTurns: 4,
      toolChoice: { type: 'function', function: { name: 'submit_informant' } },
      log,
      scene: 'informant',
      domainId: viewer.id,
      userMessages: [
        {
          role: 'user',
          content: [
            `Город-зритель: «${viewer.name}». Сосед: «${partner?.name || '?'}».`,
            `Информированность зрителя: ${conflux.awareness?.[viewer.id] ?? 0} из 100.`,
            `Стык: ${conflux.status}${conflux.contact?.kind ? `, контакт ${conflux.contact.kind}` : ''}.`,
            '',
            'ИЗВЕСТНЫЕ записи о соседе (это ВСЁ, что можно считать известным):',
            knownBlock,
            '',
            'Факты:',
            formatFactsForPrompt(known, { limit: 30 }) || '(нет)',
            '',
            'Люди из известных записей:',
            formatCastForPrompt(known, { limit: 20 }),
            '',
            'Вопросы:',
            ...qlist.map((q, i) => `${i + 1}. ${q}`),
            '',
            'Отвечай только из этого корпуса. Если данных нет — known=false, answer «неизвестно».',
            'Предположение допустимо только из известных записей и только с speculation=true и явной пометкой в тексте.',
            'Вызови submit_informant.',
          ].join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('informant.failed', { error: err.message });
  }

  const answers = draft.answers || qlist.map((question) => ({
    question,
    answer: 'неизвестно',
    known: false,
    speculation: false,
  }));

  const summary = answers
    .map((a) => {
      const tag = a.speculation ? 'предположение' : a.known ? 'известно' : 'неизвестно';
      return `— ${a.question}: [${tag}] ${a.answer}`;
    })
    .join('\n');

  log.info('informant.done', { questions: qlist.length, preview: truncate(summary, 240) });
  return { answers, summary };
}
