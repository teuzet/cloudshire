/**
 * Автор нависшей беды.
 *
 * Движок решает, нужна беда или разрешение и какой у неё срок.
 * Автор даёт формулировку и решает, видит ли город эту беду уже сейчас.
 * Плохая концовка уходит как анти-таргет, чтобы не написать её раньше времени.
 */

import { getLogger } from '../log.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { nextObligationRequest, createThreat, attachThreat } from './threats.js';
import { THREAT_SPEC } from './bands.js';

const THREAT_TEXT_MAX = 240;
const THREAT_FINALE_TEXT_MAX = 420;

export function formatThreatRequest(req, plot) {
  const lines = [
    `История: ${plot?.title || ''}`,
    plot?.synopsis ? `Сейчас: ${plot.synopsis}` : '',
    plot?.cause ? `Первопричина: ${plot.cause}` : '',
  ];
  if (req.outcome === 'neutral') {
    lines.push(
      '',
      'НУЖНО РАЗРЕШЕНИЕ, а не беда: город привыкает, вопрос перестаёт быть вопросом.',
      'Не победа покровителя и не поражение. Одно предложение с предметом.',
    );
  } else if (req.finale) {
    lines.push(
      '',
      'ЭТИМ ИСТОРИЯ КОНЧАЕТСЯ. Не очередное ухудшение, а событие, которым город',
      'необратимо лишается того, из-за чего вопрос стоял.',
      req.endingText ? `Концовка, к которой это ведёт: «${req.endingText}».` : '',
      req.endingQuestionGone ? `После неё вопрос снят так: ${req.endingQuestionGone}` : '',
      req.endingNowDifferent ? `И в городе навсегда иначе: ${req.endingNowDifferent}` : '',
      req.woundGuidance || '',
      '',
      'Напиши событие, которое к этому приводит. Саму концовку не переписывай.',
      'Проверь себя: после этого события спорить уже не о чем — предмета спора нет.',
      'Если получилось «стало хуже», «работать тяжелее», «доверие подорвано» — это не то.',
      'Событие происходит сейчас и целиком. Никаких «к зиме», «со временем», «постепенно».',
    );
  } else {
    lines.push(
      '',
      `УДАР: промежуточный. До плохой концовки ещё ${req.remainingPct ?? '—'}%.`,
      req.woundGuidance || '',
      req.antiTarget
        ? `АНТИ-ТАРГЕТ (плохая концовка, до неё доходить НЕЛЬЗЯ): «${req.antiTarget}».`
        : '',
    );
  }
  if (req.outcome !== 'neutral') {
    lines.push('', req.knownUnknown || '');
  }
  if (req.existingThreats?.length) {
    lines.push('', 'УЖЕ ВИСИТ — независимые параллельные часы, не цепочка. Не повторяй и не продолжай:');
    for (const t of req.existingThreats) {
      const vis = t.known === false ? 'скрыта' : 'видна';
      lines.push(`- [${vis}] ${t.text}`);
    }
  }
  if (req.outcome === 'neutral') {
    lines.push('', 'Одно предложение. Срок не называй. Это разрешение город видит.');
  } else {
    lines.push(
      '',
      req.finale ? 'Одно-два предложения. Срок не называй.' : 'Одно предложение. Срок не называй.',
      'Верни known: видит ли город эту беду уже сейчас.',
    );
  }
  return lines.filter(Boolean).join('\n');
}

/** Придумать текст одного обязательства. Возвращает `{ text, known }` или failed. */
export async function draftThreatText({ runtime, domain, plot, request, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'threat.smith', plotId: plot?.id });
  const wantsKnown = request.outcome !== 'neutral';
  const draft = { text: '', known: request.outcome === 'neutral' ? true : null };
  const properties = {
    text: { type: 'string', description: 'Конкретное событие с предметом и людьми.' },
  };
  const required = ['text'];
  if (wantsKnown) {
    properties.known = {
      type: 'boolean',
      description:
        'true, если город уже может назвать эту беду своими словами. false, если она из скрытого слоя или ещё не видна.',
    };
    required.push('known');
  }
  const runOpts = {
    agentId: 'threatSmith',
    tools: [
      {
        name: 'submit_threat',
        description: wantsKnown
          ? 'Событие и видимость: что случится, если покровитель не вмешается, и знает ли об этом город.'
          : 'Одно предложение: что случится, если покровитель не вмешается.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required,
          properties,
        },
        handler: async (args) => {
          const max = request.finale ? THREAT_FINALE_TEXT_MAX : THREAT_TEXT_MAX;
          draft.text = String(args?.text || '').trim().slice(0, max);
          if (wantsKnown && typeof args?.known === 'boolean') draft.known = args.known;
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_threat' } },
    log,
    scene: request.outcome === 'neutral' ? 'threat_resolution' : 'threat_harm',
    domainId: domain?.id,
    userMessages: [{ role: 'user', content: formatThreatRequest(request, plot) }],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('threat.smith_failed', { error: err.message });
  }
  if (!draft.text) return { text: '', known: draft.known, prompt, failed: true };
  return { text: draft.text, known: draft.known, prompt };
}

/**
 * Дозаполнить обязательства истории, спрашивая текст у агента.
 *
 * Без текста обязательство всё равно ставится: история без счётчика перестаёт
 * производить события, а это хуже безымянной беды.
 */
export async function replenishPlotThreats({ runtime, domain, plot, day = 0, rng = Math.random, log } = {}) {
  const created = [];
  let guard = 0;
  while (guard < 4) {
    guard += 1;
    const request = nextObligationRequest(plot, { day, rng });
    if (!request) break;
    const drafted = runtime ? await draftThreatText({ runtime, domain, plot, request, log }) : null;
    const threat = createThreat({
      plot,
      text: drafted?.text || request.antiTarget || request.endingText || plot?.title || '',
      band: request.band,
      outcome: request.outcome,
      slowdown: request.slowdown,
      known: request.outcome === 'neutral' ? true : drafted?.known ?? request.known,
      endingId: request.endingId || null,
      valence: request.finale ? 'bad' : request.outcome === 'neutral' ? 'neutral' : 'bad',
      stage: request.stage,
      remainingPct: request.remainingPct,
      day,
      rng,
    });
    attachThreat(plot, threat);
    created.push(threat);
  }
  return created;
}

export { THREAT_SPEC };
