/**
 * Автор нависшей беды.
 *
 * Движок решает, нужна беда или разрешение и какой у неё срок.
 * Автор даёт только формулировку. До срока город эту беду не видит.
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
    for (const t of req.existingThreats) lines.push(`- ${t.text}`);
  }
  lines.push(
    '',
    req.outcome === 'neutral' || !req.finale
      ? 'Одно предложение. Срок не называй.'
      : 'Одно-два предложения. Срок не называй.',
  );
  return lines.filter(Boolean).join('\n');
}

/** Придумать текст одного обязательства. Возвращает `{ text }` или failed. */
export async function draftThreatText({ runtime, domain, plot, request, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'threat.smith', plotId: plot?.id });
  const draft = { text: '' };
  const runOpts = {
    agentId: 'threatSmith',
    tools: [
      {
        name: 'submit_threat',
        description: 'Одно предложение: что случится, если покровитель не вмешается.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'Конкретное событие с предметом и людьми.' },
          },
        },
        handler: async (args) => {
          const max = request.finale ? THREAT_FINALE_TEXT_MAX : THREAT_TEXT_MAX;
          draft.text = String(args?.text || '').trim().slice(0, max);
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
  if (!draft.text) return { text: '', prompt, failed: true };
  return { text: draft.text, prompt };
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
