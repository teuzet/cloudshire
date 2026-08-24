/**
 * Агент порядка: по заявке правителя собирает карточку указа
 * (каденс, расписание, синопсис, closeWhen). Не пишет хронику.
 */

import { newId } from './ids.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import {
  createPlotline,
  findPlotline,
  clipPlotText,
  PLOT_SUMMARY_MAX,
  PLOT_HOOK_MAX,
  PLOT_TITLE_MAX,
  plotConfig,
} from './plotlines.js';
import { closeOrderPair, normalizeOrders } from './orders.js';

function cityBrief(domain, max = 600) {
  const text = String(domain.description || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || '(описание пусто)';
}

function titleFromText(text) {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(' ');
  return clipPlotText(words || 'Городской порядок', PLOT_TITLE_MAX);
}

function fallbackCard(req, cfg) {
  const text = String(req.text || '').trim();
  return {
    title: titleFromText(text),
    synopsis: clipPlotText(`В городе действует порядок: ${text}`, PLOT_SUMMARY_MAX),
    closeWhen: clipPlotText('Покровитель отменил порядок или город его сверг.', PLOT_HOOK_MAX),
    fireChance: cfg.orders.defaultChance,
    scheduleEveryMonths: 0,
    dueNow: false,
    relatedStats: [],
    modifierText: text,
  };
}

function clampChance(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function applyCardToPlot(plot, card, { tick, cfg, modifierId }) {
  plot.title = clipPlotText(card.title || plot.title, PLOT_TITLE_MAX);
  plot.synopsis = clipPlotText(card.synopsis || plot.synopsis, PLOT_SUMMARY_MAX);
  plot.closeWhen = clipPlotText(card.closeWhen || plot.closeWhen, PLOT_HOOK_MAX);
  const every = Math.round(Number(card.scheduleEveryMonths) || 0);
  plot.scheduleEveryMonths = every >= 1 && every <= 12 ? every : null;
  plot.fireChance = plot.scheduleEveryMonths
    ? 0
    : clampChance(card.fireChance, cfg.orders.defaultChance);
  plot.modifierId = modifierId || plot.modifierId || null;
  if (card.dueNow) plot.nextDueTick = tick;
  else if (plot.scheduleEveryMonths && plot.nextDueTick == null) {
    plot.nextDueTick = Number(tick) + plot.scheduleEveryMonths;
  }
  if (Array.isArray(card.relatedStats) && card.relatedStats.length) {
    plot.relatedStats = card.relatedStats.map(String);
  }
}

function upsertModifier(domain, { id = null, text, plotId, by, initiative, tick }) {
  if (!domain.state.modifiers) domain.state.modifiers = [];
  let mod = id ? domain.state.modifiers.find((m) => m.id === id) : null;
  if (!mod) {
    mod = {
      id: newId('mod'),
      text,
      kind: 'order',
      since: new Date().toISOString(),
      declaredTick: tick,
      updatedAt: new Date().toISOString(),
      by,
      initiative,
      plotlineId: plotId,
    };
    domain.state.modifiers.push(mod);
    return mod;
  }
  mod.text = text;
  mod.kind = 'order';
  mod.updatedAt = new Date().toISOString();
  mod.plotlineId = plotId || mod.plotlineId;
  return mod;
}

async function askOrderCard({ runtime, domain, world, req, log, cfg, statIds }) {
  const draft = { data: null };
  const tools = [
    {
      name: 'submit_order_card',
      description: 'Карточка постоянного порядка: как он живёт и когда о нём писать.',
      parameters: {
        type: 'object',
        required: ['title', 'synopsis', 'closeWhen', 'fireChance'],
        properties: {
          title: { type: 'string', description: 'Название порядка, 1–4 слова' },
          synopsis: {
            type: 'string',
            description: `Как этот порядок сейчас устроен в городе, до ${PLOT_SUMMARY_MAX} символов.`,
          },
          closeWhen: {
            type: 'string',
            description: `Что должно случиться, чтобы порядок сняли. До ${PLOT_HOOK_MAX} символов.`,
          },
          fireChance: {
            type: 'number',
            description: '0–1. Шанс, что в обычный месяц порядок даст запись или историю.',
          },
          scheduleEveryMonths: {
            type: 'number',
            description:
              'Каждые N месяцев попытка обязательна (1–12). 0 — только по вероятности, без расписания.',
          },
          dueNow: {
            type: 'boolean',
            description: 'true, если порядок должен попытаться сработать уже в этом месяце.',
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: statIds ? `1–3 из: ${statIds}` : 'стороны жизни города',
          },
          modifierText: {
            type: 'string',
            description: 'Краткая формулировка правила, как его знает город.',
          },
        },
      },
      handler: async (args) => {
        if (!String(args.title || '').trim() || !String(args.synopsis || '').trim()) {
          return toolFail('empty', 'Нужны название и синопсис.');
        }
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const verb =
    req.action === 'edit' ? 'Порядок меняют' : req.action === 'adopt' ? 'Порядок уже объявлен, нужна карточка' : 'Новый постоянный порядок';

  await runtime.run({
    agentId: 'orderSmith',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_order_card' } },
    log,
    scene: 'order_smith',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}».\n${cityBrief(domain)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `${verb} (${world.gameDate?.label || 'этот месяц'}).`,
          `Формулировка: ${req.text}`,
          req.action === 'edit' ? 'Это правка уже действующего порядка: обнови синопсис и каденс под новую норму.' : null,
          'Ты не пишешь хронику. Ты ставишь, как часто город будет сталкиваться с последствиями этого правила,',
          'и что должно произойти, чтобы правило сняли.',
          'Расписание — если из формулировки ясно «каждый N-й месяц / каждую весну / раз в два месяца».',
          'Иначе scheduleEveryMonths=0 и живой fireChance (тихий налог — реже, жестокий указ — чаще).',
          'dueNow=true, если порядок уже должен дать след в этом месяце (роль занята с сегодня, налог с этого сбора).',
          'Вызови submit_order_card.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  return draft.data || fallbackCard(req, cfg);
}

function applyCreate(domain, req, card, { tick, cfg, config }) {
  const text = String(card.modifierText || req.text || '').trim();
  const plot = createPlotline({
    title: card.title,
    synopsis: card.synopsis,
    closeWhen: card.closeWhen,
    kind: 'order',
    relatedStats: card.relatedStats,
    fireChance: card.fireChance,
    scheduleEveryMonths: card.scheduleEveryMonths,
    nextDueTick: card.dueNow ? tick : null,
    tick,
    config,
  });
  applyCardToPlot(plot, card, { tick, cfg, modifierId: null });
  domain.plotlines = domain.plotlines || [];
  domain.plotlines.push(plot);
  const mod = upsertModifier(domain, {
    id: req.orderId,
    text,
    plotId: plot.id,
    by: req.by,
    initiative: req.initiative || 'patron',
    tick,
  });
  plot.modifierId = mod.id;
  mod.plotlineId = plot.id;
  return { plot, modifier: mod };
}

function applyEdit(domain, req, card, { tick, cfg, config }) {
  const mod = (domain.state.modifiers || []).find((m) => m.id === req.orderId);
  if (!mod) return applyCreate(domain, { ...req, action: 'create' }, card, { tick, cfg, config });
  const text = String(card.modifierText || req.text || mod.text).trim();
  mod.text = text;
  mod.updatedAt = new Date().toISOString();
  let plot = mod.plotlineId ? findPlotline(domain, mod.plotlineId) : null;
  if (!plot) {
    plot = (domain.plotlines || []).find((p) => p.kind === 'order' && p.modifierId === mod.id);
  }
  if (!plot) {
    return applyCreate(domain, { ...req, action: 'create', orderId: mod.id }, card, { tick, cfg, config });
  }
  applyCardToPlot(plot, card, { tick, cfg, modifierId: mod.id });
  mod.plotlineId = plot.id;
  return { plot, modifier: mod };
}

/**
 * Разбор очереди заявок. Агент падает — карточка всё равно появляется с каденсом по умолчанию.
 */
export async function resolvePendingOrders({ config, runtime, domain, world, log: parentLog }) {
  normalizeOrders(domain);
  const queue = domain.state.pendingOrderRequests || [];
  if (!queue.length) return [];

  const log = (parentLog || getLogger()).child({ scope: 'orderSmith', domainId: domain.id });
  const cfg = plotConfig(config);
  const statIds = (config?.stats || []).map((s) => s.id).join(', ');
  const tick = world?.tickIndex ?? null;
  const results = [];

  while (queue.length) {
    const req = queue[0];
    try {
      if (req.action === 'revoke') {
        const closed = closeOrderPair(domain, {
          modifierId: req.orderId,
          tick,
          reason: req.reason || 'отменён по воле покровителя',
        });
        results.push({ action: 'revoke', request: req, ...closed });
        log.info('order.revoked', { orderId: req.orderId, text: req.text });
      } else {
        let card = fallbackCard(req, cfg);
        if (runtime) {
          try {
            card = await askOrderCard({ runtime, domain, world, req, log, cfg, statIds });
          } catch (err) {
            log.warn('order.smith_failed', { error: err.message, action: req.action });
          }
        }
        const applied =
          req.action === 'edit'
            ? applyEdit(domain, req, card, { tick, cfg, config })
            : applyCreate(domain, req, card, { tick, cfg, config });
        results.push({ action: req.action, request: req, ...applied });
        log.info('order.card', {
          action: req.action,
          plotId: applied.plot?.id,
          modifierId: applied.modifier?.id,
          fireChance: applied.plot?.fireChance,
          scheduleEveryMonths: applied.plot?.scheduleEveryMonths,
          dueNow: applied.plot?.nextDueTick === tick,
        });
      }
    } catch (err) {
      log.warn('order.request_failed', { error: err.message, action: req.action });
    }
    queue.shift();
  }

  return results;
}
