import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_SUMMARY_MAX } from './plotlines.js';
import { normalizeHiddenPremises } from './suspenseGraph.js';
import {
  freeformConfig,
  cityStateForPrompt,
  plotCardForPrompt,
  plotChronicleForPrompt,
  finishLabel,
  normalizeCloseWhenList,
  openStoryTitlesLine,
  clampUrgency,
} from './freeform.js';
import { pickFreeformVariant } from './freeformJudge.js';
import { architectFreeformBlanks, repairFreeformBlank, packRejectedBlanks } from './freeformArchitect.js';

export function normalizeBeatVariant(raw, cfg) {
  const chronicle = clipPlotText(raw?.chronicle || raw?.entry, cfg.chronicleMaxChars);
  const synopsis = clipPlotText(raw?.synopsis, PLOT_SUMMARY_MAX);
  if (!chronicle || !synopsis) return null;
  const closed = Boolean(raw?.closed);
  return {
    chronicle,
    synopsis,
    closeWhen: raw?.closeWhen ? normalizeCloseWhenList(raw.closeWhen) : null,
    hiddenPremises: raw?.hiddenPremises ? normalizeHiddenPremises(raw.hiddenPremises) : null,
    urgency: Number.isFinite(Number(raw?.urgency)) ? clampUrgency(raw.urgency, null) : null,
    closed,
    closedBy: closed ? clipPlotText(raw?.closedBy, 200) : '',
  };
}

export function beatCardFromBlank(blank, cfg) {
  if (!blank) return null;
  return normalizeBeatVariant(
    {
      chronicle: blank.whatHappens,
      synopsis: blank.situationNow,
      closeWhen: blank.closeWhen,
      hiddenPremises: blank.hiddenPremises,
      urgency: blank.urgency,
      closed: blank.closed,
      closedBy: blank.closedBy,
    },
    cfg,
  );
}

async function constructBeat({ runtime, domain, world, plot, deed, blank, cfg, log }) {
  const draft = { card: null };
  await runtime.run({
    agentId: 'freeformTell',
    tools: [
      {
        name: 'submit_freeform_beat',
        description: 'Одно продолжение: эта болванка, посаженная в город.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['chronicle', 'synopsis', 'closed'],
          properties: {
            chronicle: { type: 'string' },
            synopsis: { type: 'string' },
            closeWhen: { type: 'array', items: { type: 'string' } },
            hiddenPremises: { type: 'array', items: { type: 'string' } },
            urgency: { type: 'integer' },
            closed: { type: 'boolean' },
            closedBy: {
              type: 'string',
              description: 'Какой исход closeWhen сработал, если closed=true.',
            },
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
          `Дело: ${deed.summary}`,
          deed.detail ? `Подробности: ${deed.detail}` : '',
          `Длительность: ${deed.durationMonths} мес.`,
          `Исход дела (уже брошен системой, не перерешай): ${finishLabel(deed.finish)}.`,
          '',
          'Болванка хода (сохрани её событие; город даёт где и кто):',
          JSON.stringify(blank, null, 2),
          '',
          'Посади ЭТОТ ход в город через submit_freeform_beat.',
          'Город даёт где и кто. Что случилось — уже в whatHappens.',
          'Хроника — сухой факт месяца. Синопсис — сжатие всей истории so far, без прогноза.',
          'closeWhen/hiddenPremises/urgency — только если болванка их сдвинула, иначе опусти.',
          'closed=true только если один из closeWhen уже произошёл в этой хронике. Не закрывай рано.',
          'hiddenPremises в хронику не пиши.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });
  return draft.card;
}

export async function tellFreeformBeat({ config, runtime, domain, world, plot, deed, log: parentLog }) {
  const log = (parentLog || getLogger()).child({
    scope: 'freeform.tell',
    domainId: domain?.id,
    plotId: plot?.id,
  });
  const { cfg, variants } = await architectFreeformBlanks({
    runtime,
    domain,
    plot,
    deed,
    kind: 'beat',
    config,
    log,
  });
  if (!variants.length) {
    return { ok: false, error: 'architect_empty', variants: [], rejected: [] };
  }

  const verdict = await pickFreeformVariant({
    runtime,
    domainId: domain?.id,
    kind: 'beat',
    variants,
    caseText: [
      plotCardForPrompt(plot, { revealHidden: true }),
      plotChronicleForPrompt(domain, plot),
      openStoryTitlesLine(domain, plot?.id),
      '',
      `Дело: ${deed.summary}. Исход: ${finishLabel(deed.finish)}.`,
      'Отсей то, чего вообще не бывает: ломает космологию, хронику этой истории или палит hiddenPremises.',
      'Дальше бери самое любопытное. Не предпочитай ход за то, что он «про этот город» — города у болванок нет.',
      'Не закрывай историю без основания в closeWhen.',
    ]
      .filter(Boolean)
      .join('\n'),
    log,
  });

  let blank = variants[verdict.index];
  if (verdict.repair) {
    blank = await repairFreeformBlank({
      runtime,
      blank,
      repair: verdict.repair,
      kind: 'beat',
      log,
    });
  }

  const builtCfg = cfg || freeformConfig(config);
  let winner = null;
  try {
    winner = await constructBeat({ runtime, domain, world, plot, deed, blank, cfg: builtCfg, log });
  } catch (err) {
    log.warn('freeform.construct_beat_failed', { error: err.message });
  }
  winner = winner || beatCardFromBlank(blank, builtCfg);
  if (!winner) {
    return { ok: false, error: 'constructor_empty', variants, rejected: [] };
  }

  const rejected = packRejectedBlanks(variants, verdict.index);

  return {
    ok: true,
    winner,
    rejected,
    judge: { why: verdict.why, repair: verdict.repair, issues: verdict.issues },
    variants,
  };
}
