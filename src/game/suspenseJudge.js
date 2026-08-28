/**
 * Литературный судья завязки саспенса (Luna).
 * FAIL не отсеивает сразу: сторителлер получает до трёх попыток доработки.
 */

import { getLogger } from '../log.js';
import { hiddenPremisesBudget } from './suspenseGraph.js';
import {
  runVerdictJudge,
  literaryJudgeAccepts,
} from './mysteryJudge.js';

export const SUSPENSE_JUDGE_CODES = [
  'NO_CONFLICT',
  'NO_MOVEMENT',
  'HIDDEN_OVER_BUDGET',
  'HIDDEN_LEAK',
  'HIDDEN_THIN',
  'THIN_HOOK',
  'PREMISE_REPLACED_BY_SOCIAL',
  'RESOLVED_AT_SEED',
  'CLOSE_WHEN_COMPOUND',
  'MOOT_WHEN_MISSING',
  'MOOT_WHEN_DUP',
  'OTHER',
];

export function formatSuspenseJudgeCase({
  draft = {},
  seed = null,
  tags = [],
} = {}) {
  const depth = Math.max(1, Math.min(4, Math.round(Number(seed?.depth ?? draft.depth) || 1)));
  const budget = hiddenPremisesBudget(depth);
  const hidden = Array.isArray(draft.hiddenPremises) ? draft.hiddenPremises : [];
  const ladder = Array.isArray(draft.discoveryLadder) ? draft.discoveryLadder : [];
  const tagLine = (tags || [])
    .map((t) => t.tagName || t.tagId)
    .filter(Boolean)
    .join(', ');
  return [
    'ПАКЕТ НА ПРОВЕРКУ ЗАВЯЗКИ (лора города нет).',
    `depth: ${depth}. Бюджет hiddenPremises: от ${budget.min} до ${budget.max}.`,
    seed?.gravity != null ? `gravity (масштаб последствий): ${seed.gravity}` : null,
    seed?.tonePrimary ? `tone: ${seed.tonePrimary}${seed.toneSecondary ? ` / ${seed.toneSecondary}` : ''}` : null,
    seed?.source ? `source: ${seed.source}` : null,
    seed?.situation ? `situation: ${seed.situation}` : null,
    seed?.dynamic ? `dynamic: ${seed.dynamic}` : null,
    tagLine ? `теги: ${tagLine}` : null,
    '',
    `title: ${draft.title || '—'}`,
    `synopsis: ${draft.synopsis || '—'}`,
    `entry: ${draft.entry || '—'}`,
    `closeWhen: ${draft.closeWhen || '—'}`,
    `mootWhen: ${String(draft.mootWhen || '').trim() || '—'}`,
    draft.closureGate ? `closureGate: ${draft.closureGate}` : null,
    '',
    'hiddenPremises:',
    hidden.length ? hidden.map((h, i) => `${i + 1}. ${h}`).join('\n') : '- (нет)',
    '',
    'discoveryLadder:',
    ladder.length
      ? ladder.map((r, i) => `${i + 1}. ${r.id || 'rung'}: ${r.promise || r.text || ''}`).join('\n')
      : '- (нет)',
  ]
    .filter((line) => line != null)
    .join('\n');
}

const SUSPENSE_JUDGE_PROMPT = [
  'Ты литературный судья завязки саспенса. Luna. Не чини историю.',
  'FAIL только на явной дыре. Спорное — UNCERTAIN, не FAIL.',
  '',
  'FAIL если:',
  '- нет конфликта: никто ничего не хочет, ничто не давит, ставки в тексте не видны;',
  '- нет движения сюжета: статичная витрина, нет нестабильного настоящего и открытого будущего;',
  '- hiddenPremises больше бюджета depth или утекли в entry/synopsis;',
  '- при явной странности hiddenPremises пустые отговорки («просто сквозняк», «ошибка»);',
  '- социальная свара подменяет premise, если режиссура требовала иное событие;',
  '- история уже разрешена в завязке;',
  '- closeWhen — список через «и», или mootWhen пустой / дубль closeWhen.',
  '',
  'НЕ FAIL за вкус, длину или имена, если конфликт, движение и бюджет скрытого в порядке.',
  'PASS если есть живой конфликт, куда история может двинуться, и скрытое не вылезает в хронику.',
].join('\n');

export async function judgeSuspenseSeed({
  runtime,
  caseText,
  log: parentLog,
  domainId = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'suspense.judge' });
  const verdict = await runVerdictJudge({
    runtime,
    agentId: 'suspenseJudge',
    caseText,
    extraUser: SUSPENSE_JUDGE_PROMPT,
    log,
    domainId,
    codes: SUSPENSE_JUDGE_CODES,
    scene: 'suspense_seed_judge',
    scope: 'suspense.judge',
    toolName: 'submit_suspense_verdict',
    toolDescription: 'Вердикт по завязке саспенса. Текст не чини.',
  });
  log.info('suspense.judge', {
    verdict: verdict.verdict,
    issues: verdict.issues,
    summary: verdict.summary,
    accepted: literaryJudgeAccepts(verdict.verdict),
  });
  return verdict;
}
