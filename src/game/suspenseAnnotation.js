/**
 * Suspense brief: ситуация уже идёт, угроза в будущем, город ещё может повлиять.
 * Depth / лестница — у конструктора, не у болванки.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { runVerdictJudge } from './mysteryJudge.js';
import {
  plotConfig,
  pickSuspenseAnnotationSeed,
  formatSuspenseAnnotationAxesForPrompt,
  annotationGravityBand,
} from './plotlines.js';
import { ANNOTATION_TITLE_MAX, BRIEF_SECTION_MIN, countAnnotationSentences } from './mysteryAnnotation.js';

/** Mystery остаётся на 4 предложениях; саспенсу нужен запас на эскалацию и точку невозврата. */
export const SUSPENSE_BRIEF_SECTION_MAX = 1400;
export const SUSPENSE_BRIEF_SECTION_SENTENCE_MAX = 6;
export const SUSPENSE_BRIEF_TEXT_MAX = 6000;

export const SUSPENSE_BRIEF_SECTIONS = [
  { key: 'situation', label: 'Сейчас' },
  { key: 'threat', label: 'Угроза' },
  { key: 'whyNotSolvedNow', label: 'Почему не закрыть сразу' },
  { key: 'escalation', label: 'Эскалация' },
  { key: 'pointOfNoReturn', label: 'Точка невозврата' },
  { key: 'ifPrevented', label: 'Если предотвратить' },
  { key: 'ifNotPrevented', label: 'Если не предотвратить' },
];

export const SUSPENSE_ANNOTATION_JUDGE_CODES = [
  'CLEAR_THREAT',
  'CREDIBLE_PRESSURE',
  'NO_EASY_EXIT',
  'ESCALATION',
  'SUSPENSE_NOT_MYSTERY',
  'MEANINGFUL_AGENCY',
  'PLAUSIBLE_ENOUGH',
  'ARENA_FIDELITY',
  'GRAVITY_FIDELITY',
  'WORLD_FIDELITY',
  'OTHER',
];

function clip(s, max) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

export function formatSuspenseBriefText(parts = {}) {
  return SUSPENSE_BRIEF_SECTIONS.map(({ key, label }) => `${label}:\n${String(parts[key] || '').trim()}`).join(
    '\n\n',
  );
}

const BRIEF_HEADER_RE =
  /^(Сейчас|Текущая ситуация|Угроза|Почему не закрыть сразу|Почему не решить сразу|Эскалация|Точка невозврата|Если предотвратить|Если не предотвратить)\s*:?\s*$/i;

function parseSuspenseBriefBlob(raw) {
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
    сейчас: 'situation',
    'текущая ситуация': 'situation',
    угроза: 'threat',
    'почему не закрыть сразу': 'whyNotSolvedNow',
    'почему не решить сразу': 'whyNotSolvedNow',
    эскалация: 'escalation',
    'точка невозврата': 'pointOfNoReturn',
    'если предотвратить': 'ifPrevented',
    'если не предотвратить': 'ifNotPrevented',
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
  if (!SUSPENSE_BRIEF_SECTIONS.every(({ key }) => out[key])) return null;
  return out;
}

function readBriefParts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const aliases = {
    situation: raw.situation || raw.currentSituation,
    threat: raw.threat,
    whyNotSolvedNow: raw.whyNotSolvedNow || raw.whyNotSolvedImmediately,
    escalation: raw.escalation,
    pointOfNoReturn: raw.pointOfNoReturn,
    ifPrevented: raw.ifPrevented,
    ifNotPrevented: raw.ifNotPrevented,
  };
  const fromFields = {};
  for (const { key } of SUSPENSE_BRIEF_SECTIONS) {
    const v = String(aliases[key] || '').trim();
    if (v) fromFields[key] = v;
  }
  if (SUSPENSE_BRIEF_SECTIONS.every(({ key }) => fromFields[key])) return fromFields;
  return parseSuspenseBriefBlob(raw.annotation || raw.text || raw.prose || raw.brief);
}

export function normalizeSuspenseAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return { annotation: null, reason: 'no_seed' };
  const hasAny = [
    raw.workingTitle,
    raw.title,
    raw.situation,
    raw.currentSituation,
    raw.threat,
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
  for (const { key } of SUSPENSE_BRIEF_SECTIONS) {
    const text = clip(parts[key], SUSPENSE_BRIEF_SECTION_MAX);
    if (!text || text.length < BRIEF_SECTION_MIN) {
      return { annotation: null, reason: `thin_section:${key}` };
    }
    const sentences = countAnnotationSentences(text);
    if (sentences < 1) return { annotation: null, reason: `thin_sentences:${key}` };
    if (sentences > SUSPENSE_BRIEF_SECTION_SENTENCE_MAX) {
      return { annotation: null, reason: `long_sentences:${key}` };
    }
    cleaned[key] = text;
  }
  const text = formatSuspenseBriefText(cleaned);
  if (text.length > SUSPENSE_BRIEF_TEXT_MAX) return { annotation: null, reason: 'long_brief' };
  return {
    annotation: {
      workingTitle: workingTitle || 'без названия',
      ...cleaned,
      text,
    },
    reason: null,
  };
}

export function classifySuspenseAnnotationSkip({ data, run, error } = {}) {
  if (data) return null;
  if (error) return 'GENERATOR_ERROR';
  const last = [...(run?.toolTrace || [])]
    .reverse()
    .find((t) => t.name === 'submit_suspense_annotation');
  const err = last?.result?.error;
  if (err === 'invalid_json_args') return 'SCHEMA_INVALID';
  if (err) return `PRECHECK_FAIL:${err}`;
  if (run?.truncated) return 'TRUNCATED';
  return 'NO_OUTPUT';
}

function tagLine(tags, groupId) {
  const t = (tags || []).find((x) => x.groupId === groupId || (groupId === 'threatArena' && x.groupId === 'truthArena'));
  if (!t) return '—';
  return t.about ? `${t.tagName} — ${t.about}` : t.tagName;
}

export function formatSuspenseAnnotationJudgeCase({ seed = {}, annotation = null } = {}) {
  const tags = seed.tags || [];
  return [
    'ПАКЕТ НА ПРОВЕРКУ (suspense brief; города нет).',
    'Это бриф угрозы, не граф и не завязка города. Не ищи hiddenPremises и лестницу.',
    Number.isFinite(Number(seed.gravity))
      ? `GRAVITY: ${seed.gravity} (${annotationGravityBand(seed.gravity)}) — вес развилки для города. Полосу несёт «если не предотвратить»; успех может быть civic-memory.`
      : null,
    Number(seed.gravity) >= 80
      ? 'GRAVITY 80+: сама угроза экзистенциальна (разрушение города, массовая гибель, слом веры/порядка). Нормирование на год — не эта полоса. Успех не обязан тянуть полосу.'
      : null,
    `АРЕНА УГРОЗЫ: ${tagLine(tags, 'threatArena')}`,
    `ПРОЯВЛЕНИЕ: ${tagLine(tags, 'manifestation')}`,
    `ОТНОШЕНИЕ К МИРУ: ${tagLine(tags, 'worldRelation')}`,
    '',
    formatSuspenseAnnotationAxesForPrompt(seed),
    '',
    annotation?.workingTitle ? `workingTitle: ${annotation.workingTitle}` : null,
    'brief:',
    annotation?.text || '(пусто)',
  ]
    .filter((line) => line != null)
    .join('\n');
}

export async function judgeSuspenseAnnotation({ runtime, caseText, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'suspense.annotation.judge' });
  const verdict = await runVerdictJudge({
    runtime,
    agentId: 'suspenseAnnotationJudge',
    caseText,
    extraUser:
      'Лёгкая проверка suspense brief, не завязки города. PASS если ясно «если ничего не сделать, будет Y», давление следует из ситуации, нет дешёвого выхода с конкретной ценой, бездействие ухудшает, это не mystery, у города есть агентность, нет plot-shaped и дыр в цепочке, угроза в заявленной threatArena, космология Cloudshire цела, «если не предотвратить» соответствует gravity. При 80+ сама угроза экзистенциальна; успех может быть праздником/монументом после отведённой беды. Если механизм не тянет масштаб — PLAUSIBLE_ENOUGH, не «урежь концовку». Суда, порты, регулярный импорт — WORLD_FIDELITY; CONTACT через ветер/споры/существо/падение/сопряжение — можно. Иначе FAIL одним из CLEAR_THREAT / CREDIBLE_PRESSURE / NO_EASY_EXIT / ESCALATION / SUSPENSE_NOT_MYSTERY / MEANINGFUL_AGENCY / PLAUSIBLE_ENOUGH / ARENA_FIDELITY / GRAVITY_FIDELITY / WORLD_FIDELITY. UNCERTAIN пайплайн не принимает.',
    log,
    codes: SUSPENSE_ANNOTATION_JUDGE_CODES,
    scene: 'suspense_annotation_judge',
    scope: 'suspense.annotation.judge',
    toolName: 'submit_suspense_annotation_verdict',
    toolDescription: 'Лёгкий вердикт по suspense brief. Историю не чини. Это не граф и не depth.',
    locationDescription:
      'Фрагмент брифа: ситуация, угроза, почему не сразу, эскалация, точка невозврата, если предотвратить / если нет.',
  });
  const accepted = verdict.verdict === 'PASS';
  log.info('suspense.annotation.judge', {
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
  situation: {
    type: 'string',
    description: 'Сейчас: 2–6 конкретных предложений о том, что уже происходит.',
  },
  threat: {
    type: 'string',
    description: 'Угроза: 2–6 предложений о Y, к которому ситуация естественно придёт, если ничего не менять.',
  },
  whyNotSolvedNow: {
    type: 'string',
    description:
      'Почему не закрыть сразу: 1–6 предложений. Конкретная цена или ограничение. «Люди будут недовольны» само по себе недостаточно.',
  },
  escalation: {
    type: 'string',
    description: 'Эскалация: 1–6 предложений. Как бездействие меняет ситуацию в ближайшие недели или месяцы.',
  },
  pointOfNoReturn: {
    type: 'string',
    description:
      'Точка невозврата: 1–6 предложений. Исчез лучший вариант, цена скакнула, часть потерь неизбежна или кризис перешёл в новую фазу. Не обязана означать, что спасать уже бессмысленно.',
  },
  ifPrevented: {
    type: 'string',
    description:
      'Если предотвратить: конкретный хороший исход. Не обязан тянуть gravity. Дефолт — отвели беду: праздник, молитвы, монумент, общий подъём. Не новое ведомство, протокол или инспекция.',
  },
  ifNotPrevented: {
    type: 'string',
    description:
      'Если не предотвратить: конкретный плохой исход, он несёт полосу gravity. При 80+ — разрушение города, массовая гибель, слом веры или порядка.',
  },
};

async function askSuspenseAnnotation({
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
      name: 'submit_suspense_annotation',
      description:
        'Suspense brief: сейчас, угроза, почему не сразу, эскалация, точка невозврата, два исхода. Без графа, без depth, без списка тегов.',
      parameters: {
        type: 'object',
        required: [
          'workingTitle',
          'situation',
          'threat',
          'whyNotSolvedNow',
          'escalation',
          'pointOfNoReturn',
          'ifPrevented',
          'ifNotPrevented',
        ],
        properties: BRIEF_TOOL_PROPERTIES,
      },
      handler: async (args) => {
        const { annotation, reason } = normalizeSuspenseAnnotation(args);
        if (reason) {
          draft.fail = reason;
          return toolFail(
            reason,
            'Нужен бриф: ситуация уже идёт, будущая угроза, почему не закрыть сразу, эскалация, точка невозврата, конкретные исходы.',
          );
        }
        draft.data = annotation;
        return { ok: true };
      },
    },
  ];

  const run = await runtime.run({
    agentId: 'suspenseAnnotation',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_suspense_annotation' } },
    log,
    scene: revision ? 'suspense_annotation_revise' : 'suspense_annotation',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          revision
            ? 'Исправь brief по замечаниям судьи. Тот же жребий. Вызови submit_suspense_annotation.'
            : 'Запиши одну suspense как короткий brief.',
          'Не перечисляй теги. Не строй граф. Не ставь depth и лестницу раскрытия.',
          'Нужны секции: Сейчас, Угроза, Почему не закрыть сразу, Эскалация, Точка невозврата, Если предотвратить, Если не предотвратить.',
          'workingTitle называет то же проявление, что секция Сейчас, не обломок другого черновика.',
          'Главный вопрос — будущее. Если убрать расследование причины, напряжение должно остаться.',
          revision
            ? 'Почини указанный дефект. Не пиши другую историю с нуля, если можно исправить эту. Не переноси угрозу в другую arena. PLAUSIBLE_ENOUGH не чини сменой arena.'
            : 'Сначала gravity: придумай угрозу, способную породить последствия такого масштаба, затем нынешнюю ситуацию.',
          revision ? null : 'Вызови submit_suspense_annotation.',
          '',
          formatSuspenseAnnotationAxesForPrompt(seed, { recent, recentWindow }),
          revision ? '' : null,
          revision ? formatSuspenseAnnotationRevisionForPrompt({ ...revision, gravity: seed?.gravity }) : null,
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
    skip: classifySuspenseAnnotationSkip({ data: draft.data, run }),
  };
}

export function formatSuspenseAnnotationRevisionForPrompt({ annotation = null, judge = null, gravity = null } = {}) {
  const g = Number(gravity);
  const lines = [
    'ДОРАБОТКА. Предыдущий brief не принят. Исправь указанные ошибки.',
    'Это не новая генерация. Тот же жребий.',
    'Неизменяемые: threatArena, worldRelation, manifestation, полоса gravity, тон, основная наблюдаемая ситуация.',
    'Можно менять: точный механизм, конкретный Y, препятствие, эскалацию, точку невозврата, исходы.',
    'Нельзя чинить PLAUSIBLE_ENOUGH переносом центральной причины в другую arena. Упрости механизм, не добавляй вторую угрозу.',
    'Не вводи воздушные суда, регулярный импорт, постоянную внешнюю торговлю, новую физику полёта острова.',
  ];
  if (Number.isFinite(g) && g >= 80) {
    lines.push(
      'GRAVITY 80+: не урезай конец до нормирования. Увеличь естественный leverage самой угрозы, не раздувай хвост словами «навсегда».',
    );
  } else if (Number.isFinite(g) && g < 50) {
    lines.push('GRAVITY ниже 50: можно урезать последствия до полосы, не раздувай «на поколения».');
  } else {
    lines.push('GRAVITY_FIDELITY: не раздувай «навсегда» и «на поколения», если причинность этого не заработала.');
  }
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

export async function seedSuspenseAnnotation({
  config,
  runtime,
  log: parentLog,
  seed: seedArg = null,
  rng = Math.random,
  recent = [],
} = {}) {
  const cfg = plotConfig(config);
  const recentWindow = cfg.suspenseAnnotation?.recentWindow || 5;
  const seed = seedArg || pickSuspenseAnnotationSeed(cfg, rng, { recent });
  const max = cfg.suspenseAnnotation?.judgeAttempts || 2;
  const log = (parentLog || getLogger()).child({ scope: 'suspense.annotation' });
  const attempts = [];
  let revision = null;

  for (let genTry = 0; genTry < max; genTry += 1) {
    let asked = null;
    try {
      asked = await askSuspenseAnnotation({
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
        skip: classifySuspenseAnnotationSkip({ error: err }),
        accepted: false,
        judge: null,
        revise: Boolean(revision),
      });
      log.warn('suspense.annotation.failed', { genTry, error: err.message });
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
    const caseText = formatSuspenseAnnotationJudgeCase({ seed, annotation });
    const judged = await judgeSuspenseAnnotation({ runtime, caseText, log });
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

export function formatSuspenseAnnotationCard(annotation) {
  if (!annotation) return '(пусто)';
  const title = annotation.workingTitle ? `«${annotation.workingTitle}»` : null;
  return [title, annotation.text].filter(Boolean).join('\n\n');
}
