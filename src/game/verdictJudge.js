/**
 * Общий PASS/FAIL/UNCERTAIN-судья: агент не чинит текст, только вердикт.
 */

import { getLogger } from '../log.js';

export const JUDGE_VERDICTS = ['PASS', 'FAIL', 'UNCERTAIN'];

export const DEFAULT_JUDGE_CODES = ['OTHER'];

function clip(s, max) {
  const t = String(s ?? '').trim();
  if (!t.length) return t;
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

export function parseJudgeVerdict(raw, codes = DEFAULT_JUDGE_CODES) {
  const codeSet = new Set(codes);
  const asCode = (value) => {
    const c = String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '_');
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
  if (!JUDGE_VERDICTS.includes(verdict)) {
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

/** Литературный судья: только FAIL гоняет на доработку. PASS и UNCERTAIN принимают. */
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

function verdictTool({
  codes = DEFAULT_JUDGE_CODES,
  name = 'submit_verdict',
  description = 'Вердикт. Историю не чини и не переписывай.',
  locationDescription = 'Поле или место ошибки.',
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
          enum: JUDGE_VERDICTS,
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
  codes = DEFAULT_JUDGE_CODES,
  scene = 'verdict_judge',
  scope = 'verdict.judge',
  toolName = 'submit_verdict',
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
