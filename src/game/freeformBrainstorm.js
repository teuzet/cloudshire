/**
 * Генератор трёх следующих хроник: код бросает четыре оси мира, модель пишет один текст на набор.
 * Двигатель и профиль во времени модель выбирает сама из меню и возвращает вместе с текстом.
 * Лаборатория: пачка → судья. PASS сразу в пул и не чинится.
 * Не-PASS всегда идут на починку, даже если PASS уже ≥2.
 * Второй судья видит только чиненные слоты.
 * Пока есть FAIL с правкой — до двух дешёвых кругов luna
 * (gravity, оси, текст, замечание судьи; без брифа города).
 * Победителя из PASS выбирает дешёвый агент; случайный — только запасной путь.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX } from './plotlines.js';
import { splitChronicleHiddenLayer } from './freeformAssemble.js';
import {
  parseFreeformGravity,
  formatFreeformGravityForPrompt,
  formatBrainstormCandidateForPrompt,
  freeformConfig,
  FREEFORM_AXIS_IDS,
} from './freeform.js';
import {
  pickFreeformSeedAxisSets,
  formatFreeformAxisCatalogs,
  formatAxisSetLine,
  captureAgentPrompt,
} from './freeformArchitect.js';
import {
  parseFreeformPackReview,
  reviewNeedsRewrite,
  isPackPass,
  freeformPackJudgeCodes,
} from './freeformJudge.js';

/**
 * Двигатель истории — меню, а не жребий: агент берёт одно значение сам и возвращает эхом.
 * Внешнее, отложенное и аномальное сюда не входят — это уже worldRelation и arena.
 */
export const STORY_ENGINES = [
  {
    id: 'REFUSAL',
    hint: 'кто-то перестал делать то, на что город рассчитывал: отказ, уход, неявка, молчание. Не саботаж и не злодейство',
  },
  {
    id: 'DISCOVERY',
    hint: 'город нашёл или узнал то, чего у него не было: место, существо, способ, правду. Двигает не находка, а спор о том, что с ней делать',
  },
  {
    id: 'OPEN_FEUD',
    hint: 'два лагеря уже открыто бьются за одно и то же, и у обоих есть силы победить',
  },
  {
    id: 'INTERNAL_BETRAYAL',
    hint: 'кто-то внутри круга доверия ломает договор, молчание или долг',
  },
  {
    id: 'SYSTEMIC_CRISIS',
    hint: 'ломается уклад, на котором держится жизнь города: договор, обычай, распределение, привычный порядок труда. Чинят делом и отношением, не канцелярией и не потерянной бумагой',
  },
  {
    id: 'MORAL_DILEMMA',
    hint: 'два законных требования, нельзя удовлетворить оба. Нет злодея',
  },
  {
    id: 'PRICE_OF_SUCCESS',
    hint: 'что-то вышло слишком хорошо, и город не выдерживает своей удачи: избыток, слава, приток, урожай не по силам',
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

/** Явный флаг перекрывает бросок. Без флага — шанс из конфига. */
export function shouldRequireSeedMystery(config, { requireMystery, rng = Math.random } = {}) {
  if (requireMystery !== undefined && requireMystery !== null && requireMystery !== '') {
    return parseRequireMystery(requireMystery);
  }
  return rng() < freeformConfig(config).seedMysteryChance;
}

export const MYSTERY_ARCHITECT_EXTRA = [
  '==== ОБЯЗАТЕЛЬНАЯ ТАЙНА ====',
  'В этом посеве в каждом кандидате ОБЯЗАТЕЛЬНО есть тайна с интересной разгадкой.',
  'Это переопределяет правило «тайну ради тайны не выдумывай».',
  '',
  '- В наблюдаемом слое игрок видит странность, нестыковку или сокрытие, которую нельзя сразу объяснить. Не обязательно преступление: ложь, пропажа, подмена, необъяснимый поступок, секрет, который кто-то бережёт.',
  '- В конце каждого кандидата блок «На самом деле:» с полной разгадкой: что произошло, кто знает, кто врёт, какая улика это подтвердит. Разгадка конкретна и проверяема в мире — не магия, не сон, не «все сошли с ума».',
  '- Разгадка не разочаровывает: она следует из уже названных фактов и характеров. Читатель, узнав её, говорит «так вот оно что», а не «и это всё?».',
  '- «Неизвестно», «мнения расходятся», «проверка ничего не дала» — это не разгадка. Нужен конкретный ответ, который можно вскрыть делом.',
  '- Тайна не декоративна: без неё история теряет смысл. Концы (GOOD/NEUTRAL/BAD) зависят от того, вскроется ли тайна и чем это обернётся.',
  '- Не пропускай «На самом деле:» ни у одного из трёх кандидатов.',
].join('\n');

export const MYSTERY_JUDGE_EXTRA = [
  '==== ДОПОЛНИТЕЛЬНЫЕ КРИТЕРИИ (тайна обязательна) ====',
  '13. BUREAUCRACY — двигатель не канцелярия. FAIL, только если без протоколов, сверки записей, комиссии, отложенного заседания или потерянной бумаги от сюжета ничего не остаётся. Правовой или социальный конфликт, где документ — предлог или фон, допустим.',
  '13b. ENGINEERING_PORN — двигатель не инженерия города. FAIL, только если без дорог, подъёмников, желобов, галерей, водостоков, подпорок, складов, настилов или контура «чинить инфраструктуру» от сюжета ничего не остаётся. Лес, каменоломня, осыпь, тварь или совет, где путь или кромка — место или цена, допустимы.',
  '14. MYSTERY — в пакете есть настоящая тайна: странность, которую персонажи и игрок не могут сразу объяснить. Если завязка прозрачна и нечего разгадывать — FAIL.',
  '15. MYSTERY_PLAUSIBLE — разгадка в «На самом деле:» логична, конкретна и не разочаровывает. FAIL если разгадки нет, она отговорка («неизвестно», «мнения расходятся», «проверка ничего не дала»), противоречит фактам, или вся разгадка сводится к «ну так вышло» без механизма.',
  'Конкретный механизм, в котором есть случай, ирония или «обряд сработал не по той причине, что думали» — PASS, не отговорка.',
  'Не ставь FAIL только потому, что разгадка не выводит каждую регулярность из первых принципов или «ослабляет» тайну иронией.',
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
  '==== ЗАТРАВКА — БРИФ ГОРОДА ====',
  'Дан стандартный бриф города — тот же, что получают агенты. Не полное описание и не каталог сущностей.',
  'Это переопределяет правило «данная затравка — причина конфликта»: конфликт не обязан следовать из одной фразы.',
  'Город — фон и материал. Не пересказывай бриф. Три кандидата — три разных завязки, не три вариации одного крючка.',
].join('\n');

export const GENESIS_JUDGE_EXTRA = [
  '==== ЗАТРАВКА — БРИФ ГОРОДА ====',
  'Критерий CHRONICLE не требуй как вытекание из одной строки брифа.',
  'FAIL, если история противоречит брифу, происходит на чужом острове, или это пересказ брифа без новой завязки.',
  'Не ставь FAIL только за то, что конфликт не вырос из конкретной фразы брифа: бриф — фон и материал, не обязательный крючок.',
].join('\n');

function extraWithNote(base, note) {
  return [base, String(note || '').trim()].filter(Boolean).join('\n\n');
}

function architectExtraSystem({
  requireMystery = false,
  fromVoid = false,
  fromGenesis = false,
} = {}) {
  const grain = fromVoid ? VOID_ARCHITECT_EXTRA : fromGenesis ? GENESIS_ARCHITECT_EXTRA : '';
  return [grain, requireMystery ? MYSTERY_ARCHITECT_EXTRA : ''].filter(Boolean).join('\n\n');
}

function judgeExtraSystem({
  requireMystery = false,
  fromVoid = false,
  fromGenesis = false,
} = {}) {
  const grain = fromVoid ? VOID_JUDGE_EXTRA : fromGenesis ? GENESIS_JUDGE_EXTRA : '';
  return [grain, requireMystery ? MYSTERY_JUDGE_EXTRA : ''].filter(Boolean).join('\n\n');
}

function formatSeedUserBlock(seedText, fromVoid, fromGenesis = false) {
  if (fromVoid) {
    return [
      'ЗАТРАВКА',
      'нет. Придумай историю с нуля про абстрактный город-государство на летающем острове.',
    ].join('\n');
  }
  if (fromGenesis) {
    return [
      'БРИФ ГОРОДА (стандартный бриф для агентов, не полное описание)',
      String(seedText || '').trim() || '(пусто)',
    ].join('\n');
  }
  return ['ЗАТРАВКА', seedText].join('\n');
}

/** Профиль во времени — тоже меню на выбор агента. */
export const STORY_TIMINGS = [
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
    id: 'BLOW',
    hint: 'удар уже случился и часть города потеряна; история про то, чем жить дальше',
  },
  {
    id: 'DID_NOT_HAPPEN',
    hint: 'то, что случалось всегда, в этот раз не случилось',
  },
];

function menuIds(menu) {
  return menu.map((item) => item.id);
}

function formatMenu(title, menu) {
  return [title, ...menu.map((item) => `${item.id} — ${item.hint}`)].join('\n');
}

/** Двигатель и время агент выбирает сам: в промпт уходит меню, не назначение. */
export function formatFreeformBrainstormMenusForPrompt() {
  return [
    formatMenu('engine — природа двигателя. Выбери сам, по одному значению на кандидата:', STORY_ENGINES),
    '',
    formatMenu('timing — как конфликт выглядит по времени. Тоже выбери сам:', STORY_TIMINGS),
  ].join('\n');
}

function pickWithoutReplacement(items, n, rng) {
  const pool = [...items];
  const out = [];
  for (let i = 0; i < n && pool.length; i += 1) {
    const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function axisTagName(axes, groupId) {
  return (axes || []).find((t) => t.groupId === groupId)?.tagName || '';
}

function axisEcho(raw, key) {
  return String(raw?.[key] || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

export function pickFreeformBrainstormRolls(config, count, rng = Math.random) {
  const n = Math.max(1, Math.round(Number(count) || 1));
  const sets = pickFreeformSeedAxisSets(config, n, rng);
  const authors = pickWithoutReplacement(freeformConfig(config).continuationAuthors, n, rng);
  return sets.map((axes, i) => ({
    axes,
    author: authors[i] || authors[0],
    engine: null,
    timing: null,
  }));
}

export function formatFreeformBrainstormRollsForPrompt(rolls) {
  if (!rolls?.length) return '';
  return rolls
    .map((roll, i) => {
      const author = roll.author?.name || roll.authorName || '?';
      const chosen = [
        roll.engine?.id ? `engine ${roll.engine.id}` : null,
        roll.timing?.id ? `timing ${roll.timing.id}` : null,
      ].filter(Boolean);
      return [`${i + 1}. ${formatAxisSetLine(roll.axes)}`, ...chosen, `автор ${author}`].join(' · ');
    })
    .join('\n');
}

export function normalizeBrainstormCandidate(raw, roll, index = 1, maxChars = PLOT_SUMMARY_MAX) {
  const split = splitChronicleHiddenLayer(raw?.chronicle || raw?.text || raw?.hook);
  const publicLayer = clipPlotText(split.chronicle, maxChars);
  if (!publicLayer) return null;
  const hidden = split.hiddenPremises.filter(Boolean);
  const chronicle = hidden.length ? `${publicLayer}\nНа самом деле: ${hidden.join('\n')}` : publicLayer;
  return {
    title: clipPlotText(raw?.title, PLOT_TITLE_MAX) || '',
    chronicle,
    text: chronicle,
    hook: chronicle,
    index,
    arena: axisTagName(roll?.axes, 'arena'),
    worldRelation: axisTagName(roll?.axes, 'worldRelation'),
    target: axisTagName(roll?.axes, 'target'),
    knowledge: axisTagName(roll?.axes, 'knowledge'),
    engine: roll?.engine?.id || axisEcho(raw, 'engine'),
    timing: roll?.timing?.id || axisEcho(raw, 'timing'),
    authorId: roll.author?.id || '',
    authorName: roll.author?.name || '',
  };
}

/** Эхо сверяем только по брошенным осям: двигатель и время агент выбирает сам. */
function logAxisEchoMismatch(log, index, raw, roll) {
  const expected = Object.fromEntries(
    FREEFORM_AXIS_IDS.map((id) => [id, axisTagName(roll.axes, id)]),
  );
  const got = Object.fromEntries(FREEFORM_AXIS_IDS.map((id) => [id, axisEcho(raw, id)]));
  const mismatched = Object.keys(expected).filter((key) => got[key] && got[key] !== expected[key]);
  if (!mismatched.length) return;
  log.warn('freeform.brainstorm.axis_echo_mismatch', { index, expected, got, mismatched });
}

export function rollFromBrainstormCandidate(candidate) {
  return {
    axes: FREEFORM_AXIS_IDS.map((groupId) => {
      const name = String(candidate?.[groupId] || '').trim();
      return { groupId, tagId: name.toLowerCase(), tagName: name };
    }).filter((tag) => tag.tagName),
    engine: candidate?.engine ? { id: candidate.engine } : null,
    timing: candidate?.timing ? { id: candidate.timing } : null,
    author: {
      id: candidate?.authorId || '',
      name: candidate?.authorName || '',
    },
  };
}

function emitCandidatesTool({ n, rolls, draft, log, indices = null, maxChars = PLOT_SUMMARY_MAX }) {
  return {
    name: 'emit_freeform_candidates',
    description: `Ровно ${n} кандидатов: одна следующая хроника на каждый набор осей, в том же порядке. Брошенные оси в ответе — эхо входа; engine и timing выбираешь сам.`,
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
            required: ['chronicle', 'engine', 'timing'],
            properties: {
              chronicle: {
                type: 'string',
                description:
                  `Сюжет-затравка: 5–8 кратких предложений, без лишних деталей, до ${maxChars} символов`,
              },
              arena: { type: 'string', description: 'Эхо оси arena этого набора.' },
              worldRelation: { type: 'string', description: 'Эхо оси worldRelation этого набора.' },
              target: { type: 'string', description: 'Эхо оси target этого набора.' },
              knowledge: { type: 'string', description: 'Эхо оси knowledge этого набора.' },
              engine: {
                type: 'string',
                enum: menuIds(STORY_ENGINES),
                description: 'Двигатель, который ты выбрал для этого кандидата.',
              },
              timing: {
                type: 'string',
                enum: menuIds(STORY_TIMINGS),
                description: 'Профиль во времени, который ты выбрал для этого кандидата.',
              },
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
          const index = Number(indices?.[i]) || i + 1;
          return normalizeBrainstormCandidate(list[i], roll, index, maxChars);
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
  domainId = null,
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
      [...(roll.axes || []).map((t) => `${t.groupId}:${t.tagId}`), roll.author?.id]
        .filter(Boolean)
        .join('+'),
    ),
  });

  const draft = { variants: null };
  const runOpts = {
    agentId: 'freeformBrainstorm',
    tools: [emitCandidatesTool({ n, rolls, draft, log, maxChars: cfg.chronicleMaxChars.seed })],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'emit_freeform_candidates' } },
    log,
    scene: 'freeform_brainstorm_seed',
    domainId,
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
          formatFreeformAxisCatalogs(config),
          '',
          formatFreeformBrainstormMenusForPrompt(),
          '',
          'НАБОРЫ',
          formatFreeformBrainstormRollsForPrompt(rolls),
        ]
          .filter((line) => line != null)
          .join('\n'),
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
  domainId = null,
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
    domainId,
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
        ]
          .filter((line) => line != null)
          .join('\n'),
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

function formatRepairSlot(candidate, review, index, { includeAuthor = true } = {}) {
  const note = review || { index, verdict: 'PASS', repair: '', summary: '', issues: [] };
  const issues = (note.issues || []).map((x) => `[${x.code}] ${x.reason}`).join('\n');
  return [
    formatBrainstormCandidateForPrompt(candidate, index, { includeAuthor }),
    `вердикт: ${note.verdict}`,
    note.summary ? `кратко: ${note.summary}` : null,
    issues ? `замечания:\n${issues}` : null,
    reviewNeedsRewrite(note) ? `правка:\n${note.repair}` : 'правка: без изменений',
  ]
    .filter(Boolean)
    .join('\n');
}

function mergeRepairedSlots(drafts, variants) {
  if (!variants?.length) return drafts;
  const byIndex = new Map(variants.map((item) => [Number(item.index) || 0, item]));
  return drafts.map((item, i) => {
    const index = Number(item.index) || i + 1;
    return byIndex.get(index) || item;
  });
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
  agentId = 'freeformBrainstorm',
  omitSeed = false,
  onlyFailed = false,
  domainId = null,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.repair' });
  const n = drafts.length;
  const g = parseFreeformGravity(gravity);
  const maxChars = freeformConfig(config).chronicleMaxChars.seed;
  if (!n) return { candidates: [], prompt: '' };
  const notes = (reviews || []).slice(0, n);
  const slots = drafts.map((candidate, i) => ({
    candidate,
    review: notes[i],
    index: Number(candidate.index) || i + 1,
  }));
  const work = onlyFailed ? slots.filter((slot) => reviewNeedsRewrite(slot.review)) : slots;
  if (!work.length || !work.some((slot) => reviewNeedsRewrite(slot.review))) {
    return { candidates: drafts, prompt: '' };
  }

  const rolls = work.map((slot) => rollFromBrainstormCandidate(slot.candidate));
  const indices = work.map((slot) => slot.index);
  const draft = { variants: null };
  const pack = work
    .map((slot) =>
      formatRepairSlot(slot.candidate, slot.review, slot.index, { includeAuthor: !omitSeed }),
    )
    .join('\n\n');

  const cheap = omitSeed || agentId === 'freeformBrainstormRepair';
  const runOpts = {
    agentId,
    tools: [emitCandidatesTool({ n: work.length, rolls, draft, log, indices, maxChars })],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'emit_freeform_candidates' } },
    log,
    scene: cheap ? 'freeform_brainstorm_luna_repair' : 'freeform_brainstorm_repair',
    domainId,
    extraSystem: cheap
      ? extraWithNote(requireMystery ? MYSTERY_ARCHITECT_EXTRA : '', '')
      : [
          'Сейчас ты не придумываешь новую пачку. Ты правишь уже написанные три хроники по замечаниям судьи.',
          'Оси и автора не меняй. Центральный механизм не подменяй, кроме случая, когда судья требует убрать новый закон мира — тогда тот же двигатель внутри уже данного порядка.',
          'Не подменяй двигатель инженерией: желоб, водосток, водоотвод, скрытая галерея, дорога, подъёмник, настил или склад как новая причинная система.',
          'Если просят поднять Gravity — укрупни уже данный конфликт (обряд, существо, ветер, спор), не сажай второй сюжет про трубы и влагу. Места из брифа города — декорации, не новый механизм.',
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
          cheap ? null : '',
          cheap ? null : formatSeedUserBlock(seedText, fromVoid, fromGenesis),
          '',
          'ДОРАБОТКА',
          pack,
        ]
          .filter((line) => line != null)
          .join('\n'),
      },
    ],
  };

  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.brainstorm.repair_failed', { error: err.message, agentId });
  }
  const variants = draft.variants?.length >= work.length ? draft.variants : [];
  return { candidates: mergeRepairedSlots(drafts, variants), prompt };
}

export function collectBrainstormPoolEntries(drafts, firstReviews, repaired = null, secondReviews = null) {
  const entries = [];
  for (let i = 0; i < (drafts || []).length; i += 1) {
    const draft = drafts[i];
    const index = Number(draft?.index) || i + 1;
    if (isPackPass(firstReviews?.[i])) {
      entries.push({ index, source: 'first_pass', candidate: draft });
      continue;
    }
    if (repaired && isPackPass(secondReviews?.[i])) {
      entries.push({ index, source: 'repaired', candidate: repaired[i] });
    }
  }
  return entries;
}

export function collectBrainstormPool(drafts, firstReviews, repaired = null, secondReviews = null) {
  return collectBrainstormPoolEntries(drafts, firstReviews, repaired, secondReviews).map((entry) => entry.candidate);
}

function pickFromPool(pool, rng = Math.random) {
  if (!pool.length) return null;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[idx];
}

function poolIndex(candidate, i) {
  const n = Number(candidate?.index);
  return Number.isInteger(n) && n > 0 ? n : i + 1;
}

export function parseFreeformPoolPick(raw, allowedIndices) {
  const allowed = [
    ...new Set(
      (allowedIndices || [])
        .map((n) => Math.round(Number(n)))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
  const pick = Math.round(Number(raw?.pick));
  if (!allowed.includes(pick)) return null;
  return { pick, why: clipPlotText(raw?.why, 400) };
}

export function pickPassedBrainstormCandidate(candidates, reviews, rng = Math.random) {
  return pickFromPool(collectBrainstormPool(candidates, reviews), rng);
}

export async function pickBrainstormPoolWinner({
  runtime,
  pool,
  gravity,
  config,
  log: parentLog,
  rng = Math.random,
  domainId = null,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm.pick' });
  const list = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!list.length) return { winner: null, prompt: '', pickedIndex: null, source: 'empty', why: '' };
  if (list.length === 1) {
    const winner = list[0];
    return {
      winner,
      prompt: '',
      pickedIndex: poolIndex(winner, 0),
      source: 'single',
      why: '',
    };
  }
  const allowed = list.map((candidate, i) => poolIndex(candidate, i));
  const draft = { pick: null };
  const g = parseFreeformGravity(gravity);
  const runOpts = {
    agentId: 'freeformBrainstormPick',
    tools: [
      {
        name: 'pick_freeform_pool_winner',
        description: `Выбери один номер из пула PASS: ${allowed.join(', ')}.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['pick'],
          properties: {
            pick: { type: 'integer', description: `Номер кандидата: ${allowed.join(', ')}.` },
            why: { type: 'string', description: 'Коротко, почему этот, а не остальные.' },
          },
        },
        handler: async (args) => {
          const parsed = parseFreeformPoolPick(args, allowed);
          if (!parsed) {
            return toolFail('thin', `Нужен номер из пула: ${allowed.join(', ')}.`);
          }
          draft.pick = parsed;
          return { ok: true, pick: parsed.pick };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'pick_freeform_pool_winner' } },
    log,
    scene: 'freeform_brainstorm_pick',
    domainId,
    userMessages: [
      {
        role: 'user',
        content: [
          `Пул PASS. Выбери один номер: ${allowed.join(', ')}.`,
          '',
          'GRAVITY',
          formatFreeformGravityForPrompt(g, config),
          '',
          list
            .map((candidate, i) => formatBrainstormCandidateForPrompt(candidate, poolIndex(candidate, i)))
            .filter(Boolean)
            .join('\n\n'),
        ].join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.brainstorm.pick_failed', { error: err.message });
  }
  const parsed = draft.pick;
  const winner = parsed
    ? list.find((candidate, i) => poolIndex(candidate, i) === parsed.pick) || null
    : null;
  if (winner) {
    log.info('freeform.brainstorm.pick', { pick: parsed.pick, why: parsed.why, source: 'agent' });
    return { winner, prompt, pickedIndex: parsed.pick, source: 'agent', why: parsed.why || '' };
  }
  const fallback = pickFromPool(list, rng);
  log.warn('freeform.brainstorm.pick_fallback', { allowed });
  return {
    winner: fallback,
    prompt,
    pickedIndex: fallback ? poolIndex(fallback, list.indexOf(fallback)) : null,
    source: 'fallback',
    why: '',
  };
}

function scatterPackReviews(slotCount, reviews) {
  const out = Array.from({ length: slotCount }, () => null);
  for (const review of reviews || []) {
    const i = Number(review?.index) - 1;
    if (i >= 0 && i < slotCount) out[i] = review;
  }
  return out;
}

function freezeFirstPass(originals, firstReviews, next) {
  return (next || []).map((item, i) => (isPackPass(firstReviews?.[i]) ? originals[i] : item));
}

function mergeScatteredReviews(base, incoming) {
  const n = Math.max(base?.length || 0, incoming?.length || 0);
  return Array.from({ length: n }, (_, i) => (incoming?.[i] != null ? incoming[i] : base?.[i] ?? null));
}

function latestSlotReviews(firstReviews, later) {
  return (firstReviews || []).map((first, i) => later?.[i] || first);
}

function lunaRepairRoundLimit(config) {
  return freeformConfig(config).lunaRepairRounds;
}

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
  domainId = null,
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
    domainId,
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
      extraRepairPrompt: '',
      extraJudgePrompt: '',
      pickPrompt: '',
      pickSource: 'empty',
      pickWhy: '',
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
    domainId,
  });
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
    domainId,
  });
  let candidates = freezeFirstPass(drafted.candidates, judged.reviews, repaired.candidates);
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
        domainId,
      })
    : { reviews: [], prompt: '' };
  let finalReviews = scatterPackReviews(candidates.length, gated.reviews);
  const extraRepairPrompts = [];
  const extraJudgePrompts = [];
  const lunaMax = lunaRepairRoundLimit(config);
  for (let round = 0; round < lunaMax; round += 1) {
    const slotReviews = latestSlotReviews(judged.reviews, finalReviews);
    if (!slotReviews.some(reviewNeedsRewrite)) break;
    const cheap = await repairBrainstormPack({
      runtime,
      seedText,
      gravity: drafted.gravity,
      drafts: candidates,
      reviews: slotReviews,
      config,
      log,
      requireMystery,
      fromVoid,
      fromGenesis,
      agentId: 'freeformBrainstormRepair',
      omitSeed: true,
      onlyFailed: true,
      domainId,
    });
    if (!cheap.prompt) break;
    extraRepairPrompts.push(cheap.prompt);
    candidates = freezeFirstPass(drafted.candidates, judged.reviews, cheap.candidates);
    const lunaRetry = candidates.filter((_, i) => reviewNeedsRewrite(slotReviews[i]));
    const lunaGated = lunaRetry.length
      ? await reviewBrainstormPack({
          runtime,
          seedText,
          gravity: drafted.gravity,
          candidates: lunaRetry,
          config,
          log,
          requireMystery,
          fromVoid,
          fromGenesis,
          note,
          domainId,
        })
      : { reviews: [], prompt: '' };
    if (lunaGated.prompt) extraJudgePrompts.push(lunaGated.prompt);
    finalReviews = mergeScatteredReviews(
      finalReviews,
      scatterPackReviews(candidates.length, lunaGated.reviews),
    );
    log.info('freeform.brainstorm.luna_repair', {
      round: round + 1,
      pass: collectBrainstormPool(drafted.candidates, judged.reviews, candidates, finalReviews).length,
    });
  }
  const pool = collectBrainstormPool(drafted.candidates, judged.reviews, candidates, finalReviews);
  const picked = await pickBrainstormPoolWinner({
    runtime,
    pool,
    gravity: drafted.gravity,
    config,
    log,
    rng,
    domainId,
  });
  return {
    ok: Boolean(picked.winner),
    gravity: drafted.gravity,
    drafts: drafted.candidates,
    reviews: judged.reviews,
    finalReviews,
    candidates,
    winner: picked.winner,
    pickedIndex: picked.pickedIndex,
    pickSource: picked.source,
    pickWhy: picked.why || '',
    prompt: drafted.prompt,
    judgePrompt: judged.prompt,
    repairPrompt: repaired.prompt,
    finalJudgePrompt: gated.prompt,
    extraRepairPrompt: extraRepairPrompts.join('\n\n'),
    extraJudgePrompt: extraJudgePrompts.join('\n\n'),
    pickPrompt: picked.prompt || '',
  };
}
