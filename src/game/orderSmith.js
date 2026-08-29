/**
 * Агент порядка: по заявке правителя собирает карточку указа
 * (каденс, расписание, синопсис, closeWhen). Не пишет хронику.
 */

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
import { closeOrderPair, findStandingOrder, normalizeOrders, stampOrderTerm } from './orders.js';
import { formatCityForAgents } from './cityContext.js';

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
    fireOn: null,
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

function applyCardToPlot(plot, card, { tick, cfg }) {
  plot.title = clipPlotText(card.title || plot.title, PLOT_TITLE_MAX);
  plot.synopsis = clipPlotText(card.synopsis || plot.synopsis, PLOT_SUMMARY_MAX);
  plot.closeWhen = clipPlotText(card.closeWhen || plot.closeWhen, PLOT_HOOK_MAX);
  const fireOn = String(card.fireOn || '').trim() === 'conflux_dock' ? 'conflux_dock' : null;
  plot.fireOn = fireOn;
  if (fireOn) {
    plot.scheduleEveryMonths = null;
    plot.fireChance = 0;
    plot.nextDueTick = null;
  } else {
    const every = Math.round(Number(card.scheduleEveryMonths) || 0);
    plot.scheduleEveryMonths = every >= 1 && every <= 12 ? every : null;
    plot.fireChance = plot.scheduleEveryMonths
      ? 0
      : clampChance(card.fireChance, cfg.orders.defaultChance);
    if (card.dueNow) plot.nextDueTick = tick;
    else if (plot.scheduleEveryMonths && plot.nextDueTick == null) {
      plot.nextDueTick = Number(tick) + plot.scheduleEveryMonths;
    }
  }
  if (Array.isArray(card.relatedStats) && card.relatedStats.length) {
    plot.relatedStats = card.relatedStats.map(String);
  }
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
            description:
              '0–1. Шанс, что в обычный месяц этот порядок породит отдельное ЗАМЕТНОЕ событие, достойное хроники. ' +
              'Это не частота применения самого закона. Тихий налог ≈ 0.05–0.15; конфликтный жёсткий порядок ≈ 0.36–0.70. ' +
              'Если fireOn=conflux_dock — поставь 0.',
          },
          scheduleEveryMonths: {
            type: 'number',
            description:
              'Каждые N месяцев попытка обязательна (1–12). 0 — только по вероятности, без расписания. ' +
              'Если fireOn=conflux_dock — поставь 0.',
          },
          fireOn: {
            type: 'string',
            enum: ['conflux_dock'],
            description:
              'conflux_dock — правило срабатывает при сопряжении с соседним островом, не по календарю. ' +
              'Только если формулировка явно про каждую встречу/сопряжение/когда сойдёмся.',
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
    extraSystem: `Город «${domain.name}».\n${formatCityForAgents(domain)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `${verb} (${world.gameDate?.label || 'этот месяц'}).`,
          `Формулировка: ${req.text}`,
          req.action === 'edit' ? 'Это правка уже действующего порядка: обнови синопсис и каденс под новую норму.' : null,
          req.durationSet
            ? req.durationMonths
              ? `Срок действия задан покровителем: ${req.durationMonths} мес., затем движок снимет порядок сам. closeWhen — досрочная отмена, не истечение срока.`
              : 'Покровитель хочет бессрочный порядок. Срок не ставь.'
            : 'Срок не задан — порядок бессрочный, пока не отменят. Срок сам не выдумывай.',
          'Ты не пишешь хронику. Ты ставишь, как часто город будет сталкиваться с ЗАМЕТНЫМИ последствиями этого правила,',
          'и что должно произойти, чтобы правило сняли.',
          'Расписание — если из формулировки ясно «каждый N-й месяц / каждую весну / раз в два месяца».',
          'fireOn=conflux_dock — если правило срабатывает при сопряжении с соседним островом',
          '(при каждой встрече, когда сойдёмся, на каждый конфлюкс). Тогда scheduleEveryMonths=0 и fireChance=0.',
          'Не ставь conflux_dock на обычный закон, который просто может коснуться соседа.',
          'Иначе scheduleEveryMonths=0 и fireChance как частота заметного события, не частота применения закона.',
          'Тихий рутинный налог — редко; жестокий конфликтный указ — чаще. Важность правила сама по себе fireChance не повышает.',
          'dueNow=true, если порядок уже должен дать след в этом месяце (роль занята с сегодня, налог с этого сбора).',
          'Для fireOn=conflux_dock dueNow не нужен: движок сам стреляет, когда острова сойдутся, в том числе в текущую встречу.',
          'closeWhen — когда снимут сам порядок, не когда кончится история, которая из него может вырасти.',
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
    orderText: text,
    relatedStats: card.relatedStats,
    fireChance: card.fireChance,
    scheduleEveryMonths: card.scheduleEveryMonths,
    fireOn: card.fireOn || null,
    nextDueTick: card.dueNow ? tick : null,
    tick,
    config,
  });
  applyCardToPlot(plot, card, { tick, cfg });
  plot.orderText = text;
  domain.plotlines = domain.plotlines || [];
  domain.plotlines.push(plot);
  if (req.durationSet) stampOrderTerm(plot, null, { months: req.durationMonths, tick });
  else stampOrderTerm(plot, null, { months: null, tick });
  return { plot };
}

function applyEdit(domain, req, card, { tick, cfg, config }) {
  const found = findStandingOrder(domain, req.orderId);
  let plot = found ? findPlotline(domain, found.id) : findPlotline(domain, req.orderId);
  if (!plot) {
    plot = (domain.plotlines || []).find(
      (p) => p.kind === 'order' && (p.id === req.orderId || p.modifierId === req.orderId),
    );
  }
  if (!plot) return applyCreate(domain, { ...req, action: 'create' }, card, { tick, cfg, config });
  const text = String(card.modifierText || req.text || plot.orderText || '').trim();
  plot.orderText = text;
  applyCardToPlot(plot, card, { tick, cfg });
  if (req.durationSet) stampOrderTerm(plot, null, { months: req.durationMonths, tick });
  return { plot };
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
          fireChance: applied.plot?.fireChance,
          scheduleEveryMonths: applied.plot?.scheduleEveryMonths,
          fireOn: applied.plot?.fireOn || null,
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
