/**
 * Выбор беды-последствия.
 *
 * Когда провал дела переполняет шкалу, беда выбирается не жребием,
 * а по тому, какое дело только что провалилось.
 */

import { getLogger } from '../log.js';
import { findThreat, liveThreats } from './threats.js';

export function formatThreatPickRequest({ plot, deed, threats }) {
  const lines = [
    `История: ${plot?.title || ''}`,
    plot?.cause ? `Первопричина: ${plot.cause}` : '',
    '',
    `Дело провалилось: ${deed?.summary || ''}`,
    deed?.note ? `Заметка дела: ${deed.note}` : '',
    '',
    'ЖИВЫЕ БЕДЫ:',
  ];
  for (const threat of threats) lines.push(`- ${threat.id}: ${threat.text}`);
  lines.push('', 'Выбери одну, которая правдоподобнее всего выросла из этого провала.');
  return lines.filter((line) => line !== '').join('\n');
}

export async function pickConsequenceThreat({ runtime, domain, plot, deed, log: parentLog } = {}) {
  const threats = liveThreats(plot);
  if (!threats.length) return null;
  if (!runtime || threats.length === 1) return threats[0];
  const log = (parentLog || getLogger()).child({ scope: 'threat.pick', plotId: plot?.id });
  const picked = { id: '' };
  try {
    await runtime.run({
      agentId: 'threatPick',
      tools: [
        {
          name: 'submit_threat',
          description: 'Id беды, которую провал дела приводит в исполнение.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['threatId'],
            properties: {
              threatId: { type: 'string' },
            },
          },
          handler: async (args) => {
            picked.id = String(args?.threatId || '').trim();
            return { ok: true };
          },
        },
      ],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_threat' } },
      log,
      scene: 'threat_pick',
      domainId: domain?.id,
      userMessages: [{ role: 'user', content: formatThreatPickRequest({ plot, deed, threats }) }],
    });
  } catch (err) {
    log.warn('threat.pick_failed', { error: err.message });
  }
  return findThreat(plot, picked.id) || threats[0];
}
