import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { newId } from './ids.js';
import {
  FREEFORM_ENDING_KINDS,
  formatFreeformEndings,
  normalizeFreeformEndings,
  parseFreeformEndingKind,
} from './plotlines.js';
import { formatFreeformGravityForPrompt, plotCardForPrompt, plotChronicleForPrompt } from './freeform.js';
import { formatCityForAgents } from './cityContext.js';

function formatEndingsBrief(domain) {
  if (!domain) return '';
  const brief = formatCityForAgents(domain);
  return [
    domain.name ? `Город «${domain.name}».` : '',
    'БРИФ ГОРОДА (стандартный бриф для агентов, не полное описание)',
    brief,
  ]
    .filter(Boolean)
    .join('\n');
}

export function fallbackFreeformEndings() {
  return normalizeFreeformEndings([
    { id: 'end_good', kind: 'GOOD_ENDING', text: 'Ставки истории сыграли.' },
    { id: 'end_neutral', kind: 'NEUTRAL_ENDING', text: 'Дело сошлось без победы и крушения.' },
    { id: 'end_bad', kind: 'BAD_ENDING', text: 'Ставки истории проиграны.' },
  ]);
}

function ensureEndingKinds(list) {
  const have = new Set((list || []).map((e) => e.kind));
  const out = [...(list || [])];
  for (const kind of FREEFORM_ENDING_KINDS) {
    if (have.has(kind)) continue;
    const fb = fallbackFreeformEndings().find((e) => e.kind === kind);
    if (fb) out.push({ ...fb, id: newId('end') });
  }
  return out;
}

function applyEndings(plot, list) {
  const endings = ensureEndingKinds(normalizeFreeformEndings(list));
  plot.endings = endings;
  plot.closeWhen = endings.map((e) => e.text);
  return endings;
}

export const FREEFORM_ENDINGS_JUDGE_CODES = [
  'QUESTION_OPEN',
  'CAUSE_UNTOUCHED',
  'NOT_A_LOSS',
  'NO_GAIN',
  'HORIZON',
  'THIN',
  'OTHER',
];

function endingsToolSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['keep', 'endings'],
    properties: {
      keep: {
        type: 'boolean',
        description: 'true, если текущий список ещё держит историю.',
      },
      endings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'kind', 'questionGone', 'nowDifferent'],
          properties: {
            id: { type: 'string' },
            text: { type: 'string', description: 'Что случилось. Коротко и предметно, в настоящем времени истории.' },
            kind: { type: 'string', enum: [...FREEFORM_ENDING_KINDS] },
            questionGone: {
              type: 'string',
              description:
                'Одно предложение: почему после этого вопрос в городе больше не стоит. Не «стало легче» и не «отложили».',
            },
            nowDifferent: {
              type: 'string',
              description:
                'Одно предложение: что в городе теперь по-другому и таким останется. Вещь, место, люди, порядок или знание — не настроение.',
            },
          },
        },
      },
    },
  };
}

async function askEndings({ runtime, domain, plot, repair = '', log, config }) {
  const draft = { keep: false, endings: null };
  const runOpts = {
    agentId: 'freeformEndings',
    tools: [
      {
        name: 'submit_freeform_endings',
        description: 'Актуальный список концовок. Хотя бы одна GOOD, NEUTRAL и BAD.',
        parameters: endingsToolSchema(),
        handler: async (args) => {
          const keep = Boolean(args?.keep);
          const raw = Array.isArray(args?.endings) ? args.endings : [];
          const endings = normalizeFreeformEndings(
            raw.map((e) => ({
              id: e?.id,
              text: e?.text,
              kind: parseFreeformEndingKind(e?.kind),
              questionGone: e?.questionGone,
              nowDifferent: e?.nowDifferent,
            })),
          );
          if (!keep && !endings.length) {
            return toolFail('thin', 'Нужен список концовок или keep=true.');
          }
          const bare = endings.find((e) => !e.questionGone || !e.nowDifferent);
          if (bare) {
            return toolFail(
              'thin',
              `У концовки «${bare.text}» нет questionGone или nowDifferent. Они нужны у каждой.`,
            );
          }
          draft.keep = keep;
          draft.endings = endings;
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_endings' } },
    log,
    scene: 'freeform_endings',
    domainId: domain?.id,
    extraSystem: formatEndingsBrief(domain),
    userMessages: [
      {
        role: 'user',
        content: [
          plotCardForPrompt(plot, { revealHidden: true }),
          '',
          formatFreeformGravityForPrompt(plot?.gravity, config),
          '',
          plotChronicleForPrompt(domain, plot),
          '',
          'Скрытое учти как «На самом деле», в формулировку концовки его не пиши.',
          repair
            ? [
                '',
                'Судья прошёлся по прошлому списку. Почини названное, остальное не трогай.',
                repair,
                'Верни полный список заново, keep=false.',
              ].join('\n')
            : '',
          'Верни submit_freeform_endings. Нужна хотя бы одна концовка каждого типа.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.endings_failed', { error: err.message });
  }
  return { ...draft, prompt };
}

export function formatEndingsJudgeCase(plot, endings) {
  return [
    `История «${plot?.title || '—'}».`,
    `Синопсис: ${plot?.synopsis || '—'}`,
    plot?.cause ? `Первопричина: ${plot.cause}` : 'Первопричина: не задана.',
    '',
    'Концовки на проверку:',
    formatFreeformEndings(endings),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Дешёвая проверка: снимает ли каждая концовка вопрос, и не подменён ли он ухудшением. */
export async function judgeFreeformEndings({ runtime, plot, endings, log: parentLog, domainId } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.endings.judge', plotId: plot?.id });
  const list = Array.isArray(endings) ? endings : [];
  const n = list.length;
  if (!n) return { reviews: [], prompt: '' };
  const draft = { reviews: null };
  const runOpts = {
    agentId: 'freeformEndingsJudge',
    tools: [
      {
        name: 'submit_endings_review',
        description: `Вердикт по каждой из ${n} концовок. Концовки не переписывай.`,
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
                  index: { type: 'integer', description: `Номер концовки: 1..${n}.` },
                  verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
                  code: { type: 'string', enum: FREEFORM_ENDINGS_JUDGE_CODES },
                  repair: {
                    type: 'string',
                    description: 'Одна короткая правка автору. Пусто при PASS.',
                  },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const raw = Array.isArray(args?.reviews) ? args.reviews : [];
          if (raw.length !== n) return toolFail('thin', `Нужен вердикт ровно по ${n} концовкам.`);
          draft.reviews = raw.map((r, i) => ({
            index: Number(r?.index) || i + 1,
            verdict: String(r?.verdict || '').toUpperCase() === 'FAIL' ? 'FAIL' : 'PASS',
            code: String(r?.code || '').trim(),
            repair: String(r?.repair || '').trim(),
          }));
          return { ok: true, count: n };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_endings_review' } },
    log,
    scene: 'freeform_endings_judge',
    domainId,
    extraSystem: '',
    userMessages: [{ role: 'user', content: formatEndingsJudgeCase(plot, list) }],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.endings_judge_failed', { error: err.message });
  }
  const reviews = draft.reviews || [];
  log.info('freeform.endings_judge', { count: n, failed: reviews.filter((r) => r.verdict === 'FAIL').length });
  return { reviews, prompt };
}

export function formatEndingsJudgeRepair(endings, reviews) {
  const list = Array.isArray(endings) ? endings : [];
  const failed = (reviews || []).filter((r) => r.verdict === 'FAIL');
  if (!failed.length) return '';
  return failed
    .map((r) => {
      const ending = list[r.index - 1];
      if (!ending) return '';
      return [
        `«${ending.text}» [${ending.kind}] — ${r.code || 'FAIL'}`,
        r.repair ? `  ${r.repair}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

export async function refreshFreeformEndings({ runtime, domain, plot, config, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.endings', plotId: plot?.id });
  if (!plot) return { endings: [], keep: false, prompt: '' };

  const asked = await askEndings({ runtime, domain, plot, log, config });
  const current = Array.isArray(plot.endings) ? plot.endings : [];
  if (asked.keep && current.length) {
    const endings = applyEndings(plot, current);
    return { endings, keep: true, prompt: asked.prompt };
  }

  let source = asked.endings?.length ? asked.endings : current.length ? current : fallbackFreeformEndings();
  let judgePrompt = '';
  let repairPrompt = '';
  // Судим только свежий список: тот, что уже стоит на нити, судья видел при выдаче.
  if (asked.endings?.length) {
    const judged = await judgeFreeformEndings({ runtime, plot, endings: source, log, domainId: domain?.id });
    judgePrompt = judged.prompt;
    const repair = formatEndingsJudgeRepair(source, judged.reviews);
    if (repair) {
      const patched = await askEndings({ runtime, domain, plot, repair, log, config });
      repairPrompt = patched.prompt;
      if (patched.endings?.length) source = patched.endings;
    }
  }

  const endings = applyEndings(plot, source);
  log.info('freeform.endings', { count: endings.length, keep: Boolean(asked.keep), repaired: Boolean(repairPrompt) });
  return {
    endings,
    keep: Boolean(asked.keep),
    prompt: asked.prompt,
    judgePrompt,
    repairPrompt,
  };
}
