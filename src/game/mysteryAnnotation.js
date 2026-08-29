/**
 * Mystery brief V5: причина + исторический вес + ветки исхода.
 * recent — только доска города. Лабораторный семпл — независимые пустые посевы.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { runVerdictJudge } from './mysteryJudge.js';
import {
  plotConfig,
  pickMysteryAnnotationSeed,
  formatMysteryAnnotationAxesForPrompt,
  annotationGravityBand,
  annotationOmitsTruthNature,
  ANNOTATION_NATURE_OFF_SYSTEM,
} from './plotlines.js';

export const ANNOTATION_TITLE_MAX = 80;
export const BRIEF_SECTION_MIN = 40;
export const BRIEF_SECTION_MAX = 900;
export const BRIEF_SECTION_SENTENCE_MAX = 4;
export const BRIEF_TEXT_MAX = 4500;

export const BRIEF_SECTIONS = [
  { key: 'observed', label: 'Наблюдаемое' },
  { key: 'truth', label: 'Истина' },
  { key: 'hiddenness', label: 'Почему не очевидно' },
  { key: 'ifSolved', label: 'Если разгадана' },
  { key: 'ifUnsolved', label: 'Если не разгадана' },
];

export const ANNOTATION_JUDGE_CODES = [
  'COHERENT_REVEAL',
  'PLAUSIBLE_ENOUGH',
  'CREDIBLE_HIDDENNESS',
  'ONE_REVEAL',
  'TRUTH_ARENA_FIDELITY',
  'GRAVITY_FIDELITY',
  'OTHER',
];

function clip(s, max) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

/** Грубый счёт предложений: конец по . ! ? … */
export function countAnnotationSentences(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  const chunks = t
    .replace(/([.!?…]+)(["»”')\]]*)(\s+|$)/g, '$1$2\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks.length;
}

export function formatMysteryBriefText(parts = {}) {
  return BRIEF_SECTIONS.map(({ key, label }) => `${label}:\n${String(parts[key] || '').trim()}`).join(
    '\n\n',
  );
}

const BRIEF_HEADER_RE = /^(Наблюдаемое|Истина|Почему не очевидно|Если разгадана|Если не разгадана)\s*:?\s*$/i;

function parseMysteryBriefBlob(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  const lines = text.split('\n');
  const out = {};
  let current = null;
  const buf = [];
  const flush = () => {
    if (!current) return;
    out[current] = buf.join('\n').trim();
    buf.length = 0;
  };
  const map = {
    наблюдаемое: 'observed',
    истина: 'truth',
    'почему не очевидно': 'hiddenness',
    'если разгадана': 'ifSolved',
    'если не разгадана': 'ifUnsolved',
  };
  for (const line of lines) {
    const m = line.trim().match(BRIEF_HEADER_RE);
    if (m) {
      flush();
      current = map[m[1].toLowerCase()];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  if (!BRIEF_SECTIONS.every(({ key }) => out[key])) return null;
  return out;
}

function readBriefParts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fromFields = {};
  for (const { key } of BRIEF_SECTIONS) {
    const v = String(raw[key] || '').trim();
    if (v) fromFields[key] = v;
  }
  if (BRIEF_SECTIONS.every(({ key }) => fromFields[key])) return fromFields;
  return parseMysteryBriefBlob(raw.annotation || raw.text || raw.prose || raw.brief);
}

export function normalizeMysteryAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return { annotation: null, reason: 'no_seed' };
  const hasAny = [
    raw.workingTitle,
    raw.title,
    raw.observed,
    raw.truth,
    raw.hiddenness,
    raw.ifSolved,
    raw.ifUnsolved,
    raw.annotation,
    raw.text,
    raw.prose,
    raw.brief,
  ].some((v) => String(v || '').trim());
  if (!hasAny) return { annotation: null, reason: 'no_seed' };
  const workingTitle = clip(raw.workingTitle || raw.title, ANNOTATION_TITLE_MAX);
  const parts = readBriefParts(raw);
  if (!parts) return { annotation: null, reason: 'thin_brief' };
  const cleaned = {};
  for (const { key } of BRIEF_SECTIONS) {
    const text = clip(parts[key], BRIEF_SECTION_MAX);
    if (!text || text.length < BRIEF_SECTION_MIN) {
      return { annotation: null, reason: `thin_section:${key}` };
    }
    const sentences = countAnnotationSentences(text);
    if (sentences < 1) return { annotation: null, reason: `thin_sentences:${key}` };
    if (sentences > BRIEF_SECTION_SENTENCE_MAX) {
      return { annotation: null, reason: `long_sentences:${key}` };
    }
    cleaned[key] = text;
  }
  const text = formatMysteryBriefText(cleaned);
  if (text.length > BRIEF_TEXT_MAX) return { annotation: null, reason: 'long_brief' };
  return {
    annotation: {
      workingTitle: workingTitle || 'без названия',
      ...cleaned,
      text,
    },
    reason: null,
  };
}

export function classifyAnnotationSkip({ data, run, error } = {}) {
  if (data) return null;
  if (error) return 'GENERATOR_ERROR';
  const last = [...(run?.toolTrace || [])]
    .reverse()
    .find((t) => t.name === 'submit_mystery_annotation');
  const err = last?.result?.error;
  if (err === 'invalid_json_args') return 'SCHEMA_INVALID';
  if (err) return `PRECHECK_FAIL:${err}`;
  if (run?.truncated) return 'TRUNCATED';
  return 'NO_OUTPUT';
}

function tagLine(tags, groupId) {
  const t = (tags || []).find((x) => x.groupId === groupId);
  if (!t) return '—';
  return t.about ? `${t.tagName} — ${t.about}` : t.tagName;
}

export function formatMysteryAnnotationJudgeCase({ seed = {}, annotation = null } = {}) {
  const tags = seed.tags || [];
  return [
    'ПАКЕТ НА ПРОВЕРКУ (mystery brief; города нет).',
    'Это бриф идеи, не граф. Не ищи цепь узлов и не требуй каждого ребра.',
    Number.isFinite(Number(seed.gravity))
      ? `GRAVITY: ${seed.gravity} (${annotationGravityBand(seed.gravity)}) — вес развилки для города, не размер X; не обязан быть долговременным legacy`
      : null,
    `АРЕНА ИСТИНЫ: ${tagLine(tags, 'truthArena')}`,
    annotationOmitsTruthNature(seed) ? null : `ПРИРОДА ИСТИНЫ: ${tagLine(tags, 'truthNature')}`,
    `ПРОЯВЛЕНИЕ: ${tagLine(tags, 'manifestation')}`,
    `ОТНОШЕНИЕ К МИРУ: ${tagLine(tags, 'worldRelation')}`,
    '',
    formatMysteryAnnotationAxesForPrompt(seed),
    '',
    annotation?.workingTitle ? `workingTitle: ${annotation.workingTitle}` : null,
    'brief:',
    annotation?.text || '(пусто)',
  ]
    .filter((line) => line != null)
    .join('\n');
}

export async function judgeMysteryAnnotation({ runtime, caseText, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'mystery.annotation.judge' });
  const verdict = await runVerdictJudge({
    runtime,
    agentId: 'mysteryAnnotationJudge',
    caseText,
    extraUser:
      'Лёгкая проверка брифа, не графа. PASS если можно сказать «X потому что Y», нет явной бессмыслицы, связь не обязана быть сразу очевидной, одно раскрытие, причинное ядро Y в заявленной truthArena, масштаб развилки соответствует gravity (широкая терпимость, FAIL только при явном mismatch полосы). Не FAIL за неполноту физики, ложь truthNature, отсутствие маски-тега, вкус или «слабо для city binding». Иначе FAIL одним из COHERENT_REVEAL / PLAUSIBLE_ENOUGH / CREDIBLE_HIDDENNESS / ONE_REVEAL / TRUTH_ARENA_FIDELITY / GRAVITY_FIDELITY. UNCERTAIN пайплайн не принимает.',
    log,
    codes: ANNOTATION_JUDGE_CODES,
    scene: 'mystery_annotation_judge',
    scope: 'mystery.annotation.judge',
    toolName: 'submit_mystery_annotation_verdict',
    toolDescription: 'Лёгкий вердикт по mystery brief. Историю не чини. Это не граф.',
    locationDescription:
      'Фрагмент брифа: наблюдаемое, истина, скрытость, если разгадана, если не разгадана, арена Y. Не узел и не ребро графа.',
  });
  const accepted = verdict.verdict === 'PASS';
  log.info('mystery.annotation.judge', {
    verdict: verdict.verdict,
    issues: verdict.issues,
    summary: verdict.summary,
    accepted,
  });
  return { accepted, judge: verdict };
}

const BRIEF_TOOL_PROPERTIES = {
  workingTitle: {
    type: 'string',
    description: 'Рабочее название, 1–6 слов, без имени города.',
  },
  observed: {
    type: 'string',
    description: 'Наблюдаемое: 2–4 конкретных предложения о том, что происходит и что требует объяснения.',
  },
  truth: {
    type: 'string',
    description: 'Истина: 2–4 конкретных предложения о центральной скрытой причине и механизме.',
  },
  hiddenness: {
    type: 'string',
    description: 'Почему не очевидно: 1–3 предложения, почему разумные жители не связывают X с Y сразу.',
  },
  ifSolved: {
    type: 'string',
    description:
      'Если разгадана: конкретное хорошее последствие соответствующего gravity, прямое развитие Y. Не новое правило, протокол или инспекция по умолчанию.',
  },
  ifUnsolved: {
    type: 'string',
    description:
      'Если не разгадана: конкретное плохое последствие соответствующего gravity, прямое развитие Y.',
  },
};

async function askMysteryAnnotation({
  runtime,
  seed,
  recent = [],
  recentWindow = 5,
  log,
  revision = null,
}) {
  const draft = { data: null, fail: null };
  const tools = [
    {
      name: 'submit_mystery_annotation',
      description:
        'Mystery brief: наблюдаемое, истина, скрытость, если разгадана, если не разгадана. Без графа и без списка тегов.',
      parameters: {
        type: 'object',
        required: ['workingTitle', 'observed', 'truth', 'hiddenness', 'ifSolved', 'ifUnsolved'],
        properties: BRIEF_TOOL_PROPERTIES,
      },
      handler: async (args) => {
        const { annotation, reason } = normalizeMysteryAnnotation(args);
        if (reason) {
          draft.fail = reason;
          return toolFail(
            reason,
            'Нужен бриф: наблюдаемое, одна разгадка, скрытость, конкретные исходы «если разгадана» и «если не разгадана». Не перечисляй теги.',
          );
        }
        draft.data = annotation;
        return { ok: true };
      },
    },
  ];

  const run = await runtime.run({
    agentId: 'mysteryAnnotation',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_mystery_annotation' } },
    log,
    scene: revision ? 'mystery_annotation_revise' : 'mystery_annotation',
    extraSystem: annotationOmitsTruthNature(seed) ? ANNOTATION_NATURE_OFF_SYSTEM : '',
    userMessages: [
      {
        role: 'user',
        content: [
          revision
            ? 'Исправь brief по замечаниям судьи. Тот же жребий. Вызови submit_mystery_annotation.'
            : 'Запиши одну mystery как короткий brief.',
          'Не перечисляй теги. Не строй causal graph. Не классифицируй mystery.',
          'Нужны секции: Наблюдаемое, Истина, Почему не очевидно, Если разгадана, Если не разгадана.',
          'Одна разгадка. Исходы — конкретный факт соответствующего gravity, не обязательный legacy и не «опасность устранена / стало хуже». Не новое правило или протокол по умолчанию.',
          revision
            ? 'Почини указанный дефект. Не пиши другую mystery с нуля, если можно исправить эту. Не добавляй вторую разгадку и не раздувай gravity.'
            : 'Сначала gravity: придумай Y, способную породить последствия такого масштаба, затем X.',
          revision ? null : 'Вызови submit_mystery_annotation.',
          '',
          formatMysteryAnnotationAxesForPrompt(seed, { recent, recentWindow }),
          revision ? '' : null,
          revision ? formatMysteryAnnotationRevisionForPrompt(revision) : null,
        ]
          .filter((line) => line != null)
          .join('\n'),
      },
    ],
  });

  if (draft.data) return { annotation: draft.data, skip: null };
  if (draft.fail) return { annotation: null, skip: `PRECHECK_FAIL:${draft.fail}` };
  return {
    annotation: null,
    skip: classifyAnnotationSkip({ data: draft.data, run }),
  };
}

export function formatMysteryAnnotationRevisionForPrompt({ annotation = null, judge = null } = {}) {
  const lines = [
    'ДОРАБОТКА. Предыдущий brief не принят. Исправь указанные ошибки.',
    'Тот же жребий. Не меняй центральную истину без нужды.',
  ];
  if (judge?.summary) lines.push(`Судья: ${judge.summary}`);
  for (const issue of judge?.issues || []) {
    const loc = issue.location ? ` @ ${issue.location}` : '';
    lines.push(`- [${issue.code || 'OTHER'}]${loc} — ${issue.reason || ''}`.trim());
  }
  if (annotation?.workingTitle || annotation?.text) {
    lines.push('', 'Предыдущий brief:');
    if (annotation.workingTitle) lines.push(`Название: ${annotation.workingTitle}`);
    if (annotation.text) lines.push(annotation.text);
  }
  return lines.join('\n');
}

/**
 * Один посев одной истории. recent — mystery этого города, не пачка семпла.
 * При FAIL судьи — одна доработка того же seed и brief, без нового жребия.
 */
export async function seedMysteryAnnotation({
  config,
  runtime,
  log: parentLog,
  seed: seedArg = null,
  rng = Math.random,
  recent = [],
  omitTruthNature = false,
} = {}) {
  const cfg = plotConfig(config);
  const recentWindow = cfg.mysteryAnnotation?.recentWindow || 5;
  const omit = Boolean(omitTruthNature || seedArg?.omitTruthNature);
  const seed = seedArg || pickMysteryAnnotationSeed(cfg, rng, { recent, omitTruthNature: omit });
  const max = cfg.mysteryAnnotation?.judgeAttempts || 2;
  const log = (parentLog || getLogger()).child({ scope: 'mystery.annotation' });
  const attempts = [];
  let revision = null;

  for (let genTry = 0; genTry < max; genTry += 1) {
    let asked = null;
    try {
      asked = await askMysteryAnnotation({
        runtime,
        seed,
        recent,
        recentWindow,
        log,
        revision,
      });
    } catch (err) {
      attempts.push({
        genTry,
        seed,
        skip: classifyAnnotationSkip({ error: err }),
        accepted: false,
        judge: null,
        revise: Boolean(revision),
      });
      log.warn('mystery.annotation.failed', { genTry, error: err.message });
      break;
    }
    const annotation = asked?.annotation || null;
    if (!annotation) {
      attempts.push({
        genTry,
        seed,
        skip: asked?.skip || 'NO_OUTPUT',
        accepted: false,
        judge: null,
        revise: Boolean(revision),
      });
      break;
    }
    const caseText = formatMysteryAnnotationJudgeCase({ seed, annotation });
    const judged = await judgeMysteryAnnotation({ runtime, caseText, log });
    const rec = {
      genTry,
      seed,
      skip: null,
      title: annotation.workingTitle,
      annotation,
      accepted: judged.accepted,
      judge: judged.judge,
      revise: Boolean(revision),
    };
    attempts.push(rec);
    if (judged.accepted) {
      return { ok: true, seed, annotation, judge: judged.judge, skip: null, attempts };
    }
    if (genTry + 1 >= max) break;
    revision = { annotation, judge: judged.judge };
  }

  const last = [...attempts].reverse().find((a) => a.annotation) || null;
  return {
    ok: false,
    seed,
    annotation: last?.annotation || null,
    judge: last?.judge || null,
    skip: last ? null : attempts[attempts.length - 1]?.skip || 'NO_OUTPUT',
    attempts,
  };
}

export function formatMysteryAnnotationCard(annotation) {
  if (!annotation) return '(пусто)';
  const title = annotation.workingTitle ? `«${annotation.workingTitle}»` : null;
  return [title, annotation.text].filter(Boolean).join('\n\n');
}
