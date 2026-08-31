/**
 * Каскад валидации CORE тайны: Luna — дешёвый rejector, иначе Terra — acceptor.
 * Judge не чинит историю, не видит лор города и не оценивает подачу.
 *
 * Литературный судья подачи (Luna): синопсис/хроника только из известных узлов,
 * хроника оставляет зацепку. FAIL не отсеивает core — возврат сторителлеру на доработку.
 */

import { getLogger } from '../log.js';
import { mysteryAssociationTag, mysteryTypeTag } from './plotlines.js';
import { formatTruthGraphForPrompt, mysteryGraphShapeHint } from './mysteryGraph.js';

export const MYSTERY_JUDGE_VERDICTS = ['PASS', 'FAIL', 'UNCERTAIN'];

export const MYSTERY_JUDGE_CODES = [
  'CANON_CONFLICT',
  'ANCHOR_MISUSE',
  'WRONG_MYSTERY_TYPE',
  'BROKEN_CAUSAL_EDGE',
  'TEMPORAL_CONTRADICTION',
  'UNEXPLAINED_KNOWLEDGE',
  'UNEXPLAINED_ENTITY',
  'UNEXPLAINED_ACTION',
  'IMPLAUSIBLE_ACTION',
  'UNSUPPORTED_PHYSICAL_EFFECT',
  'UNSUPPORTED_MAGIC',
  'UNSUPPORTED_MASS_BEHAVIOR',
  'MYSTERY_INCOMPLETE',
  'UNSUPPORTED_X',
  'MASK_LEAK',
  'DANGLING_REFERENT',
  'SYNOPSIS_ENTRY_INVENTION',
  'CLOSE_WHEN_INVENTION',
  'REDUNDANT_STRUCTURE',
  'OTHER',
];

export const MYSTERY_PRESENTATION_JUDGE_CODES = [
  'MASK_LEAK',
  'DANGLING_REFERENT',
  'SYNOPSIS_NOT_FROM_KNOWN',
  'ENTRY_NOT_FROM_KNOWN',
  'ENTRY_NO_HOOK',
  'CLOSE_WHEN_LEAK',
  'CLOSE_WHEN_COMPOUND',
  'MOOT_WHEN_MISSING',
  'MOOT_WHEN_DUP',
  'OTHER',
];

function clip(s, max) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

export function parseJudgeVerdict(raw, codes = MYSTERY_JUDGE_CODES) {
  const codeSet = new Set(codes);
  const asCode = (value) => {
    const c = String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
    return codeSet.has(c) ? c : 'OTHER';
  };
  const verdict = String(raw?.verdict || '').trim().toUpperCase();
  const summary = clip(raw?.summary, 400);
  const issues = [];
  for (const item of raw?.issues || []) {
    const reason = clip(item?.reason || item?.text, 400);
    if (!reason) continue;
    issues.push({
      code: asCode(item?.code),
      location: clip(item?.location, 80),
      reason,
    });
  }
  if (!MYSTERY_JUDGE_VERDICTS.includes(verdict)) {
    return {
      verdict: 'UNCERTAIN',
      issues,
      summary: summary || 'непонятный ответ валидатора',
    };
  }
  if (verdict === 'PASS') return { verdict, issues: [], summary };
  if (verdict === 'FAIL' && !issues.length) {
    return {
      verdict: 'FAIL',
      issues: [{ code: 'OTHER', location: '', reason: summary || 'FAIL без конкретной ошибки' }],
      summary,
    };
  }
  return { verdict, issues, summary };
}

export function parseMysteryJudgeVerdict(raw) {
  return parseJudgeVerdict(raw, MYSTERY_JUDGE_CODES);
}

/** Литературный Luna: только FAIL гоняет на доработку. PASS и UNCERTAIN принимают. */
export function literaryJudgeAccepts(verdict) {
  return String(verdict || '').toUpperCase() !== 'FAIL';
}

export function formatJudgeRevisionForPrompt(revision) {
  if (!revision) return null;
  const prev = revision.previous || {};
  const lines = [
    'ДОРАБОТКА. Предыдущий текст не принят. Исправь указанные ошибки.',
    'Не меняй уже принятый core / режиссуру. Новых фактов не выдумывай.',
  ];
  if (revision.mechanical) lines.push(`Технический отсев: ${revision.mechanical}`);
  if (revision.judge?.summary) lines.push(`Судья: ${revision.judge.summary}`);
  for (const issue of revision.judge?.issues || []) {
    const loc = issue.location ? ` ${issue.location}` : '';
    lines.push(`- [${issue.code}]${loc} — ${issue.reason}`);
  }
  const dump = [
    prev.title ? `title: ${prev.title}` : null,
    prev.synopsis ? `synopsis: ${prev.synopsis}` : null,
    prev.entry ? `entry: ${prev.entry}` : null,
    prev.closeWhen ? `closeWhen: ${prev.closeWhen}` : null,
    prev.mootWhen != null && prev.mootWhen !== undefined
      ? `mootWhen: ${String(prev.mootWhen).trim() || '(пусто)'}`
      : null,
    Array.isArray(prev.hiddenPremises) && prev.hiddenPremises.length
      ? `hiddenPremises:\n${prev.hiddenPremises.map((h) => `- ${h}`).join('\n')}`
      : null,
  ].filter(Boolean);
  if (dump.length) {
    lines.push('', 'Предыдущий текст:');
    lines.push(...dump);
  }
  return lines.join('\n');
}

function formatAnchors(anchors = []) {
  const list = (anchors || []).filter(Boolean);
  if (!list.length) return '- (якорей не выдавали)';
  return list
    .map((a) => {
      if (a.invent) return `- изобретённый якорь вида «${a.kind || 'custom'}»`;
      return `- ${a.kind || 'сущность'} «${a.name || '?'}»: ${a.about || ''}`.trim();
    })
    .join('\n');
}

function formatCharacters(list = []) {
  const rows = (list || []).filter((c) => c?.name);
  if (!rows.length) return '- (новых карточек нет)';
  return rows
    .map((c) => `- ${c.name}${c.role ? `, ${c.role}` : ''}${c.about ? `: ${c.about}` : ''}`)
    .join('\n');
}

/** Компактный пакет для judge: без описания города и без лора. */
export function formatMysteryJudgeCase({
  tags = [],
  anchors = [],
  graphShape = 'linear_4',
  graph = null,
  draft = {},
  characters = [],
} = {}) {
  const type = mysteryTypeTag(tags);
  const assoc = mysteryAssociationTag(tags);
  const asks =
    draft.asksSequel === true || draft.asksSequel === 'true' ? 'true' : 'false';
  return [
    'ПАКЕТ НА ПРОВЕРКУ (только это; полного лора города нет).',
    'Не сверяй фактологию с энциклопедией острова. Смотри причинность, маску, type.about и что X понятен без скрытых узлов.',
    '',
    `ТИП: ${type?.tagName || '—'}`,
    type?.about ? `about: ${type.about}` : null,
    `АССОЦИАЦИЯ (слабый импульс, не обязательная тема): «${assoc?.tagName || '—'}»`,
    '',
    `ШАБЛОН ГРАФА: ${graphShape}`,
    mysteryGraphShapeHint(graphShape),
    '',
    'ЯКОРЯ:',
    formatAnchors(anchors),
    '',
    'ПЕРСОНАЖИ:',
    formatCharacters(characters.length ? characters : draft.newCharacters),
    '',
    formatTruthGraphForPrompt(graph || draft.truthGraph || draft) || '(графа нет)',
    '',
    'observedFacts:',
    ...(draft.observedFacts || []).length
      ? draft.observedFacts.map((f, i) => `${i + 1}. ${f}`)
      : ['- (нет)'],
    'resolutionFacts:',
    ...(draft.resolutionFacts || []).length
      ? draft.resolutionFacts.map((f, i) => `${i + 1}. ${f}`)
      : ['- (нет)'],
    `asksSequel: ${asks}`,
  ]
    .filter((line) => line != null)
    .join('\n');
}

function verdictTool({
  codes = MYSTERY_JUDGE_CODES,
  name = 'submit_mystery_verdict',
  description = 'Вердикт по уже написанной тайне. Историю не чини и не переписывай.',
  locationDescription = 'Узел, ребро или поле: C, A → B, X, entry…',
} = {}) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      required: ['verdict', 'issues', 'summary'],
      properties: {
        verdict: {
          type: 'string',
          enum: MYSTERY_JUDGE_VERDICTS,
          description: 'PASS | FAIL | UNCERTAIN',
        },
        issues: {
          type: 'array',
          description: 'При PASS — пустой массив. При FAIL — хотя бы одна конкретная ошибка.',
          items: {
            type: 'object',
            required: ['code', 'reason'],
            properties: {
              code: { type: 'string', description: `Один из: ${codes.join(', ')}` },
              location: { type: 'string', description: locationDescription },
              reason: { type: 'string', description: 'Почему это ошибка. Без предложения исправления.' },
            },
          },
        },
        summary: { type: 'string', description: 'Короткое итоговое объяснение решения.' },
      },
    },
  };
}

export async function runVerdictJudge({
  runtime,
  agentId,
  caseText,
  extraUser = '',
  extraSystem = '',
  log: parentLog,
  domainId = null,
  codes = MYSTERY_JUDGE_CODES,
  scene = 'mystery_judge',
  scope = 'mystery.judge',
  toolName = 'submit_mystery_verdict',
  toolDescription = 'Вердикт. Историю не чини и не переписывай.',
  locationDescription,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope, agentId });
  const draft = { data: null };
  const tool = verdictTool({
    codes,
    name: toolName,
    description: toolDescription,
    ...(locationDescription ? { locationDescription } : {}),
  });
  tool.handler = async (args) => {
    draft.data = parseJudgeVerdict(args, codes);
    return { ok: true };
  };
  try {
    await runtime.run({
      agentId,
      tools: [tool],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: toolName } },
      log,
      scene,
      domainId,
      extraSystem,
      userMessages: [
        {
          role: 'user',
          content: [extraUser, caseText, `Вызови ${toolName}. Историю не чини.`]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('seed.judge_failed', { agentId, error: err.message });
    return parseJudgeVerdict(
      { verdict: 'UNCERTAIN', summary: err.message || 'сбой валидатора' },
      codes,
    );
  }
  if (!draft.data) {
    return parseJudgeVerdict({ verdict: 'UNCERTAIN', summary: 'валидатор не вернул вердикт' }, codes);
  }
  return draft.data;
}

export async function runMysteryJudge(opts = {}) {
  return runVerdictJudge({
    ...opts,
    codes: opts.codes || MYSTERY_JUDGE_CODES,
    scene: opts.scene || 'mystery_judge',
    scope: opts.scope || 'mystery.judge',
  });
}

/**
 * Luna — дешёвый rejector: только FAIL отсекает.
 * Иначе Terra — финальный acceptor. Terra UNCERTAIN = FAIL.
 */
export async function judgeMysteryCascade({
  runtime,
  caseText,
  log: parentLog,
  domainId = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'mystery.judge.cascade' });
  const luna = await runMysteryJudge({
    runtime,
    agentId: 'mysteryJudge',
    caseText,
    extraUser:
      'FAIL только на доказуемой жёсткой ошибке из списка. Спорное и тонкое — не FAIL: финальный судья решит.',
    log,
    domainId,
  });
  if (luna.verdict === 'FAIL') {
    log.info('mystery.judge.luna', {
      verdict: luna.verdict,
      issues: luna.issues,
      summary: luna.summary,
    });
    return { accepted: false, luna, terra: null };
  }
  log.info('mystery.judge.luna', { verdict: luna.verdict, summary: luna.summary, passToTerra: true });
  const terra = await runMysteryJudge({
    runtime,
    agentId: 'mysteryJudgeTerra',
    caseText,
    extraUser:
      'Ты финальный acceptor core. Дешёвый rejector не нашёл жёсткой ошибки. Проверь самостоятельно с нуля: причинность, время, поступки, X, type. X должен читаться без скрытых узлов. Подачу (synopsis/entry) не оценивай — её ещё нет.',
    log,
    domainId,
  });
  const accepted = terra.verdict === 'PASS';
  log.info('mystery.judge.terra', {
    verdict: terra.verdict,
    issues: terra.issues,
    summary: terra.summary,
    accepted,
  });
  return { accepted, luna, terra };
}

export function summarizeJudgeAttempt({ luna, terra, accepted, literary } = {}) {
  return {
    accepted: Boolean(accepted),
    lunaJudge: luna
      ? { verdict: luna.verdict, issues: luna.issues, summary: luna.summary }
      : null,
    terraJudge: terra
      ? { verdict: terra.verdict, issues: terra.issues, summary: terra.summary }
      : null,
    literaryJudge: literary
      ? { verdict: literary.verdict, issues: literary.issues, summary: literary.summary }
      : null,
  };
}

function listNodes(nodes, empty) {
  if (!nodes?.length) return empty;
  return nodes.map((n) => `- ${n.id}: ${n.text}`).join('\n');
}

/** Пакет литературного судьи подачи: известное vs скрытое, без лора города. */
export function formatMysteryPresentationJudgeCase({
  graph = null,
  presentation = {},
  observedFacts = [],
  resolutionFacts = [],
  title = '',
} = {}) {
  const nodes = graph?.nodes || [];
  const known = nodes.filter((n) => n.knowledge === 'observed' || n.knowledge === 'resolved');
  const hidden = nodes.filter((n) => n.knowledge === 'hidden');
  return [
    'ПАКЕТ НА ПРОВЕРКУ ПОДАЧИ (core уже принят; лора города нет).',
    'Синопсис и хроника имеют право только на известные узлы и observedFacts.',
    'Группу в подаче называй самостоятельно: из известных узлов должно быть ясно, кто это, без скрытых.',
    title ? `Название: ${title}` : null,
    '',
    'ИЗВЕСТНЫЕ УЗЛЫ (единственный источник синопсиса и хроники):',
    listNodes(known, '- (нет)'),
    '',
    'observedFacts:',
    ...(observedFacts || []).length ? observedFacts.map((f, i) => `${i + 1}. ${f}`) : ['- (нет)'],
    '',
    'СКРЫТЫЕ УЗЛЫ (в подачу нельзя даже пересказом):',
    listNodes(hidden, '- (нет)'),
    '',
    'resolutionFacts (closeWhen может требовать их установить, но не называть ответы):',
    ...(resolutionFacts || []).length ? resolutionFacts.map((f, i) => `${i + 1}. ${f}`) : ['- (нет)'],
    '',
    'ПОДАЧА:',
    `synopsis: ${presentation.synopsis || '—'}`,
    `entry: ${presentation.entry || '—'}`,
    `closeWhen: ${presentation.closeWhen || '—'}`,
    `mootWhen: ${String(presentation.mootWhen || '').trim() || '—'}`,
  ]
    .filter((line) => line != null)
    .join('\n');
}

const PRESENTATION_JUDGE_PROMPT = [
  'Ты литературный судья ПОДАЧИ тайны. Luna. Core уже принят — граф не оценивай и не чини.',
  'FAIL только на явной ошибке подачи. Спорное — UNCERTAIN, не FAIL.',
  '',
  'FAIL если:',
  '- synopsis или entry выдают скрытый узел (виновный, мотив, механизм, улика из hidden), даже другими словами;',
  '- synopsis или entry добавляют факты, которых нет в известных узлах и observedFacts;',
  '- группа названа относительно («соседи», «его люди», «остальные»), а из известных узлов и observedFacts не ясно, чьи они: антецедент только в скрытом узле;',
  '- хроника (entry) не оставляет зацепки: нет странности или открытого «почему», по которому захочется поручить проверку;',
  '- closeWhen называет разгадку или склеивает несколько условий через «и»;',
  '- mootWhen пустой или повторяет closeWhen.',
  '',
  'PASS если синопсис честно показывает только известное, а хроника из того же слоя зовёт узнать дальше.',
].join('\n');

export async function judgeMysteryPresentation({
  runtime,
  caseText,
  log: parentLog,
  domainId = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'mystery.judge.presentation' });
  const verdict = await runVerdictJudge({
    runtime,
    agentId: 'mysteryPresentationJudge',
    caseText,
    extraUser: PRESENTATION_JUDGE_PROMPT,
    log,
    domainId,
    codes: MYSTERY_PRESENTATION_JUDGE_CODES,
    scene: 'mystery_presentation_judge',
    scope: 'mystery.judge.presentation',
    toolName: 'submit_mystery_verdict',
    toolDescription: 'Вердикт по подаче тайны. Текст не чини.',
  });
  log.info('mystery.judge.presentation', {
    verdict: verdict.verdict,
    issues: verdict.issues,
    summary: verdict.summary,
    accepted: literaryJudgeAccepts(verdict.verdict),
  });
  return verdict;
}
