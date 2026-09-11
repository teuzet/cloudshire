/**
 * Дешёвый двоичный судья доверенности: реагировать или нет.
 * Если да — дальше ходит сановник и имеет право ничего не сделать.
 */

import { getLogger } from '../log.js';
import { proxyText } from './cityRules.js';

export const PROXY_TRIGGERS = ['approaching', 'dock', 'plot_tick'];

export function hasProxy(domain) {
  return Boolean(proxyText(domain));
}

/**
 * @returns {Promise<boolean>}
 */
export async function shouldActOnProxy({
  runtime,
  domain,
  trigger,
  context = '',
  log: parentLog,
} = {}) {
  const text = proxyText(domain);
  if (!text || !runtime) return false;
  const kind = PROXY_TRIGGERS.includes(trigger) ? trigger : 'plot_tick';
  const log = (parentLog || getLogger()).child({ scope: 'proxy.judge', domainId: domain?.id, trigger: kind });
  const draft = { act: false };
  try {
    await runtime.run({
      agentId: 'proxyJudge',
      scene: 'proxy_judge',
      domainId: domain?.id,
      log,
      maxTurns: 1,
      toolChoice: { type: 'function', function: { name: 'submit_proxy' } },
      tools: [
        {
          name: 'submit_proxy',
          description: 'Нужно ли сановнику сейчас действовать по доверенности.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['act'],
            properties: { act: { type: 'boolean' } },
          },
          handler: async (args) => {
            draft.act = args?.act === true || args?.act === 'true';
            return { ok: true };
          },
        },
      ],
      extraSystem:
        'Ты решаешь только одно: требует ли доверенность правителя реакции на это событие. ' +
        'Не придумывай дело. Не пересказывай. act=true только если доверенность прямо касается случившегося.',
      userMessages: [
        {
          role: 'user',
          content: [
            `Доверенность: ${text}`,
            `Событие: ${kind}`,
            context ? `Контекст: ${String(context).slice(0, 400)}` : '',
            'Верни submit_proxy.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn?.('proxy.judge_failed', { error: err.message });
    return false;
  }
  log.info('proxy.judge', { act: draft.act });
  return draft.act;
}

const PROXY_PLOT_COOLDOWN_DAYS = 7;

/**
 * Если судья сказал действовать — зовёт сановника. Сановник может ничего не сделать.
 * На ходе нити — короткий кулдаун, чтобы не дёргать каждый тик.
 */
export async function maybeNudgeProxy({
  runtime,
  config,
  world,
  day = 0,
  domains = [],
  trigger,
  context = '',
  rng = Math.random,
  log,
} = {}) {
  if (!runtime) return [];
  const { runOfficerAct } = await import('./steward.js');
  const acted = [];
  for (const domain of domains.filter(Boolean)) {
    if (!hasProxy(domain)) continue;
    if (trigger === 'plot_tick') {
      const last = Number(domain.state?.lastProxyPlotDay);
      if (Number.isFinite(last) && Math.round(Number(day) || 0) - last < PROXY_PLOT_COOLDOWN_DAYS) {
        continue;
      }
    }
    const yes = await shouldActOnProxy({ runtime, domain, trigger, context, log });
    if (!yes) continue;
    const result = await runOfficerAct({
      config,
      runtime,
      domain,
      world,
      day,
      rng,
      log,
      reason: 'proxy',
      proxyTrigger: trigger,
      proxyContext: context,
    });
    if (trigger === 'plot_tick') {
      domain.state = domain.state || {};
      domain.state.lastProxyPlotDay = Math.round(Number(day) || 0);
    }
    acted.push({ domainId: domain.id, act: result?.act || null });
  }
  return acted;
}
