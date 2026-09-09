/**
 * Агент разбора нити. Механика вердиктов — в `reconcile.js`; здесь только
 * вызов модели и применение того, что она вернула.
 *
 * Сбой агента означает CONTINUE по всему: молчаливая отмена дел покровителя
 * хуже, чем оставленное лишнее дело.
 */

import { getLogger } from '../log.js';
import { captureAgentPrompt } from './agentPrompt.js';
import {
  DEED_VERDICTS,
  THREAT_VERDICTS,
  reconcileScope,
  reconcileRequest,
  applyDeedVerdict,
  applyThreatVerdict,
  parseDeedVerdict,
  parseThreatVerdict,
} from './reconcile.js';

export function formatReconcilePrompt(req) {
  const lines = [
    `История: ${req.plotTitle}`,
    req.synopsis ? `Сейчас: ${req.synopsis}` : '',
    '',
    `ТОЛЬКО ЧТО РАЗРЕШИЛОСЬ: ${req.resolved.summary}` +
      (req.resolved.finish ? ` (исход: ${req.resolved.finish})` : ''),
  ];
  if (req.deeds.length) {
    lines.push('', 'ОСТАЛЬНЫЕ ДЕЛА НА ЭТОЙ ИСТОРИИ:');
    for (const d of req.deeds) {
      lines.push(`- [${d.id}] ${d.summary}${d.goal ? ` — цель: ${d.goal}` : ''}${d.officer ? ` (${d.officer})` : ''}`);
    }
  }
  if (req.threats.length) {
    lines.push('', 'НАВИСШИЕ БЕДЫ:');
    for (const t of req.threats) lines.push(`- [${t.id}] ${t.text}`);
  }
  lines.push('', 'По каждому пункту ровно один вердикт. CONTINUE — если смысл не потерян.');
  return lines.filter(Boolean).join('\n');
}

export async function reconcilePlot({
  runtime,
  domain,
  plot,
  resolved,
  processes = null,
  day = 0,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'plot.reconcile', plotId: plot?.id });
  const list = processes || domain?.state?.pendingActions || [];
  const scope = reconcileScope({ plot, processes: list, resolvedId: resolved?.id });
  if (!scope.needed) return { applied: [], skipped: 'nothing_to_reconcile' };

  const request = reconcileRequest({ plot, resolved, scope, day });
  const draft = { deeds: [], threats: [] };
  const runOpts = {
    agentId: 'reconciler',
    tools: [
      {
        name: 'submit_reconcile',
        description: 'Вердикты по остальным делам и бедам этой истории.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['deeds', 'threats'],
          properties: {
            deeds: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'verdict'],
                properties: {
                  id: { type: 'string' },
                  verdict: { type: 'string', enum: [...DEED_VERDICTS] },
                  goal: { type: 'string', description: 'Новая цель, если verdict=RETARGET.' },
                  why: { type: 'string' },
                },
              },
            },
            threats: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'verdict'],
                properties: {
                  id: { type: 'string' },
                  verdict: { type: 'string', enum: [...THREAT_VERDICTS] },
                  why: { type: 'string' },
                },
              },
            },
          },
        },
        handler: async (args) => {
          draft.deeds = Array.isArray(args?.deeds) ? args.deeds : [];
          draft.threats = Array.isArray(args?.threats) ? args.threats : [];
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_reconcile' } },
    log,
    scene: 'plot_reconcile',
    domainId: domain?.id,
    userMessages: [{ role: 'user', content: formatReconcilePrompt(request) }],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('plot.reconcile_failed', { error: err.message });
    return { applied: [], prompt, failed: true };
  }

  const applied = [];
  for (const row of draft.deeds) {
    const verdict = parseDeedVerdict(row?.verdict);
    if (verdict === 'CONTINUE') continue;
    const process = scope.deeds.find((d) => String(d.id) === String(row?.id));
    if (!process) continue;
    const res = applyDeedVerdict(process, verdict, {
      day,
      goal: row?.goal || '',
      reason: row?.why || '',
    });
    applied.push({ kind: 'deed', id: process.id, verdict, ...res });
  }
  for (const row of draft.threats) {
    const verdict = parseThreatVerdict(row?.verdict);
    if (verdict === 'CONTINUE') continue;
    if (!scope.threats.some((t) => t.id === row?.id)) continue;
    const res = applyThreatVerdict(plot, row.id, verdict, { day, reason: row?.why || '' });
    applied.push({ kind: 'threat', id: row.id, verdict, ...res });
  }
  log.info('plot.reconcile', { applied: applied.length });
  return { applied, prompt };
}
