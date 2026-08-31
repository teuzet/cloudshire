/**
 * Генератор трёх затравок: код бросает оси, модель раскрывает их в четыре поля.
 * Лаборатория: пачка → один судья по всем трём → одна правка архитектора.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import {
  parseFreeformGravity,
  formatFreeformGravityForPrompt,
  formatBrainstormCandidateForPrompt,
  freeformConfig,
} from './freeform.js';
import {
  pickFreeformSeedAxisPairs,
  normalizeSeedBlank,
  captureAgentPrompt,
  formatFreeformArenaRelationCatalogs,
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

function formatCatalogBlock(title, entries) {
  const lines = [title];
  for (const entry of entries) {
    lines.push(`${entry.id} — ${entry.hint}`);
  }
  return lines.join('\n');
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
  return pairs.map((pair, i) => ({
    pair,
    conflictSource: sources[i] || sources[0],
    temporalShape: shapes[i] || shapes[0],
  }));
}

export function formatFreeformBrainstormRollsForPrompt(rolls) {
  if (!rolls?.length) return '';
  const lines = [
    'Оси уже брошены кодом. Не выбирай и не меняй их — раскрой в текст.',
    'Метки — ассоциативные поля, не жанр и не обязательные существительные.',
    '',
    formatFreeformArenaRelationCatalogs(),
    '',
    formatCatalogBlock('conflictSource', CONFLICT_SOURCES),
    '',
    formatCatalogBlock('temporalShape', TEMPORAL_SHAPES),
    '',
    'Наборы. На каждый — четыре поля (затравка, конфликт, динамика, последствия), в этом порядке:',
  ];
  rolls.forEach((roll, i) => {
    const arena = pairTagName(roll.pair, 'threatArena') || '?';
    const rel = pairTagName(roll.pair, 'worldRelation') || '?';
    lines.push(`${i + 1}. ${arena} · ${rel} · ${roll.conflictSource.id} · ${roll.temporalShape.id}`);
  });
  return lines.join('\n').trim();
}

export function normalizeBrainstormCandidate(raw, roll, index = 1) {
  const blank = normalizeSeedBlank(raw, roll?.pair || []);
  if (!blank) return null;
  return {
    ...blank,
    index,
    conflictSource: roll.conflictSource.id,
    temporalShape: roll.temporalShape.id,
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
  };
}

function emitCandidatesTool({ n, rolls, draft, log }) {
  return {
    name: 'emit_freeform_candidates',
    description: `Ровно ${n} кандидатов: четыре поля на каждый набор осей, в том же порядке. Оси в ответе — эхо входа, не новый выбор.`,
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
            required: ['hook', 'conflict', 'dynamics', 'consequences'],
            properties: {
              hook: {
                type: 'string',
                description: 'Затравка: компактная сцена, 1–2 предложения. Что уже произошло. Фитиль, не взрыв.',
              },
              conflict: {
                type: 'string',
                description: 'Конфликт: что сейчас двигает сюжет.',
              },
              dynamics: {
                type: 'string',
                description: 'Динамика: процесс, которым ситуация вырастет до посадки Gravity.',
              },
              consequences: {
                type: 'string',
                description: 'Последствия: посадка истории на уровне Gravity. Динамика должна её зарабатывать, не приклеивать.',
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
        return toolFail(
          'thin',
          `Нужно ровно ${n} кандидатов: у каждого затравка, конфликт, динамика и последствия.`,
        );
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
          '====================',
          'ХРОНИКА',
          '====================',
          seedText,
          '',
          formatFreeformGravityForPrompt(g),
          '',
          formatFreeformBrainstormRollsForPrompt(rolls),
          '',
          `Верни ровно ${n} кандидатов через emit_freeform_candidates, в порядке наборов.`,
          'У каждого: затравка, конфликт, динамика, последствия. Gravity — посадка в поле «последствия», не размер затравки.',
          'Оси в ответе верни такими, какими получил.',
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

export async function reviewBrainstormPack({ runtime, seedText, gravity, candidates, log: parentLog }) {
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
          '====================',
          'ХРОНИКА',
          '====================',
          seedText,
          '',
          formatFreeformGravityForPrompt(g),
          '',
          formatPackForJudge(candidates),
          '',
          `Кандидатов: ${n}. Вызови submit_freeform_pack_review по каждому, в том же порядке.`,
          'Победителя не выбирай. Города нет. Gravity — посадка в «последствиях».',
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
        formatBrainstormCandidateForPrompt(c, c.index || i + 1),
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
      'Сейчас ты не придумываешь новую пачку. Ты правишь уже написанные три кандидата по замечаниям судьи.',
      'Оси не меняй. Центральный механизм не подменяй, кроме случая, когда судья требует убрать новый закон мира — тогда тот же двигатель внутри уже данного порядка.',
      'Не поднимай и не опускай Gravity риторикой. Правь посадку в «последствиях» и динамику, которая её зарабатывает.',
      'Если просят обострить — конкретные ходы в динамике, не новая посадка и не новый конфликт. Если просят ужать — вырежи лишнее, механизм оставь.',
      'Кандидат без замечания верни без изменений. Не делай кандидатов близнецами.',
    ].join('\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          '====================',
          'ХРОНИКА',
          '====================',
          seedText,
          '',
          formatFreeformGravityForPrompt(g),
          '',
          'ДОРАБОТКА. Ниже черновики и замечания судьи. Верни три полных кандидата в том же порядке.',
          '',
          pack,
          '',
          `Верни ровно ${n} кандидатов через emit_freeform_candidates.`,
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
    log,
  });
  const repaired = await repairBrainstormPack({
    runtime,
    seedText,
    gravity: drafted.gravity,
    drafts: drafted.candidates,
    reviews: judged.reviews,
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
