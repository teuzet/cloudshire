import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_SUMMARY_MAX } from './plotlines.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { normalizeHiddenPremises } from './suspenseGraph.js';
import {
  freeformConfig,
  cityStateForPrompt,
  plotCardForPrompt,
  plotChronicleForPrompt,
  finishLabel,
  openStoryTitlesLine,
  applyFreeformProgress,
  freeformTickDecision,
  pickEndingsForPack,
  findPlotEnding,
  normalizeFinish,
} from './freeform.js';
import {
  reviewFreeformPack,
  reviewNeedsRewrite,
  isPackPass,
  scatterPackReviews,
} from './freeformJudge.js';
import { collectBrainstormPool } from './freeformBrainstorm.js';
import { architectFreeformBlanks, repairBeatBlanks, packRejectedBlanks } from './freeformArchitect.js';
import { refreshFreeformEndings } from './freeformEndings.js';
import { setFreeformUrgency } from './freeformUrgency.js';

const MIN_PASS_SKIP_SECOND = 2;

export function normalizeBeatVariant(raw, cfg) {
  const chronicle = clipPlotText(raw?.chronicle || raw?.entry, cfg.chronicleMaxChars);
  const synopsis = clipPlotText(raw?.synopsis, PLOT_SUMMARY_MAX);
  if (!chronicle || !synopsis) return null;
  return {
    chronicle,
    synopsis,
    hiddenPremises: raw?.hiddenPremises ? normalizeHiddenPremises(raw.hiddenPremises) : null,
    closed: Boolean(raw?.closed),
    closedBy: raw?.closed ? clipPlotText(raw?.closedBy, 200) : '',
  };
}

export function beatCardFromBlank(blank, cfg) {
  if (!blank) return null;
  const paragraph = blank.text || blank.whatHappens || '';
  return normalizeBeatVariant(
    {
      chronicle: paragraph,
      synopsis: blank.situationNow || paragraph,
      hiddenPremises: blank.hiddenPremises,
    },
    cfg,
  );
}

function formatBeatPackForJudge(variants) {
  return variants
    .map((v, i) => {
      const n = Number(v.index) || i + 1;
      const dyn = v.dynamicName ? `способ сдвига: ${v.dynamicName}` : '';
      const ending = v.endingText ? `концовка: ${v.endingText}` : '';
      return [`=== Кандидат ${n} ===`, dyn, ending, v.text || '']
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

function pickFromPool(pool, rng = Math.random) {
  if (!pool.length) return null;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[idx];
}

function stampIndices(variants) {
  return (variants || []).map((v, i) => ({ ...v, index: Number(v.index) || i + 1 }));
}

async function constructBeat({ runtime, domain, world, plot, deed, blank, cfg, log, closing = false }) {
  const draft = { card: null };
  const runOpts = {
    agentId: 'freeformTell',
    tools: [
      {
        name: 'submit_freeform_beat',
        description: 'Одно продолжение: эта болванка, посаженная в город.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['chronicle', 'synopsis'],
          properties: {
            chronicle: { type: 'string' },
            synopsis: {
              type: 'string',
              description:
                'Пересказ сюжета: что случилось и как сейчас. Без «Год N, месяц M», «в месяц 5» и прочих нумерованных дат.',
            },
            hiddenPremises: { type: 'array', items: { type: 'string' } },
          },
        },
        handler: async (args) => {
          const card = normalizeBeatVariant(args, cfg);
          if (!card) {
            return toolFail('thin', 'Нужны chronicle и synopsis.');
          }
          draft.card = card;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_beat' } },
    log,
    scene: 'freeform_tell',
    domainId: domain?.id,
    extraSystem: [cityStateForPrompt(domain, world), plotCardForPrompt(plot, { revealHidden: true })].join(
      '\n\n',
    ),
    userMessages: [
      {
        role: 'user',
        content: [
          plotChronicleForPrompt(domain, plot),
          '',
          deed
            ? [
                `Поступок: ${deed.summary}`,
                deed.detail ? `Подробности: ${deed.detail}` : '',
                `Длительность: ${deed.durationMonths} мес.`,
                `Исход (уже случился): ${finishLabel(deed.finish)}.`,
              ]
                .filter(Boolean)
                .join('\n')
            : 'Городом эту историю не занимались. Ситуация сама сдвинулась. Поступка нет.',
          '',
          closing
            ? 'Это финальная хроника: яви концовку полностью. История после этого закрывается.'
            : 'Продолжение (сохрани событие; город даёт где и кто):',
          blank?.text || blank?.whatHappens || '',
          blank?.endingText ? `Концовка, которую надо явить: ${blank.endingText}` : '',
          '',
          'Посади это в город через submit_freeform_beat.',
          'Город даёт где и кто. Что случилось — уже в абзаце.',
          'Хроника — сухой факт месяца. Синопсис — пересказ сюжета so far, без прогноза.',
          'В синопсисе не пиши «Год N, месяц M», «в месяц 5» и нумерованные даты. Порядок — сюжетом.',
          'Концовку и срочность не ставь — это не твоя ставка.',
          'hiddenPremises в хронику не пиши.',
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
    log.warn('freeform.construct_beat_failed', { error: err.message });
  }
  return { card: draft.card, prompt };
}

async function pickBeatBlank({
  runtime,
  domain,
  plot,
  drafts,
  caseText,
  rng,
  log,
}) {
  const variants = stampIndices(drafts);
  if (variants.length <= 1) {
    return {
      blank: variants[0] || null,
      variants,
      reviews: [],
      finalReviews: [],
      judgePrompt: '',
      repairPrompt: '',
      finalJudgePrompt: '',
      pickedIndex: variants[0] ? Number(variants[0].index) || 1 : null,
    };
  }

  const judged = await reviewFreeformPack({
    runtime,
    agentId: 'freeformBeatJudge',
    candidates: variants,
    caseText: [caseText, '', formatBeatPackForJudge(variants)].filter(Boolean).join('\n'),
    extraSystem: '',
    log,
    scene: 'freeform_beat_judge',
  });
  const firstPassCount = (judged.reviews || []).filter(isPackPass).length;
  if (firstPassCount >= MIN_PASS_SKIP_SECOND) {
    const pool = collectBrainstormPool(variants, judged.reviews);
    const blank = pickFromPool(pool, rng) || variants[0];
    return {
      blank,
      variants,
      reviews: judged.reviews,
      finalReviews: [],
      judgePrompt: judged.prompt || '',
      repairPrompt: '',
      finalJudgePrompt: '',
      pickedIndex: Number(blank?.index) || variants.indexOf(blank) + 1,
    };
  }

  const rewriteIdx = judged.reviews
    .map((review, i) => (reviewNeedsRewrite(review) ? i : -1))
    .filter((i) => i >= 0);
  let repaired = variants;
  let repairPrompt = '';
  if (rewriteIdx.length) {
    const retryDrafts = rewriteIdx.map((i) => variants[i]);
    const retryReviews = rewriteIdx.map((i) => judged.reviews[i]);
    const fixed = await repairBeatBlanks({
      runtime,
      drafts: retryDrafts,
      reviews: retryReviews,
      log,
      extra: [plotCardForPrompt(plot, { revealHidden: true }), plotChronicleForPrompt(domain, plot)]
        .filter(Boolean)
        .join('\n\n'),
    });
    repairPrompt = fixed.prompt || '';
    repaired = variants.map((v, i) => {
      if (!reviewNeedsRewrite(judged.reviews[i])) return v;
      const slot = rewriteIdx.indexOf(i);
      const next = fixed.variants?.[slot];
      return next ? { ...v, ...next, index: v.index } : v;
    });
  }

  const retry = repaired.filter((_, i) => !isPackPass(judged.reviews[i]));
  const gated = retry.length
    ? await reviewFreeformPack({
        runtime,
        agentId: 'freeformBeatJudge',
        candidates: retry,
        caseText: [caseText, '', formatBeatPackForJudge(retry)].filter(Boolean).join('\n'),
        extraSystem: '',
        log,
        scene: 'freeform_beat_judge_retry',
      })
    : { reviews: [], prompt: '' };
  const finalReviews = scatterPackReviews(repaired.length, gated.reviews);
  const pool = collectBrainstormPool(variants, judged.reviews, repaired, finalReviews);
  const blank = pickFromPool(pool, rng) || repaired[0];
  return {
    blank,
    variants: repaired,
    reviews: judged.reviews,
    finalReviews,
    judgePrompt: judged.prompt || '',
    repairPrompt,
    finalJudgePrompt: gated.prompt || '',
    pickedIndex: Number(blank?.index) || repaired.indexOf(blank) + 1,
  };
}

function emptyTell({ architectPrompt = '', error = 'architect_empty' } = {}) {
  return {
    ok: false,
    error,
    variants: [],
    pickedIndex: null,
    rejected: [],
    architectPrompt,
    judgePrompt: '',
    repairPrompt: '',
    finalJudgePrompt: '',
    tellPrompt: '',
    endingsPrompt: '',
    urgencyPrompt: '',
    decision: null,
  };
}

export async function tellFreeformBeat({
  config,
  runtime,
  domain,
  world,
  plot,
  deed = null,
  trigger = 'deed',
  relation = 'RELATED',
  endingId = null,
  log: parentLog,
  rng = Math.random,
}) {
  const log = (parentLog || getLogger()).child({
    scope: 'freeform.tell',
    domainId: domain?.id,
    plotId: plot?.id,
    trigger,
  });
  const auto = trigger === 'auto';
  const finish = auto ? 'fail' : normalizeFinish(deed?.finish);
  const rel = auto ? 'RELATED' : String(relation || 'RELATED').toUpperCase();
  const snap = {
    depth: plot.depth,
    failCount: plot.failCount,
  };
  applyFreeformProgress(plot, { finish, autotick: auto });
  const decision = freeformTickDecision(plot, {
    relation: rel,
    finish,
    autotick: auto,
    endingId,
  });

  const closing = decision.kind === 'closeDirect' || decision.kind === 'closeBad';
  const endingSlots =
    decision.kind === 'closeDirect'
      ? [
          findPlotEnding(plot, decision.endingId) ||
            plot.endings?.[0] || {
              id: 'end_direct',
              kind: 'NEUTRAL_ENDING',
              text: 'История закрылась тем, к чему шло дело.',
            },
        ]
      : decision.kind === 'closeBad'
        ? pickEndingsForPack(plot, 'BAD_ENDING', 3)
        : null;

  const { cfg, variants: drafted, prompt: architectPrompt = '' } = await architectFreeformBlanks({
    runtime,
    domain,
    plot,
    deed,
    trigger,
    kind: 'beat',
    config,
    polarity: decision.kind === 'continue' ? decision.polarity : null,
    endingSlots,
    rng,
    log,
  });
  if (!drafted.length) {
    plot.depth = snap.depth;
    plot.failCount = snap.failCount;
    return emptyTell({ architectPrompt });
  }

  const caseText = [
    plotCardForPrompt(plot, { revealHidden: true }),
    plotChronicleForPrompt(domain, plot),
    openStoryTitlesLine(domain, plot?.id),
    '',
    auto
      ? 'Городом эту историю не занимались. Ситуация сама сдвинулась.'
      : `Поступок: ${deed?.summary || ''}. Исход: ${finishLabel(finish)}.`,
    closing
      ? 'Абзац должен явить данную концовку полностью. Это закрытие истории.'
      : 'У каждого варианта свой способ сдвига — это жребий, не критерий качества.',
  ]
    .filter(Boolean)
    .join('\n');

  const picked = await pickBeatBlank({
    runtime,
    domain,
    plot,
    drafts: drafted,
    caseText,
    rng,
    log,
  });
  const blank = picked.blank;
  if (!blank) {
    plot.depth = snap.depth;
    plot.failCount = snap.failCount;
    return emptyTell({ architectPrompt, error: 'judge_empty' });
  }

  const builtCfg = cfg || freeformConfig(config);
  let winner = null;
  let tellPrompt = '';
  try {
    const built = await constructBeat({
      runtime,
      domain,
      world,
      plot,
      deed,
      blank,
      cfg: builtCfg,
      log,
      closing,
    });
    winner = built.card;
    tellPrompt = built.prompt || '';
  } catch (err) {
    log.warn('freeform.construct_beat_failed', { error: err.message });
  }
  winner = winner || beatCardFromBlank(blank, builtCfg);
  if (!winner) {
    plot.depth = snap.depth;
    plot.failCount = snap.failCount;
    return {
      ...emptyTell({ architectPrompt, error: 'constructor_empty' }),
      variants: picked.variants,
      judgePrompt: picked.judgePrompt,
      repairPrompt: picked.repairPrompt,
      finalJudgePrompt: picked.finalJudgePrompt,
      tellPrompt,
    };
  }

  if (closing) {
    const ending = blank.endingText || findPlotEnding(plot, blank.endingId)?.text || '';
    winner.closed = true;
    winner.closedBy = ending || 'resolved';
  } else {
    winner.closed = false;
    winner.closedBy = '';
  }

  let endingsPrompt = '';
  let urgencyPrompt = '';
  if (!winner.closed) {
    const ended = await refreshFreeformEndings({ runtime, domain, plot, log });
    endingsPrompt = ended.prompt || '';
    const urgent = await setFreeformUrgency({ runtime, domain, plot, log, rng });
    urgencyPrompt = urgent.prompt || '';
  }

  const pickedIndex = Number(picked.pickedIndex);
  const rejected = packRejectedBlanks(picked.variants, Math.max(0, pickedIndex - 1));

  return {
    ok: true,
    winner,
    rejected,
    judge: { why: '', repair: '', issues: [], reviews: picked.reviews, finalReviews: picked.finalReviews },
    variants: picked.variants,
    pickedIndex,
    architectPrompt,
    judgePrompt: picked.judgePrompt,
    repairPrompt: picked.repairPrompt,
    finalJudgePrompt: picked.finalJudgePrompt,
    tellPrompt,
    endingsPrompt,
    urgencyPrompt,
    decision,
  };
}
