/**
 * Каскад валидации CORE тайны: Luna — дешёвый rejector, иначе Terra — acceptor.
 * Judge не чинит историю, не видит лор города и не оценивает подачу.
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
  'SYNOPSIS_ENTRY_INVENTION',
  'CLOSE_WHEN_INVENTION',
  'REDUNDANT_STRUCTURE',
  'OTHER',
];

const CODE_SET = new Set(MYSTERY_JUDGE_CODES);

function clip(s, max) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

function asCode(raw) {
  const c = String(raw || '').trim().toUpperCase().replace(/\s+/g, '_');
  return CODE_SET.has(c) ? c : 'OTHER';
}

export function parseMysteryJudgeVerdict(raw) {
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
    'Не сверяй фактологию с энциклопедией острова. Смотри причинность, маску и type.about.',
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

function verdictTool() {
  return {
    name: 'submit_mystery_verdict',
    description: 'Вердикт по уже написанной тайне. Историю не чини и не переписывай.',
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
              code: { type: 'string', description: `Один из: ${MYSTERY_JUDGE_CODES.join(', ')}` },
              location: { type: 'string', description: 'Узел, ребро или поле: C, A → B, X, entry…' },
              reason: { type: 'string', description: 'Почему это ошибка. Без предложения исправления.' },
            },
          },
        },
        summary: { type: 'string', description: 'Короткое итоговое объяснение решения.' },
      },
    },
  };
}

export async function runMysteryJudge({
  runtime,
  agentId,
  caseText,
  extraUser = '',
  log: parentLog,
  domainId = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'mystery.judge', agentId });
  const draft = { data: null };
  const tool = verdictTool();
  tool.handler = async (args) => {
    draft.data = parseMysteryJudgeVerdict(args);
    return { ok: true };
  };
  try {
    await runtime.run({
      agentId,
      tools: [tool],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_mystery_verdict' } },
      log,
      scene: 'mystery_judge',
      domainId,
      extraSystem: '',
      userMessages: [
        {
          role: 'user',
          content: [extraUser, caseText, 'Вызови submit_mystery_verdict. Историю не чини.']
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('mystery.judge_failed', { agentId, error: err.message });
    return parseMysteryJudgeVerdict({
      verdict: 'UNCERTAIN',
      summary: err.message || 'сбой валидатора',
    });
  }
  if (!draft.data) {
    return parseMysteryJudgeVerdict({
      verdict: 'UNCERTAIN',
      summary: 'валидатор не вернул вердикт',
    });
  }
  return draft.data;
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
      'Ты финальный acceptor core. Дешёвый rejector не нашёл жёсткой ошибки. Проверь самостоятельно с нуля: причинность, время, поступки, X, type. Подачу (synopsis/entry) не оценивай — её ещё нет.',
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

export function summarizeJudgeAttempt({ luna, terra, accepted } = {}) {
  return {
    accepted: Boolean(accepted),
    lunaJudge: luna
      ? { verdict: luna.verdict, issues: luna.issues, summary: luna.summary }
      : null,
    terraJudge: terra
      ? { verdict: terra.verdict, issues: terra.issues, summary: terra.summary }
      : null,
  };
}
