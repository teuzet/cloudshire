/**
 * Автор нависшей беды.
 *
 * Движок решает, нужна беда или разрешение, какой у неё срок и какая тяжесть.
 * Агент даёт только формулировку — и получает плохую концовку как анти-таргет,
 * чтобы не написать её раньше времени.
 */

import { getLogger } from '../log.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { nextObligationRequest, createThreat, attachThreat, SEVERITY_GUIDANCE } from './threats.js';
import { THREAT_SPEC } from './bands.js';

const THREAT_TEXT_MAX = 240;

export function formatThreatRequest(req, plot) {
  const lines = [
    `История: ${plot?.title || ''}`,
    plot?.synopsis ? `Сейчас: ${plot.synopsis}` : '',
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
      'ЭТО ПОСЛЕДНИЙ УДАР: если случится — история закроется плохой концовкой.',
      req.endingText ? `Концовка, к которой это ведёт: «${req.endingText}».` : '',
      'Напиши событие, которое к ней приведёт. Не переписывай саму концовку.',
    );
  } else {
    lines.push(
      '',
      `ПОЛОСА ТЯЖЕСТИ: ${req.severity}`,
      req.severityGuidance || SEVERITY_GUIDANCE[req.severity] || '',
      req.antiTarget
        ? `АНТИ-ТАРГЕТ (плохая концовка, до неё доходить НЕЛЬЗЯ): «${req.antiTarget}».`
        : '',
    );
  }
  if (req.existingThreats?.length) {
    lines.push('', 'УЖЕ ВИСИТ — независимые параллельные часы, не цепочка. Не повторяй и не продолжай:');
    for (const t of req.existingThreats) lines.push(`- ${t.text}`);
  }
  lines.push('', 'Одно предложение. Срок не называй.');
  return lines.filter(Boolean).join('\n');
}

/** Придумать текст одного обязательства. Возвращает `{ text }` или null. */
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
          draft.text = String(args?.text || '').trim().slice(0, THREAT_TEXT_MAX);
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
      known: request.known === true || request.outcome === 'neutral' ? true : null,
      endingId: request.endingId || null,
      valence: request.finale ? 'bad' : request.outcome === 'neutral' ? 'neutral' : 'bad',
      day,
      rng,
    });
    attachThreat(plot, threat);
    created.push(threat);
  }
  return created;
}

export { THREAT_SPEC };
