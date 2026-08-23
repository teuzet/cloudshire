/**
 * Оценщик срока дела. Правитель не ставит длительность:
 * этот агент называет, сколько месяцев работа честно занимает в этом городе.
 */

import { qualitativeStatsBrief, qualitativePopulation } from './stats.js';
import { guessProcessDuration } from './processes.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function cityBrief(domain, max = 500) {
  const text = String(domain.description || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || '(описание пусто)';
}

/**
 * @returns {Promise<{ months: number, note: string|null, source: 'agent'|'fallback' }>}
 */
export async function estimateProcessDuration({
  config,
  runtime,
  domain,
  summary,
  detail,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'durationJudge', domainId: domain?.id });
  const draft = { months: null, note: null };

  const tools = [
    {
      name: 'submit_duration',
      description: 'Честная оценка, сколько месяцев займёт это дело в этом городе.',
      parameters: {
        type: 'object',
        required: ['months'],
        properties: {
          months: {
            type: 'number',
            description: '1–12. Сколько месяцев работа реально занимает, не сколько хотят подождать.',
          },
          note: {
            type: 'string',
            description: 'Почему столько, одна короткая фраза. Без морали.',
          },
        },
      },
      handler: async (args) => {
        const n = Math.round(Number(args.months));
        if (!Number.isFinite(n) || n < 1 || n > 12) {
          return toolFail('range', 'months — целое от 1 до 12.');
        }
        draft.months = n;
        draft.note = String(args.note || '').trim() || null;
        return { ok: true };
      },
    },
  ];

  try {
    await runtime.run({
      agentId: 'durationJudge',
      tools,
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_duration' } },
      log,
      scene: 'duration_judge',
      domainId: domain?.id,
      extraSystem: `Город «${domain?.name || ''}».`,
      userMessages: [
        {
          role: 'user',
          content: [
            'Оцени, сколько месяцев города займёт это дело. Справедливо и точно.',
            'Срок, который хочет бог или правитель, тебя не касается — его сюда не закладывай.',
            'Не завышай «на всякий случай» и не занижай в угоду спешке.',
            'Смотри на объём работы и на то, каков город сейчас.',
            '',
            `Дело: ${summary}`,
            detail ? `Поручение: ${detail}` : null,
            '',
            `Город: ${cityBrief(domain)}`,
            `Людей: ${qualitativePopulation(domain?.population || 0)}`,
            'Стороны жизни:',
            qualitativeStatsBrief(domain?.stats || {}, config),
            '',
            'Вызови submit_duration.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('durationJudge.failed', { error: err.message, summary });
  }

  if (draft.months) {
    log.info('durationJudge.ok', { months: draft.months, note: draft.note, summary });
    return { months: draft.months, note: draft.note, source: 'agent' };
  }

  const fallback = guessProcessDuration(summary, detail, 2);
  log.warn('durationJudge.fallback', { months: fallback, summary });
  return { months: fallback, note: null, source: 'fallback' };
}
