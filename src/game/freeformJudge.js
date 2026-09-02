import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText } from './plotlines.js';
import { runVerdictJudge, literaryJudgeAccepts } from './mysteryJudge.js';
import { formatFreeformGravityForPrompt, formatFreeformSeedBlank } from './freeform.js';
import { captureAgentPrompt } from './agentPrompt.js';

export const FREEFORM_JUDGE_CODES = [
  'HIDDEN_LEAK',
  'CANON_CONFLICT',
  'INCONSISTENT',
  'DULL',
  'CLOSE_WHEN_WEAK',
  'PREMATURE_CLOSE',
  'TWIN',
  'OTHER',
];

function asCode(raw) {
  const c = String(raw || '').trim().toUpperCase().replace(/\s+/g, '_');
  return FREEFORM_JUDGE_CODES.includes(c) ? c : 'OTHER';
}

export function parseFreeformPick(raw, variantCount) {
  const n = variantCount;
  let pick = Math.round(Number(raw?.pick));
  if (!Number.isInteger(pick) || pick < 1 || pick > n) pick = 1;
  const why = clipPlotText(raw?.why, 400);
  const repair = clipPlotText(raw?.repair, 800);
  const issues = [];
  for (const item of raw?.issues || []) {
    const reason = clipPlotText(item?.reason, 400);
    if (!reason) continue;
    issues.push({
      index: Math.round(Number(item?.index)) || null,
      code: asCode(item?.code),
      reason,
    });
  }
  return { pick, why, repair: repair || '', issues };
}

export function formatFreeformVariants(variants) {
  return variants
    .map((v, i) => {
      const body = [
        `=== Вариант ${i + 1}: ${v.title || '(без названия)'} ===`,
        v.arena ? `arena: ${v.arena}` : null,
        v.worldRelation ? `worldRelation: ${v.worldRelation}` : null,
        v.hook ? `затравка: ${v.hook}` : null,
        !v.hook && v.text ? v.text : null,
        v.conflict ? `конфликт: ${v.conflict}` : null,
        v.dynamicName
          ? `динамика сюжета: ${v.dynamicName}${v.dynamicHint ? ` — ${v.dynamicHint}` : ''}`
          : v.dynamics
            ? `динамика: ${v.dynamics}`
            : null,
        v.consequences ? `последствия: ${v.consequences}` : null,
        v.premise && v.premise !== v.text && v.premise !== v.hook ? `premise: ${v.premise}` : null,
        v.synopsis ? `synopsis: ${v.synopsis}` : null,
        Array.isArray(v.closeWhen) && v.closeWhen.length
          ? `closeWhen:\n${v.closeWhen.map((x) => `- ${x}`).join('\n')}`
          : null,
        Array.isArray(v.hiddenPremises)
          ? `hiddenPremises:\n${v.hiddenPremises.map((h) => `- ${h}`).join('\n') || '- (нет)'}`
          : null,
        v.urgency != null ? `urgency: ${v.urgency}` : null,
        v.entry ? `entry: ${v.entry}` : null,
        v.chronicle ? `chronicle: ${v.chronicle}` : null,
        v.closed ? `CLOSED: ${v.closedBy || 'да'}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return body;
    })
    .join('\n\n');
}

/**
 * Судья видит болванки разом: отсекает невозможное, берёт самое любопытное.
 * Город и космология — чтобы отсечь прямое противоречие, не чтобы награждать «ложится на ремёсла».
 * Мелкие дыры — в repair, не в отсев.
 */
export async function pickFreeformVariant({
  runtime,
  domainId,
  kind,
  variants,
  caseText,
  extraSystem = '',
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.judge', kind });
  const n = variants.length;
  if (!n) return { pick: 0, why: 'нет вариантов', repair: '', issues: [], verdict: null, prompt: '' };
  const draft = { data: null };
  const runOpts = {
    agentId: 'freeformJudge',
    tools: [
      {
        name: 'submit_freeform_pick',
        description: 'Выбери лучший вариант. Нумерация с 1.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['pick', 'why'],
          properties: {
            pick: { type: 'integer', description: `Номер варианта от 1 до ${n}.` },
            why: { type: 'string', description: 'Почему этот вариант интереснее остальных.' },
            repair: {
              type: 'string',
              description: 'Что починить в победителе. Пусто, если чинить нечего.',
            },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                required: ['code', 'reason'],
                properties: {
                  index: { type: 'integer' },
                  code: { type: 'string', enum: FREEFORM_JUDGE_CODES },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        handler: async (args) => {
          draft.data = parseFreeformPick(args, n);
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_pick' } },
    log,
    scene: `freeform_judge_${kind}`,
    domainId,
    extraSystem,
    userMessages: [
      {
        role: 'user',
        content: [
          caseText,
          '',
          formatFreeformVariants(variants),
          '',
          `Вариантов: ${n}. Вызови submit_freeform_pick. pick — номер лучшего.`,
          'Главное — интерес: какой сюжет хочется читать дальше.',
          'Отсей то, чего вообще не бывает: космология или установленный лор города.',
          'Выдуманный чужой остров и делегация, которая сейчас прибыла с него — отсев, не плюс.',
          'Если по А судят о Б без шарнира (почему А следует из Б) — штраф или отсев.',
          'То, насколько история «ложится» на ремёсла и должности, не достоинство.',
          'Мелкие огрехи победителя — в repair. Не отбрасывай единственный живой вариант из-за шероховатости.',
        ].join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);

  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.judge_failed', { error: err.message });
  }

  const verdict = draft.data || { pick: 1, why: 'судья молчал, взят первый', repair: '', issues: [] };
  const index = Math.max(0, Math.min(n - 1, verdict.pick - 1));
  log.info('freeform.judge', { pick: index + 1, why: verdict.why, repair: Boolean(verdict.repair) });
  return { ...verdict, index, prompt };
}

export const FREEFORM_PACK_JUDGE_CODES = [
  'GRAVITY',
  'COSMOLOGY',
  'HINGE',
  'CAUSALITY',
  'MOTION',
  'DRAMA',
  'TEMPO',
  'ECONOMY',
  'CHEKHOV',
  'CHRONICLE',
  'AXIS',
  'PATRON',
  'CONFLUX',
  'SAME_STORY',
  'HIDDEN',
  'ENDING',
  'MYSTERY',
  'MYSTERY_PLAUSIBLE',
  'OTHER',
];

export const FREEFORM_MYSTERY_PACK_CODES = ['MYSTERY', 'MYSTERY_PLAUSIBLE'];

export function freeformPackJudgeCodes({ requireMystery = false } = {}) {
  if (requireMystery) return [...FREEFORM_PACK_JUDGE_CODES];
  return FREEFORM_PACK_JUDGE_CODES.filter((c) => !FREEFORM_MYSTERY_PACK_CODES.includes(c));
}

function asPackCode(raw) {
  const c = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return FREEFORM_PACK_JUDGE_CODES.includes(c) ? c : 'OTHER';
}

function asPackVerdict(raw) {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  if (v === 'FAIL' || v === 'UNCERTAIN') return v;
  return 'PASS';
}

export function parseFreeformPackReview(raw, variantCount, allowedIndices = null) {
  const allowed = (Array.isArray(allowedIndices) && allowedIndices.length
    ? allowedIndices
    : Array.from({ length: Math.max(0, Math.round(Number(variantCount) || 0)) }, (_, i) => i + 1)
  )
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isInteger(n) && n >= 1);
  const allowedSet = new Set(allowed);
  const list = Array.isArray(raw?.reviews) ? raw.reviews : [];
  const byIndex = new Map();
  for (const item of list) {
    let index = Math.round(Number(item?.index));
    if (!allowedSet.has(index)) {
      index = allowed.find((i) => !byIndex.has(i));
      if (index == null) continue;
    }
    if (byIndex.has(index)) continue;
    const issues = [];
    for (const issue of item?.issues || []) {
      const reason = clipPlotText(issue?.reason, 400);
      if (!reason) continue;
      issues.push({ code: asPackCode(issue?.code), reason });
    }
    byIndex.set(index, {
      index,
      verdict: asPackVerdict(item?.verdict),
      summary: clipPlotText(item?.summary, 400),
      issues,
      repair: clipPlotText(item?.repair, 800),
    });
  }
  return allowed.map(
    (index) =>
      byIndex.get(index) || {
        index,
        verdict: 'PASS',
        summary: '',
        issues: [],
        repair: '',
      },
  );
}

export function reviewNeedsRepair(review) {
  return Boolean(String(review?.repair || '').trim());
}

export function isPackPass(review) {
  return String(review?.verdict || '').toUpperCase() === 'PASS';
}

/** PASS не переписываем, даже если судья приложил совет. */
export function reviewNeedsRewrite(review) {
  return !isPackPass(review) && reviewNeedsRepair(review);
}

export function scatterPackReviews(slotCount, reviews) {
  const out = Array.from({ length: slotCount }, () => null);
  for (const review of reviews || []) {
    const i = Number(review?.index) - 1;
    if (i >= 0 && i < slotCount) out[i] = review;
  }
  return out;
}

export async function reviewFreeformPack({
  runtime,
  agentId = 'freeformBeatJudge',
  candidates,
  caseText,
  extraSystem = '',
  log: parentLog,
  scene = 'freeform_pack_judge',
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.pack_judge', agentId });
  const n = candidates?.length || 0;
  const indices = (candidates || []).map((c, i) => Number(c.index) || i + 1);
  if (!n) return { reviews: [], prompt: '' };
  const draft = { reviews: null };
  const indexHint = indices.join(', ');
  const runOpts = {
    agentId,
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
                        code: { type: 'string', enum: freeformPackJudgeCodes() },
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
    scene,
    extraSystem,
    userMessages: [
      {
        role: 'user',
        content: String(caseText || ''),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.pack_judge_failed', { error: err.message });
  }
  const reviews = draft.reviews || parseFreeformPackReview({}, n, indices);
  log.info('freeform.pack_judge', {
    agentId,
    verdicts: reviews.map((r) => r.verdict),
    repairs: reviews.filter(reviewNeedsRewrite).length,
  });
  return { reviews, prompt };
}

export const FREEFORM_CARD_JUDGE_CODES = [
  'HINGE',
  'PLAUSIBLE_ENOUGH',
  'WHY_MOVES',
  'CLOSE_WHEN',
  'PREMISE_DRIFT',
  'GRAVITY_FIDELITY',
  'WORLD_FIDELITY',
  'HIDDEN_INVENTED',
  'OTHER',
];

export function formatFreeformCardJudgeCase({
  seedText,
  blank,
  card,
  gravity,
  config,
} = {}) {
  const close = Array.isArray(card?.closeWhen) ? card.closeWhen : [];
  const hidden = Array.isArray(card?.hiddenPremises) ? card.hiddenPremises : [];
  const architect = formatFreeformSeedBlank(blank);
  return [
    'ПАКЕТ НА ПРОВЕРКУ СОБРАННОЙ КАРТОЧКИ.',
    'Сюжет уже выбран. Конструктор посадил поля архитектора в город. Не пиши новый сюжет.',
    '',
    'Затравка игрока:',
    seedText || '—',
    '',
    architect ? `Поля архитектора:\n${architect}` : null,
    blank?.arena ? `arena: ${blank.arena}` : null,
    blank?.worldRelation ? `worldRelation: ${blank.worldRelation}` : null,
    Number.isFinite(Number(gravity)) || String(gravity || '').trim()
      ? formatFreeformGravityForPrompt(gravity, config)
      : null,
    '',
    `title: ${card?.title || '—'}`,
    `synopsis: ${card?.synopsis || '—'}`,
    card?.entry ? `entry: ${card.entry}` : null,
    `whyMoves: ${card?.whyMoves || '—'}`,
    close.length ? `closeWhen:\n${close.map((x) => `- ${x}`).join('\n')}` : 'closeWhen: (нет)',
    hidden.length
      ? `hiddenPremises:\n${hidden.map((h) => `- ${h}`).join('\n')}`
      : 'hiddenPremises: []',
  ]
    .filter((line) => line != null)
    .join('\n');
}

export function formatFreeformCardJudgeRepair(verdict) {
  if (!verdict || String(verdict.verdict || '').toUpperCase() !== 'FAIL') return '';
  const lines = [];
  if (verdict.summary) lines.push(verdict.summary);
  for (const issue of verdict.issues || []) {
    const loc = issue.location ? ` ${issue.location}` : '';
    lines.push(`[${issue.code}]${loc} — ${issue.reason}`);
  }
  return lines.join('\n').trim();
}

/**
 * Судья собранной карточки: PASS/FAIL как у suspenseAnnotationJudge.
 * FAIL — одна доработка конструктора. UNCERTAIN не гоняет на починку.
 */
export async function judgeFreeformCard({
  runtime,
  domainId,
  extraSystem = '',
  seedText,
  blank,
  card,
  gravity,
  config,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.card_judge' });
  const verdict = await runVerdictJudge({
    runtime,
    agentId: 'freeformCardJudge',
    caseText: formatFreeformCardJudgeCase({ seedText, blank, card, gravity, config }),
    extraSystem,
    extraUser:
      'Проверка собранной карточки, не выбор из пачки. PASS если шарнир на месте, whyMoves — путь к посадке из динамики, closeWhen различны и хотя бы один держит масштаб последствий, карточка — тот же сюжет, gravity совпадает с посадкой (синопсис может быть меньше), космология цела, hiddenPremises не выдуманы. Иначе FAIL одним из HINGE / PLAUSIBLE_ENOUGH / WHY_MOVES / CLOSE_WHEN / PREMISE_DRIFT / GRAVITY_FIDELITY / WORLD_FIDELITY / HIDDEN_INVENTED. UNCERTAIN пайплайн принимает. Историю не чини.',
    log,
    domainId,
    codes: FREEFORM_CARD_JUDGE_CODES,
    scene: 'freeform_card_judge',
    scope: 'freeform.card_judge',
    toolName: 'submit_freeform_card_verdict',
    toolDescription: 'Вердикт по собранной карточке. Историю не чини и не переписывай.',
    locationDescription: 'Поле карточки: synopsis, whyMoves, closeWhen, hiddenPremises, шарнир.',
  });
  const accepted = literaryJudgeAccepts(verdict.verdict);
  log.info('freeform.card_judge', {
    verdict: verdict.verdict,
    accepted,
    issues: verdict.issues,
    summary: verdict.summary,
  });
  return { accepted, judge: verdict };
}

function beatRepairTool(draft) {
  return {
    name: 'submit_freeform_repair',
    description: 'Исправленный абзац продолжения.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Один абзац: что произошло дальше.' },
      },
    },
    handler: async (args) => {
      const text = String(args?.text || '').trim();
      if (!text) return toolFail('empty', 'Верни исправленный абзац.');
      draft.data = { text };
      return { ok: true };
    },
  };
}

function seedRepairTool(draft) {
  return {
    name: 'submit_freeform_repair',
    description: 'Исправленный победивший вариант. Поля те же, что у исходного варианта.',
    parameters: {
      type: 'object',
      additionalProperties: true,
      required: [],
      properties: {
        title: { type: 'string' },
        hook: { type: 'string' },
        conflict: { type: 'string' },
        dynamics: { type: 'string' },
        consequences: { type: 'string' },
        text: { type: 'string' },
        premise: { type: 'string' },
        stakes: { type: 'string' },
        synopsis: { type: 'string' },
        entry: { type: 'string' },
        chronicle: { type: 'string' },
      },
    },
    handler: async (args) => {
      if (!args || typeof args !== 'object') return toolFail('empty', 'Верни исправленный вариант.');
      draft.data = args;
      return { ok: true };
    },
  };
}

export async function repairFreeformVariant({
  runtime,
  agentId,
  variant,
  repair,
  extraSystem,
  kind,
  log: parentLog,
}) {
  if (!repair) return { variant, prompt: '' };
  const log = (parentLog || getLogger()).child({ scope: 'freeform.repair' });
  const draft = { data: null };
  const beat = kind === 'beat';
  const runOpts = {
    agentId,
    tools: [beat ? beatRepairTool(draft) : seedRepairTool(draft)],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_repair' } },
    log,
    scene: 'freeform_repair',
    extraSystem,
    userMessages: [
      {
        role: 'user',
        content: beat
          ? [
              'Доработка выбранного продолжения. Скрытое в абзац не пиши.',
              `Замечания:\n${repair}`,
              '',
              'Исходный абзац:',
              String(variant?.text || variant?.whatHappens || '').trim(),
              '',
              'Верни один исправленный абзац.',
            ].join('\n')
          : [
              'ДОРАБОТКА выбранного варианта. Не меняй скрытый лор без нужды. Не пиши hiddenPremises в хронику.',
              `Замечания судьи:\n${repair}`,
              '',
              'Исходный вариант:',
              JSON.stringify(variant, null, 2),
              '',
              'Вызови submit_freeform_repair с полным исправленным вариантом.',
            ].join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.repair_failed', { error: err.message });
    return { variant, prompt };
  }
  if (!draft.data) return { variant, prompt };
  return { variant: { ...variant, ...draft.data }, prompt };
}
