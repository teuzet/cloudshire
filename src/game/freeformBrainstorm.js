/**
 * Генератор трёх следующих хроник: код бросает оси, модель пишет один текст на набор.
 * Лаборатория: пачка → судья. PASS сразу в пул и не чинится.
 * Если PASS уже ≥2 — правка и второй судья не запускаются.
 * Иначе чинятся только не-PASS; второй судья видит только их.
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
  reviewNeedsRewrite,
  isPackPass,
  freeformPackJudgeCodes,
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

export function parseRequireMystery(raw) {
  if (raw === true || raw === 1) return true;
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export const MYSTERY_ARCHITECT_EXTRA = [
  '==== ОБЯЗАТЕЛЬНАЯ ТАЙНА ====',
  'Этот посев — эксперимент: в каждом кандидате ОБЯЗАТЕЛЬНО есть тайна с разгадкой.',
  'Это переопределяет правило «тайну ради тайны не выдумывай».',
  '',
  '- В наблюдаемом слое игрок видит странность, нестыковку или сокрытие, которую нельзя сразу объяснить. Не обязательно преступление: ложь, пропажа, подмена, необъяснимый поступок, секрет, который кто-то бережёт.',
  '- В конце каждого кандидата блок «На самом деле:» с полной разгадкой: что произошло, кто знает, кто врёт, какая улика это подтвердит. Разгадка конкретна и проверяема в мире — не магия, не сон, не «все сошли с ума».',
  '- Разгадка не разочаровывает: она следует из уже названных фактов и характеров. Читатель, узнав её, говорит «так вот оно что», а не «и это всё?».',
  '- Тайна не декоративна: без неё история теряет смысл. Концы (GOOD/NEUTRAL/BAD) зависят от того, вскроется ли тайна и чем это обернётся.',
  '- Не пропускай «На самом деле:» ни у одного из трёх кандидатов.',
].join('\n');

export const MYSTERY_JUDGE_EXTRA = [
  '==== ДОПОЛНИТЕЛЬНЫЕ КРИТЕРИИ (тайна обязательна) ====',
  '13. BUREAUCRACY — двигатель не канцелярия. FAIL, если сюжет держится на тяжбе, сверке записей, комиссии, отложенном заседании или потерянной бумаге.',
  '14. MYSTERY — в пакете есть настоящая тайна: странность, которую персонажи и игрок не могут сразу объяснить. Если завязка прозрачна и нечего разгадывать — FAIL.',
  '15. MYSTERY_PLAUSIBLE — разгадка в «На самом деле:» логична, конкретна и не разочаровывает. FAIL если разгадки нет, она противоречит фактам, сваливается на чудо/случай/«ну так вышло», или финал обесценивает всю странность.',
  '',
  'CHEKHOV при этом посеве не опционален: блок «На самом деле:» обязателен у каждого кандидата.',
].join('\n');

export const VOID_ARCHITECT_EXTRA = [
  '==== НЕТ ЗАТРАВКИ ====',
  'Затравки нет: ни события игрока, ни хроники конкретного города.',
  'Пиши про абстрактный город-государство на летающем острове — типичный полис этого мира, не продолжение чьей-то уже данной истории.',
  'Это переопределяет правило «данная затравка — причина конфликта»: причину придумай сам. В запросе нет конкретной хроники — не выдумывай, что она была.',
  'Не привязывайся к именам, институтам и прошлому какого-то существующего города. Конфликт должен быть понятен без предыстории.',
  'Три кандидата — три независимых истории с нуля, не три продолжения одной затравки.',
].join('\n');

export const VOID_JUDGE_EXTRA = [
  '==== НЕТ ЗАТРАВКИ ====',
  'Исходной хроники нет. Критерий CHRONICLE не применяй: не требуй вытекания из затравки и не ставь FAIL за отсутствие связи с ней.',
  'Истории должны быть самодостаточны: абстрактный город-государство на летающем острове, без опоры на конкретную хронику.',
].join('\n');

export const GENESIS_ARCHITECT_EXTRA = [
  '==== ЗАТРАВКА — ОПИСАНИЕ ГОРОДА ====',
  'Дан не случай месяца и не хроника, а устойчивое описание города: как он устроен и чем живёт.',
  'Это переопределяет правило «данная затравка — причина конфликта»: конфликт не обязан следовать из одной фразы.',
  'Возьми из описания место, уклад, напряжение или обычай и вырасти из него новую историю, которой ещё нет.',
  'Не пересказывай генезис. Три кандидата — три разных завязки из разных сторон этого города.',
].join('\n');

export const GENESIS_JUDGE_EXTRA = [
  '==== ЗАТРАВКА — ОПИСАНИЕ ГОРОДА ====',
  'Критерий CHRONICLE не требуй как вытекание из одной строки описания.',
  'FAIL, если история не вырастает из этого города (чужой остров, выдуманный крупный институт вместо данного) или если это пересказ описания без новой завязки.',
].join('\n');

function extraWithNote(base, note) {
  return [base, String(note || '').trim()].filter(Boolean).join('\n\n');
}

function architectExtraSystem({ requireMystery = false, fromVoid = false, fromGenesis = false } = {}) {
  const grain = fromVoid ? VOID_ARCHITECT_EXTRA : fromGenesis ? GENESIS_ARCHITECT_EXTRA : '';
  return [grain, requireMystery ? MYSTERY_ARCHITECT_EXTRA : '']
    .filter(Boolean)
    .join('\n\n');
}

function judgeExtraSystem({ requireMystery = false, fromVoid = false, fromGenesis = false } = {}) {
  const grain = fromVoid ? VOID_JUDGE_EXTRA : fromGenesis ? GENESIS_JUDGE_EXTRA : '';
  return [grain, requireMystery ? MYSTERY_JUDGE_EXTRA : '']
    .filter(Boolean)
    .join('\n\n');
}

function formatSeedUserBlock(seedText, fromVoid, fromGenesis = false) {
  if (fromVoid) {
    return [
      'ЗАТРАВКА',
      'нет. Придумай историю с нуля про абстрактный город-государство на летающем острове.',
    ].join('\n');
  }
  if (fromGenesis) {
    return ['ОПИСАНИЕ ГОРОДА (не хроника месяца)', String(seedText || '').trim() || '(пусто)'].join('\n');
  }
  return ['ЗАТРАВКА', seedText].join('\n');
}

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

export async function brainstormFreeformSeeds({
  runtime,
  seedText,
  gravity,
  config,
  log: parentLog,
  requireMystery = false,
  fromVoid = false,
  fromGenesis = false,
  note = '',
}) {
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
    extraSystem: extraWithNote(architectExtraSystem({ requireMystery, fromVoid, fromGenesis }), note),
    userMessages: [
      {
        role: 'user',
        content: [
          'GRAVITY',
          formatFreeformGravityForPrompt(g, config),
          '',
          formatSeedUserBlock(seedText, fromVoid, fromGenesis),
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

export async function reviewBrainstormPack({
  runtime,
  seedText,
  gravity,
  candidates,
  config,
  log: parentLog,
  requireMystery = false,
  fromVoid = false,
  fromGenesis = false,
  note = '',
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.judge' });
  const n = candidates.length;
  const indices = candidates.map((c, i) => Number(c.index) || i + 1);
  const g = parseFreeformGravity(gravity);
  if (!n) return { reviews: [], prompt: '' };
  const draft = { reviews: null };
  const indexHint = indices.join(', ');
  const runOpts = {
    agentId: 'freeformBrainstormJudge',
    tools: [
      {
        name: 'submit_freeform_pack_review',
        description: `Вердикт и правка по каждому из ${n} кандидатов (${indexHint}). Победителя не выбирай.`,
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
                  index: { type: 'integer', description: `Номер кандидата: ${indexHint}.` },
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
                        code: { type: 'string', enum: freeformPackJudgeCodes({ requireMystery }) },
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
          const reviews = parseFreeformPackReview(args, n, indices);
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
    extraSystem: extraWithNote(judgeExtraSystem({ requireMystery, fromVoid, fromGenesis }), note),
    userMessages: [
      {
        role: 'user',
        content: [
          'GRAVITY',
          formatFreeformGravityForPrompt(g, config),
          '',
          formatSeedUserBlock(seedText, fromVoid, fromGenesis),
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
  const reviews = draft.reviews || parseFreeformPackReview({}, n, indices);
  log.info('freeform.brainstorm.judge', {
    gravity: g,
    verdicts: reviews.map((r) => r.verdict),
    repairs: reviews.filter(reviewNeedsRewrite).length,
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
  requireMystery = false,
  fromVoid = false,
  fromGenesis = false,
  note = '',
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.repair' });
  const n = drafts.length;
  const g = parseFreeformGravity(gravity);
  if (!n) return { candidates: [], prompt: '' };
  const notes = (reviews || []).slice(0, n);
  if (!notes.some(reviewNeedsRewrite)) {
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
        reviewNeedsRewrite(review) ? `правка:\n${review.repair}` : 'правка: без изменений',
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
      architectExtraSystem({ requireMystery, fromVoid, fromGenesis }),
      String(note || '').trim(),
    ]
      .filter(Boolean)
      .join('\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          'GRAVITY',
          formatFreeformGravityForPrompt(g, config),
          '',
          formatSeedUserBlock(seedText, fromVoid, fromGenesis),
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

export function collectBrainstormPool(drafts, firstReviews, repaired = null, secondReviews = null) {
  const pool = [];
  for (let i = 0; i < (drafts || []).length; i += 1) {
    if (isPackPass(firstReviews?.[i])) {
      pool.push(drafts[i]);
      continue;
    }
    if (repaired && isPackPass(secondReviews?.[i])) pool.push(repaired[i]);
  }
  return pool;
}

function pickFromPool(pool, rng = Math.random) {
  if (!pool.length) return null;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[idx];
}

export function pickPassedBrainstormCandidate(candidates, reviews, rng = Math.random) {
  return pickFromPool(collectBrainstormPool(candidates, reviews), rng);
}

function scatterPackReviews(slotCount, reviews) {
  const out = Array.from({ length: slotCount }, () => null);
  for (const review of reviews || []) {
    const i = Number(review?.index) - 1;
    if (i >= 0 && i < slotCount) out[i] = review;
  }
  return out;
}

const MIN_PASS_SKIP_SECOND = 2;

export async function brainstormFreeformPack({
  runtime,
  seedText,
  gravity,
  config,
  log: parentLog,
  rng = Math.random,
  requireMystery = false,
  fromVoid = false,
  fromGenesis = false,
  note = '',
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.pack' });
  const drafted = await brainstormFreeformSeeds({
    runtime,
    seedText,
    gravity,
    config,
    log,
    requireMystery,
    fromVoid,
    fromGenesis,
    note,
  });
  if (!drafted.ok) {
    return {
      ok: false,
      gravity: drafted.gravity,
      drafts: drafted.candidates || [],
      reviews: [],
      finalReviews: [],
      candidates: drafted.candidates || [],
      winner: null,
      pickedIndex: null,
      prompt: drafted.prompt || '',
      judgePrompt: '',
      repairPrompt: '',
      finalJudgePrompt: '',
    };
  }
  const judged = await reviewBrainstormPack({
    runtime,
    seedText,
    gravity: drafted.gravity,
    candidates: drafted.candidates,
    config,
    log,
    requireMystery,
    fromVoid,
    fromGenesis,
    note,
  });
  const firstPassCount = (judged.reviews || []).filter(isPackPass).length;
  if (firstPassCount >= MIN_PASS_SKIP_SECOND) {
    const winner = pickPassedBrainstormCandidate(drafted.candidates, judged.reviews, rng);
    const pickedIndex = winner
      ? Number(winner.index) || drafted.candidates.indexOf(winner) + 1
      : null;
    return {
      ok: Boolean(winner),
      gravity: drafted.gravity,
      drafts: drafted.candidates,
      reviews: judged.reviews,
      finalReviews: [],
      candidates: drafted.candidates,
      winner,
      pickedIndex,
      prompt: drafted.prompt,
      judgePrompt: judged.prompt,
      repairPrompt: '',
      finalJudgePrompt: '',
    };
  }
  const repaired = await repairBrainstormPack({
    runtime,
    seedText,
    gravity: drafted.gravity,
    drafts: drafted.candidates,
    reviews: judged.reviews,
    config,
    log,
    requireMystery,
    fromVoid,
    fromGenesis,
    note,
  });
  const candidates = (repaired.candidates || []).map((c, i) =>
    isPackPass(judged.reviews[i]) ? drafted.candidates[i] : c,
  );
  const retry = candidates.filter((_, i) => !isPackPass(judged.reviews[i]));
  const gated = retry.length
    ? await reviewBrainstormPack({
        runtime,
        seedText,
        gravity: drafted.gravity,
        candidates: retry,
        config,
        log,
        requireMystery,
        fromVoid,
        fromGenesis,
        note,
      })
    : { reviews: [], prompt: '' };
  const finalReviews = scatterPackReviews(candidates.length, gated.reviews);
  const pool = collectBrainstormPool(drafted.candidates, judged.reviews, candidates, finalReviews);
  const winner = pickFromPool(pool, rng);
  const pickedIndex = winner
    ? Number(winner.index) || candidates.indexOf(winner) + 1 || drafted.candidates.indexOf(winner) + 1
    : null;
  return {
    ok: Boolean(winner),
    gravity: drafted.gravity,
    drafts: drafted.candidates,
    reviews: judged.reviews,
    finalReviews,
    candidates,
    winner,
    pickedIndex,
    prompt: drafted.prompt,
    judgePrompt: judged.prompt,
    repairPrompt: repaired.prompt,
    finalJudgePrompt: gated.prompt,
  };
}
