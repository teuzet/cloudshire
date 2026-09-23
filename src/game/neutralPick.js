/**
 * Выбор нейтральной концовки.
 *
 * Плохие концовки уже написаны. Когда глубина дотягивает до нейтрального
 * порога, одну из них выбирает агент: самую хорошую из плохих. Она и
 * происходит. Хронисту вид концовки сообщают отдельно.
 */

import { getLogger } from '../log.js';
import { findThreat, liveThreats } from './threats.js';

export function formatNeutralPickRequest({ plot, threats }) {
  const lines = [
    `История: ${plot?.title || ''}`,
    plot?.cause ? `Первопричина: ${plot.cause}` : '',
    plot?.synopsis ? `Как обстояло: ${plot.synopsis}` : '',
    '',
    'ПЛОХИЕ КОНЦОВКИ:',
  ];
  for (const threat of threats) lines.push(`- ${threat.id}: ${threat.text}`);
  lines.push('', 'Выбери самую хорошую из плохих. Она и будет нейтральной концовкой.');
  return lines.filter((line) => line !== '').join('\n');
}

export async function pickNeutralThreat({ runtime, domain, plot, log: parentLog } = {}) {
  const threats = liveThreats(plot);
  if (!threats.length) return null;
  if (!runtime || threats.length === 1) return threats[0];
  const log = (parentLog || getLogger()).child({ scope: 'ending.neutral', plotId: plot?.id });
  const picked = { id: '' };
  try {
    await runtime.run({
      agentId: 'neutralPick',
      tools: [
        {
          name: 'submit_threat',
          description: 'Id плохой концовки, которая сработает как нейтральная.',
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
      scene: 'neutral_pick',
      domainId: domain?.id,
      userMessages: [{ role: 'user', content: formatNeutralPickRequest({ plot, threats }) }],
    });
  } catch (err) {
    log.warn('ending.neutral_pick_failed', { error: err.message });
  }
  return findThreat(plot, picked.id) || threats[0];
}
