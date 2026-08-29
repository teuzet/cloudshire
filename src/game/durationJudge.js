/**
 * Оценщик срока дела. Правитель не ставит длительность:
 * этот агент называет, сколько месяцев работа честно занимает в этом городе.
 */

import { qualitativeStatsBrief, qualitativePopulation } from './stats.js';
import { guessProcessDuration } from './processes.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { deadlineRemainingMs } from '../agents/runtime.js';
import { formatCityForAgents } from './cityContext.js';

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
            description:
              '1–12. Сколько месяцев работа реально занимает при нормальном исполнении. ' +
              'Не драматичность, не желание игрока, не запас. Игровой потолок одного поручения — 12.',
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
    const left = deadlineRemainingMs();
    if (left != null && left < 8000) {
      log.warn('durationJudge.skipped_deadline', { remainingMs: left, summary });
      const fallback = guessProcessDuration(summary, detail, 2);
      return { months: fallback, note: null, source: 'fallback' };
    }
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
            'Оцени, сколько месяцев займёт это дело при нормальном исполнении в текущем состоянии города.',
            'Срок, который хочет бог или правитель, тебя не касается — его сюда не закладывай.',
            'Не путай длительность с драматичностью, важностью или urgency истории.',
            'Выбирай минимальный реалистичный срок, не срок с запасом и не удобный игроку.',
            '1 — ограниченная работа на один цикл; 2–3 — обычная городская работа; 4–6 — крупная; 7–12 — очень крупное предприятие.',
            'Если части можно делать параллельно — не складывай сроки. Низкий стат увеличивает срок, только если реально мешает этой работе.',
            '',
            `Дело: ${summary}`,
            detail ? `Поручение: ${detail}` : null,
            '',
            `Город: ${formatCityForAgents(domain)}`,
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
