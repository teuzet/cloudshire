/**
 * Генератор трёх следующих хроник: код бросает оси, модель пишет один текст на набор.
 * Лаборатория: пачка → один судья по всем трём → одна правка архитектора.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX } from './plotlines.js';
import {
  parseFreeformGravity,
  formatFreeformGravityForPrompt,
  formatBrainstormCandidateForPrompt,
  freeformConfig,
} from './freeform.js';
import {
  pickFreeformSeedAxisPairs,
  captureAgentPrompt,
} from './freeformArchitect.js';
import {
  parseFreeformPackReview,
  reviewNeedsRepair,
  FREEFORM_PACK_JUDGE_CODES,
} from './freeformJudge.js';

export const CONFLICT_SOURCES = [
  {
    id: 'EXTERNAL_THREAT',
    hint: 'угроза снаружи привычного круга: стихия, зверь, чужой интерес, давление с моря или материка. Не чужой остров и не «прибывшие с соседнего острова», если канон не даёт текущего сопряжения',
  },
  {
    id: 'INTERNAL_BETRAYAL',
    hint: 'кто-то внутри круга доверия ломает договор, молчание или долг',
  },
  {
    id: 'SYSTEMIC_CRISIS',
    hint: 'ломается устройство, на котором держится жизнь. Структура, которую чинят делом, не канцелярия и не потерянная бумага',
  },
  {
    id: 'SUPERNATURAL_ANOMALY',
    hint: 'редкий сбой порядка мира. Не уличная магия и не «просто странно»',
  },
  {
    id: 'MORAL_DILEMMA',
    hint: 'два законных требования, нельзя удовлетворить оба. Нет злодея',
  },
  {
    id: 'DELAYED_CONSEQUENCE',
    hint: 'нынешнее — дозревший плод старого решения, уговора или отказа. Ищи причину назад по хронике, не изобретай новую угрозу с нуля',
  },
  {
    id: 'RIVAL_IDEOLOGY',
    hint: 'столкновение двух правд о том, как жить вместе. Не ссора характеров',
  },
];

export const TEMPORAL_SHAPES = [
  {
    id: 'FRESH_INCIDENT',
    hint: 'только что случилось; ещё нет привычки',
  },
  {
    id: 'LONG_SIMMERING',
    hint: 'тлело давно; сейчас нельзя больше делать вид, что этого нет',
  },
  {
    id: 'CYCLICAL_PATTERN',
    hint: 'это уже повторялось, и каждый круг хуже или дороже',
  },
  {
    id: 'DELAYED_BOMB',
    hint: 'решение или повреждение уже есть; разрыв ещё впереди',
  },
  {
    id: 'ALREADY_CLIMAX',
    hint: 'кульминация уже идёт; входишь в неё, а не начинаешь расследование с нуля',
  },
];

function pickWithoutReplacement(items, n, rng) {
  const pool = [...items];
  const out = [];
  for (let i = 0; i < n && pool.length; i += 1) {
    const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function pairTagName(pair, groupId) {
  const aliases = groupId === 'threatArena' ? ['threatArena', 'truthArena'] : [groupId];
  return (pair || []).find((t) => aliases.includes(t.groupId))?.tagName || '';
}

function axisEcho(raw, key) {
  return String(raw?.[key] || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

export function pickFreeformBrainstormRolls(config, count, rng = Math.random) {
  const n = Math.max(1, Math.round(Number(count) || 1));
  const pairs = pickFreeformSeedAxisPairs(config, n, rng);
  const sources = pickWithoutReplacement(CONFLICT_SOURCES, n, rng);
  const shapes = pickWithoutReplacement(TEMPORAL_SHAPES, n, rng);
  const authors = pickWithoutReplacement(freeformConfig(config).continuationAuthors, n, rng);
  return pairs.map((pair, i) => ({
    pair,
    conflictSource: sources[i] || sources[0],
    temporalShape: shapes[i] || shapes[0],
    author: authors[i] || authors[0],
  }));
}

export function formatFreeformBrainstormRollsForPrompt(rolls) {
  if (!rolls?.length) return '';
  return rolls
    .map((roll, i) => {
      const arena = pairTagName(roll.pair, 'threatArena') || '?';
      const rel = pairTagName(roll.pair, 'worldRelation') || '?';
      const author = roll.author?.name || roll.authorName || '?';
      return `${i + 1}. threatArena ${arena} · worldRelation ${rel} · conflictSource ${roll.conflictSource.id} · temporalShape ${roll.temporalShape.id} · автор ${author}`;
    })
    .join('\n');
}

export function normalizeBrainstormCandidate(raw, roll, index = 1) {
  const chronicle = clipPlotText(raw?.chronicle || raw?.text || raw?.hook, PLOT_SUMMARY_MAX);
  if (!chronicle) return null;
  return {
    title: clipPlotText(raw?.title, PLOT_TITLE_MAX) || '',
    chronicle,
    text: chronicle,
    hook: chronicle,
    index,
    arena: pairTagName(roll?.pair, 'threatArena'),
    worldRelation: pairTagName(roll?.pair, 'worldRelation'),
    conflictSource: roll.conflictSource.id,
    temporalShape: roll.temporalShape.id,
    authorId: roll.author?.id || '',
    authorName: roll.author?.name || '',
  };
}

function logAxisEchoMismatch(log, index, raw, roll) {
  const expected = {
    threatArena: pairTagName(roll.pair, 'threatArena'),
    worldRelation: pairTagName(roll.pair, 'worldRelation'),
    conflictSource: roll.conflictSource.id,
    temporalShape: roll.temporalShape.id,
  };
  const got = {
    threatArena: axisEcho(raw, 'threatArena') || axisEcho(raw, 'arena'),
    worldRelation: axisEcho(raw, 'worldRelation'),
    conflictSource: axisEcho(raw, 'conflictSource'),
    temporalShape: axisEcho(raw, 'temporalShape'),
  };
  const mismatched = Object.keys(expected).filter((key) => got[key] && got[key] !== expected[key]);
  if (!mismatched.length) return;
  log.warn('freeform.brainstorm.axis_echo_mismatch', { index, expected, got, mismatched });
}

export function rollFromBrainstormCandidate(candidate) {
  return {
    pair: [
      {
        groupId: 'truthArena',
        tagId: String(candidate?.arena || '')
          .trim()
          .toLowerCase(),
        tagName: candidate?.arena || '',
      },
      {
        groupId: 'worldRelation',
        tagId: String(candidate?.worldRelation || '')
          .trim()
          .toLowerCase(),
        tagName: candidate?.worldRelation || '',
      },
    ],
    conflictSource: { id: candidate?.conflictSource || '' },
    temporalShape: { id: candidate?.temporalShape || '' },
    author: {
      id: candidate?.authorId || '',
      name: candidate?.authorName || '',
    },
  };
}

function emitCandidatesTool({ n, rolls, draft, log }) {
  return {
    name: 'emit_freeform_candidates',
    description: `Ровно ${n} кандидатов: одна следующая хроника на каждый набор осей, в том же порядке. Оси в ответе — эхо входа, не новый выбор.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          minItems: n,
          maxItems: n,
          items: {
            type: 'object',
            required: ['chronicle'],
            properties: {
              chronicle: {
                type: 'string',
                description:
                  'Краткое описание сюжета: строго 4–5 предложений, не больше',
              },
              threatArena: { type: 'string', description: 'Эхо оси threatArena этого набора.' },
              worldRelation: { type: 'string', description: 'Эхо оси worldRelation этого набора.' },
              conflictSource: { type: 'string', description: 'Эхо оси conflictSource этого набора.' },
              temporalShape: { type: 'string', description: 'Эхо оси temporalShape этого набора.' },
            },
          },
        },
      },
    },
    handler: async (args) => {
      const list = Array.isArray(args?.candidates) ? args.candidates : [];
      const variants = rolls
        .map((roll, i) => {
          logAxisEchoMismatch(log, i + 1, list[i], roll);
          return normalizeBrainstormCandidate(list[i], roll, i + 1);
        })
        .filter(Boolean);
      if (variants.length < n) {
        return toolFail('thin', `Нужно ровно ${n} кандидатов: у каждого одна следующая хроника.`);
      }
      draft.variants = variants;
      return { ok: true, count: n };
    },
  };
}

export async function brainstormFreeformSeeds({ runtime, seedText, gravity, config, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm' });
  const cfg = freeformConfig(config);
  const n = cfg.variantsMax;
  const g = parseFreeformGravity(gravity);
  const rolls = pickFreeformBrainstormRolls(config, n);
  log.info('freeform.brainstorm.rolls', {
    count: rolls.length,
    gravity: g,
    tags: rolls.map((roll) =>
      [
        ...(roll.pair || []).map((t) => `${t.groupId}:${t.tagId}`),
        roll.conflictSource.id,
        roll.temporalShape.id,
        roll.author?.id,
      ].join('+'),
    ),
  });

  const draft = { variants: null };
  const runOpts = {
    agentId: 'freeformBrainstorm',
    tools: [emitCandidatesTool({ n, rolls, draft, log })],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'emit_freeform_candidates' } },
    log,
    scene: 'freeform_brainstorm_seed',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          'GRAVITY',
          formatFreeformGravityForPrompt(g, config),
          '',
          'ЗАТРАВКА',
          seedText,
          '',
          'ОСИ',
          formatFreeformBrainstormRollsForPrompt(rolls),
        ].join('\n'),
      },
    ],
  };

  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.brainstorm_failed', { error: err.message });
  }

  const candidates = draft.variants || [];
  return {
    ok: candidates.length >= n,
    gravity: g,
    rolls,
    candidates,
    prompt,
  };
}

function formatPackForJudge(candidates) {
  return candidates
    .map((c, i) => formatBrainstormCandidateForPrompt(c, c.index || i + 1))
    .filter(Boolean)
    .join('\n\n');
}

export async function reviewBrainstormPack({ runtime, seedText, gravity, candidates, config, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.judge' });
  const n = candidates.length;
  const g = parseFreeformGravity(gravity);
  if (!n) return { reviews: [], prompt: '' };
  const draft = { reviews: null };
  const runOpts = {
    agentId: 'freeformBrainstormJudge',
    tools: [
      {
        name: 'submit_freeform_pack_review',
        description: `Вердикт и правка по каждому из ${n} кандидатов. Победителя не выбирай.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['reviews'],
          properties: {
            reviews: {
              type: 'array',
              minItems: n,
              maxItems: n,
              items: {
                type: 'object',
                required: ['index', 'verdict'],
                properties: {
                  index: { type: 'integer', description: `Номер кандидата от 1 до ${n}.` },
                  verdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNCERTAIN'] },
                  summary: { type: 'string', description: 'Одно предложение: что с этим кандидатом.' },
                  repair: {
                    type: 'string',
                    description: 'Минимальная инструкция автору. Пусто, если чинить нечего.',
                  },
                  issues: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['code', 'reason'],
                      properties: {
                        code: { type: 'string', enum: FREEFORM_PACK_JUDGE_CODES },
                        reason: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const reviews = parseFreeformPackReview(args, n);
          if (reviews.length !== n) {
            return toolFail('thin', `Нужен отзыв ровно по ${n} кандидатам.`);
          }
          draft.reviews = reviews;
          return { ok: true, count: n };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_pack_review' } },
    log,
    scene: 'freeform_brainstorm_judge',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          'GRAVITY',
          formatFreeformGravityForPrompt(g, config),
          '',
          'ЗАТРАВКА',
          seedText,
          '',
          formatPackForJudge(candidates),
        ].join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.brainstorm.judge_failed', { error: err.message });
  }
  const reviews = draft.reviews || parseFreeformPackReview({}, n);
  log.info('freeform.brainstorm.judge', {
    gravity: g,
    verdicts: reviews.map((r) => r.verdict),
    repairs: reviews.filter(reviewNeedsRepair).length,
  });
  return { reviews, prompt };
}

export async function repairBrainstormPack({
  runtime,
  seedText,
  gravity,
  drafts,
  reviews,
  config,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.repair' });
  const n = drafts.length;
  const g = parseFreeformGravity(gravity);
  if (!n) return { candidates: [], prompt: '' };
  const notes = (reviews || []).slice(0, n);
  if (!notes.some(reviewNeedsRepair)) {
    return { candidates: drafts, prompt: '' };
  }

  const rolls = drafts.map((c) => rollFromBrainstormCandidate(c));
  const draft = { variants: null };
  const pack = drafts
    .map((c, i) => {
      const review = notes[i] || { index: i + 1, verdict: 'PASS', repair: '', summary: '', issues: [] };
      const issues = (review.issues || []).map((x) => `[${x.code}] ${x.reason}`).join('\n');
      return [
        formatBrainstormCandidateForPrompt(c, c.index || i + 1, { includeAuthor: true }),
        `вердикт: ${review.verdict}`,
        review.summary ? `кратко: ${review.summary}` : null,
        issues ? `замечания:\n${issues}` : null,
        reviewNeedsRepair(review) ? `правка:\n${review.repair}` : 'правка: без изменений',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const runOpts = {
    agentId: 'freeformBrainstorm',
    tools: [emitCandidatesTool({ n, rolls, draft, log })],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'emit_freeform_candidates' } },
    log,
    scene: 'freeform_brainstorm_repair',
    extraSystem: [
      'Сейчас ты не придумываешь новую пачку. Ты правишь уже написанные три хроники по замечаниям судьи.',
      'Оси и автора не меняй. Центральный механизм не подменяй, кроме случая, когда судья требует убрать новый закон мира — тогда тот же двигатель внутри уже данного порядка.',
      'Не поднимай и не опускай Gravity риторикой. Правь угрозу или возможность в хронике и динамику, которая её зарабатывает.',
      'Если просят обострить — конкретный конфликт и явную динамику в том же тексте, не новая посадка. Если просят ужать — вырежи орнамент, механизм оставь.',
      'Кандидат без замечания верни без изменений. Не делай кандидатов близнецами.',
    ].join('\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          'GRAVITY',
          formatFreeformGravityForPrompt(g, config),
          '',
          'ЗАТРАВКА',
          seedText,
          '',
          'ДОРАБОТКА',
          pack,
        ].join('\n'),
      },
    ],
  };

  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.brainstorm.repair_failed', { error: err.message });
  }
  const candidates = draft.variants?.length >= n ? draft.variants : drafts;
  return { candidates, prompt };
}

export async function brainstormFreeformPack({ runtime, seedText, gravity, config, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.pack' });
  const drafted = await brainstormFreeformSeeds({ runtime, seedText, gravity, config, log });
  if (!drafted.ok) {
    return {
      ok: false,
      gravity: drafted.gravity,
      drafts: drafted.candidates || [],
      reviews: [],
      candidates: drafted.candidates || [],
      prompt: drafted.prompt || '',
      judgePrompt: '',
      repairPrompt: '',
    };
  }
  const judged = await reviewBrainstormPack({
    runtime,
    seedText,
    gravity: drafted.gravity,
    candidates: drafted.candidates,
    config,
    log,
  });
  const repaired = await repairBrainstormPack({
    runtime,
    seedText,
    gravity: drafted.gravity,
    drafts: drafted.candidates,
    reviews: judged.reviews,
    config,
    log,
  });
  return {
    ok: true,
    gravity: drafted.gravity,
    drafts: drafted.candidates,
    reviews: judged.reviews,
    candidates: repaired.candidates,
    prompt: drafted.prompt,
    judgePrompt: judged.prompt,
    repairPrompt: repaired.prompt,
  };
}
