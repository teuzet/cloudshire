/**
 * Оценщик дела: срок и сложность — две независимые оси.
 *
 * Раньше была одна ось в месяцах, и поэтому «изобрести интернет» получало
 * двенадцать месяцев и честный шанс на успех. Сложность отвечает на другой
 * вопрос: а вообще ли это по силам, сколько бы времени ни дали.
 */

import { getLogger } from '../log.js';
import { captureAgentPrompt } from './agentPrompt.js';
import {
  DURATION_BANDS,
  DIFFICULTY_BANDS,
  normalizeDurationBand,
  normalizeDifficultyBand,
  rollDurationDays,
  isImpossible,
  MIN_OFFICER_DAYS,
} from './bands.js';

const OPPOSED_STATS = ['prosperity', 'security', 'knowledge', 'influence'];

function normalizeOpposedStat(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key || key === 'null' || key === 'none') return null;
  return OPPOSED_STATS.includes(key) ? key : null;
}

export async function judgeDeed({
  runtime,
  domain,
  summary,
  detail = '',
  goal = '',
  remainingWindowBand = '',
  crossIsland = false,
  log: parentLog,
  rng = Math.random,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'deed.judge' });
  const draft = { duration: null, difficulty: null, note: '', opposedStat: null };
  const runOpts = {
    agentId: 'deedJudge',
    tools: [
      {
        name: 'submit_deed',
        description: 'Полоса срока, полоса сложности и одна бытовая причина.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['duration', 'difficulty', 'note'],
          properties: {
            duration: { type: 'string', enum: [...DURATION_BANDS] },
            difficulty: { type: 'string', enum: [...DIFFICULTY_BANDS] },
            note: { type: 'string', description: 'Одна бытовая фраза без механики.' },
            opposedStat: {
              type: 'string',
              enum: [...OPPOSED_STATS, 'none'],
              description:
                'Какой стат соседа противостоит делу (security/prosperity/knowledge/influence). Нет противодействия — none. Чисел статов не знаешь и не проси.',
            },
          },
        },
        handler: async (args) => {
          draft.duration = normalizeDurationBand(args?.duration, null);
          draft.difficulty = normalizeDifficultyBand(args?.difficulty, null);
          draft.note = String(args?.note || '').trim().slice(0, 300);
          draft.opposedStat = normalizeOpposedStat(args?.opposedStat);
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_deed' } },
    log,
    scene: 'deed_judge',
    domainId: domain?.id,
    userMessages: [
      {
        role: 'user',
        content: [
          `Поручение: ${summary}`,
          goal ? `Цель: ${goal}` : '',
          detail ? `Подробности: ${detail}` : '',
          remainingWindowBand
            ? `До расхождения островов осталось примерно: ${remainingWindowBand}. Если работа длиннее окна — бери более короткую полосу или это не успеть.`
            : '',
          crossIsland
            ? 'Дело через проход: назови opposedStat — какой стат соседа ему противостоит. Чисел не знаешь.'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('deed.judge_failed', { error: err.message });
  }

  const duration = draft.duration || 'WEEKS';
  const difficulty = draft.difficulty || 'PLAIN';
  const objectiveDays = Math.max(1, rollDurationDays(duration, rng));
  log.info('deed.judge', { summary, duration, difficulty });
  return {
    durationBand: duration,
    difficulty,
    objectiveDays,
    // Мгновенное дело всё равно занимает столп: иначе экономия сановников рушится.
    officerDays: Math.max(MIN_OFFICER_DAYS, objectiveDays),
    impossible: isImpossible(difficulty),
    note: draft.note,
    opposedStat: draft.opposedStat,
    prompt,
    fallback: !draft.duration || !draft.difficulty,
  };
}
