import { getLogger, truncate } from '../log.js';
import { formatCastForPrompt } from './models.js';
import { knownPartnerLore } from './confluxBoard.js';
import { formatContactForPrompt } from './conflux.js';

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
            `Город спрашивающего: «${viewer.name}». Сосед: «${partner?.name || '?'}».`,
            conflux.contact?.kind
              ? formatContactForPrompt(conflux.contact)
              : 'Острова ещё только сближаются.',
            '',
            'Что этому городу уже известно о соседе:',
            knownBlock,
            '',
            'Люди из этих сведений:',
            formatCastForPrompt(known, { limit: 20 }),
            '',
            'Вопросы:',
            ...qlist.map((q, i) => `${i + 1}. ${q}`),
            '',
            'Отвечай только из этих сведений. Вызови submit_informant.',
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
