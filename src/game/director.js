import { getLogger, truncate } from '../log.js';
import { createPlotline, normalizePlotlines, formatPlotlinesForPrompt } from './plotlines.js';
import { chronicleEntries } from './models.js';

/**
 * Переписка покровитель↔правитель после последней сводки месяца (рамка текущего тика).
 */
export function dialogSinceLastTick(domain) {
  const hist = domain.characters?.[0]?.dialogHistory || [];
  let start = 0;
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    if (hist[i].kind === 'tick_news') {
      start = i + 1;
      break;
    }
  }
  const slice = hist.slice(start).filter((m) => m.kind !== 'generating' && m.kind !== 'generating_error');
  if (!slice.length) return '(в этом тике переписки не было)';
  return slice
    .map((m) => {
      const who = m.role === 'user' ? 'покровитель' : 'правитель';
      const kind = m.kind && m.kind !== 'tick_news' ? `(${m.kind})` : '';
      return `${who}${kind}: ${String(m.content || '').slice(0, 500)}`;
    })
    .join('\n');
}

function monthChronicleText(chronicleAdds, domain) {
  if (chronicleAdds?.length) {
    return chronicleAdds.map((c) => `- ${c.text}`).join('\n');
  }
  return (
    chronicleEntries(domain.lore || [])
      .slice(-8)
      .map((c) => `- ${c.text}`)
      .join('\n') || '(хроника пуста)'
  );
}

function pendingLines(domain) {
  return (domain.state?.pendingActions || [])
    .filter((a) => a.status === 'active')
    .map((a) => {
      const left = a.monthsLeft ?? Math.max(0, (a.durationMonths || 1) - (a.monthsDone || 0));
      return `- [${a.id}] ${a.summary} (ещё ~${left} мес.)`;
    })
    .join('\n');
}

const SOLO_GUIDANCE = [
  'Задача — сделать сюжет интересным, не забивать доску нитями.',
  'Новый плотлайн — только при явном сюжетном крючке (интерес покровителя, major сдвиг в хронике, живой конфликт). Пустая доска — нормально.',
  'Не обязан ничего создавать. submit_direction без изменений — ок, если крючков нет.',
  'Где логично — связывай нити натурально (общие люди, места, последствия), без роялей в кустах.',
  'Если нить про длительное дело — укажи relatedPendingIds из activePending.',
  'Температура: +heat за тик уже начислен; после ★ПРОРЫВ T=0. bump только за интерес в ПЕРЕПИСКЕ ТИКА или явную связку (+5…20).',
  'После прорыва не копи «за сам прорыв». complete — когда нить закрыта или бессмысленна.',
].join(' ');

const PAIR_GUIDANCE = [
  'Ты — общий режиссёр стыка двух городов. Обе доски равноправны.',
  'Задача — интересный сюжет стыка и городов, не забивать доски.',
  'Новый плотлайн — только при крючке. Не создавай нити «на всякий случай».',
  'Связывай цепочки между городами, где это естественно из хроники/переписки (контакт, обмен, конфликт) — без натянутых совпадений.',
  'relatedPendingIds — если нить опирается на процессы из activePending соответствующего города.',
  'Температура и прорывы — как обычно; bump по переписке ЭТОГО тика каждого покровителя.',
  'upsert/bump/complete всегда с domainId.',
].join(' ');

/**
 * Режиссёр одного домена (обычный тик).
 */
export async function runDirector({
  config,
  runtime,
  domain,
  world,
  chronicleAdds = [],
  log: parentLog,
}) {
  return runDirectorSession({
    config,
    runtime,
    world,
    domains: [domain],
    chronicleByDomain: { [domain.id]: chronicleAdds },
    mode: 'solo',
    log: parentLog,
  });
}

/**
 * Общий режиссёр пары на docked conflux.
 */
export async function runConfluxDirector({
  config,
  runtime,
  domains,
  world,
  chronicleByDomain = {},
  conflux = null,
  log: parentLog,
}) {
  return runDirectorSession({
    config,
    runtime,
    world,
    domains,
    chronicleByDomain,
    mode: 'pair',
    conflux,
    log: parentLog,
  });
}

async function runDirectorSession({
  config,
  runtime,
  world,
  domains,
  chronicleByDomain,
  mode,
  conflux = null,
  log: parentLog,
}) {
  const isPair = mode === 'pair' && domains.length >= 2;
  const log = (parentLog || getLogger()).child({
    scope: isPair ? 'director.conflux' : 'director',
    domainIds: domains.map((d) => d.id),
    confluxId: conflux?.id || null,
  });

  for (const d of domains) normalizePlotlines(d);

  const byId = Object.fromEntries(domains.map((d) => [d.id, d]));

  const boardSnapshot = () =>
    domains
      .map((d) => `=== «${d.name}» (${d.id}) ===\n${formatPlotlinesForPrompt(d)}`)
      .join('\n\n');

  const tools = [
    {
      name: 'read_plot_board',
      description: isPair
        ? 'Доски плотлайнов обоих городов, хроника месяца, переписка тика'
        : 'Плотлайны, хроника месяца, переписка тика с правителем',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const payload = {
          ok: true,
          gameDate: world.gameDate,
          mode: isPair ? 'conflux' : 'solo',
          guidance: isPair ? PAIR_GUIDANCE : SOLO_GUIDANCE,
          domains: domains.map((d) => ({
            domainId: d.id,
            name: d.name,
            plotlines: d.plotlines,
            monthChronicle: monthChronicleText(chronicleByDomain[d.id], d),
            tickDialog: dialogSinceLastTick(d),
            activePending: pendingLines(d) || '(нет)',
          })),
        };
        if (isPair && conflux) {
          payload.conflux = {
            id: conflux.id,
            contact: conflux.contact,
            monthsDocked: conflux.monthsDocked,
            durationMonths: conflux.durationMonths,
          };
        }
        return payload;
      },
    },
    {
      name: 'upsert_plotline',
      description:
        'Создать или обновить плотлайн. Только при сюжетном крючке. temperature — через bump_temperature.',
      parameters: {
        type: 'object',
        required: isPair ? ['domainId', 'title'] : ['title'],
        properties: {
          domainId: {
            type: 'string',
            description: isPair ? 'Id города, чья доска' : 'Игнорируется в solo',
          },
          plotlineId: {
            type: 'string',
            description: 'Существующий id для обновления; без id — новый',
          },
          title: { type: 'string' },
          summary: { type: 'string' },
          relatedPendingIds: { type: 'array', items: { type: 'string' } },
          initialTemperature: {
            type: 'number',
            description: 'Только для НОВОГО: старт 15–35',
          },
        },
      },
      handler: async ({
        domainId,
        plotlineId,
        title,
        summary,
        relatedPendingIds,
        initialTemperature,
      }) => {
        const domain = resolveDomain(byId, domainId, domains, isPair);
        if (!domain.ok) return domain;
        const d = domain.domain;
        normalizePlotlines(d);
        if (plotlineId) {
          const existing = d.plotlines.find((p) => p.id === plotlineId);
          if (!existing) return { ok: false, error: 'plotline not found' };
          if (title) existing.title = String(title).slice(0, 120);
          if (summary != null) existing.summary = String(summary).slice(0, 400);
          if (relatedPendingIds) {
            existing.relatedPendingIds = relatedPendingIds.map(String);
          }
          return { ok: true, domainId: d.id, plotline: existing, created: false };
        }
        if (d.plotlines.length >= 8) {
          return { ok: false, error: 'Слишком много плотлайнов (макс 8). Заверши старые.' };
        }
        const plot = createPlotline({
          title,
          summary,
          temperature: initialTemperature ?? 25,
          tick: world.tickIndex,
          relatedPendingIds,
        });
        d.plotlines.push(plot);
        log.info('director.plot_created', { domainId: d.id, id: plot.id, title: plot.title });
        return { ok: true, domainId: d.id, plotline: plot, created: true };
      },
    },
    {
      name: 'bump_temperature',
      description:
        'Дельта температуры. Копи за интерес в переписке тика или натуральную связку нитей.',
      parameters: {
        type: 'object',
        required: isPair ? ['domainId', 'plotlineId', 'delta'] : ['plotlineId', 'delta'],
        properties: {
          domainId: { type: 'string' },
          plotlineId: { type: 'string' },
          delta: {
            type: 'number',
            description: 'Обычно +5…+20; редко отрицательная',
          },
          reason: { type: 'string' },
        },
      },
      handler: async ({ domainId, plotlineId, delta, reason }) => {
        const domain = resolveDomain(byId, domainId, domains, isPair);
        if (!domain.ok) return domain;
        const d = domain.domain;
        normalizePlotlines(d);
        const p = d.plotlines.find((x) => x.id === plotlineId);
        if (!p) return { ok: false, error: 'plotline not found' };
        const n = Math.max(-30, Math.min(40, Math.round(Number(delta) || 0)));
        if (n === 0) return { ok: false, error: 'delta=0' };
        const from = p.temperature;
        p.temperature = Math.max(0, Math.min(100, from + n));
        log.info('director.temp_bump', {
          domainId: d.id,
          id: p.id,
          from,
          to: p.temperature,
          delta: n,
          reason: truncate(reason, 120),
        });
        return {
          ok: true,
          domainId: d.id,
          plotlineId: p.id,
          from,
          to: p.temperature,
          reason: reason || null,
        };
      },
    },
    {
      name: 'complete_plotline',
      description: 'Сюжет закрыт — удалить с доски',
      parameters: {
        type: 'object',
        required: isPair ? ['domainId', 'plotlineId'] : ['plotlineId'],
        properties: {
          domainId: { type: 'string' },
          plotlineId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ domainId, plotlineId, reason }) => {
        const domain = resolveDomain(byId, domainId, domains, isPair);
        if (!domain.ok) return domain;
        const d = domain.domain;
        normalizePlotlines(d);
        const idx = d.plotlines.findIndex((x) => x.id === plotlineId);
        if (idx < 0) return { ok: false, error: 'plotline not found' };
        const [removed] = d.plotlines.splice(idx, 1);
        log.info('director.plot_completed', {
          domainId: d.id,
          id: removed.id,
          title: removed.title,
          reason: truncate(reason, 160),
        });
        return { ok: true, domainId: d.id, removed: { id: removed.id, title: removed.title } };
      },
    },
    {
      name: 'submit_direction',
      description: 'Завершить ход режиссёра (можно без изменений досок)',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string' },
        },
      },
      handler: async ({ note }) => {
        log.info('director.done', {
          note: truncate(note, 240),
          board: boardSnapshot(),
        });
        return { ok: true };
      },
    },
  ];

  const names = domains.map((d) => `«${d.name}»`).join(' и ');
  const userPrompt = isPair
    ? [
        `Общая режиссура стыка ${names} (${world.gameDate?.label || ''}).`,
        'Сначала read_plot_board.',
        'Крючок → upsert; интерес в переписке тика / связка → bump; закрыто → complete.',
        'Не плоди нити без крючка. Связывай города только натурально. Затем submit_direction.',
        '',
        boardSnapshot(),
      ].join('\n')
    : [
        `Режиссура месяца ${names} (${world.gameDate?.label || ''}).`,
        'Сначала read_plot_board.',
        'Крючок → upsert; интерес в переписке тика / связка → bump; закрыто → complete.',
        'Не обязан создавать нити. Пустая доска ок. Затем submit_direction.',
        '',
        boardSnapshot(),
      ].join('\n');

  try {
    await runtime.run({
      agentId: 'director',
      userMessages: [{ role: 'user', content: userPrompt }],
      tools,
      maxTurns: isPair ? 14 : 10,
      toolChoice: { type: 'function', function: { name: 'read_plot_board' } },
      log,
    });
  } catch (err) {
    log.warn('director.failed', { error: err.message });
  }

  for (const d of domains) normalizePlotlines(d);
  return domains.map((d) => ({ domainId: d.id, plotlines: d.plotlines }));
}

function resolveDomain(byId, domainId, domains, isPair) {
  if (isPair) {
    if (!domainId || !byId[domainId]) {
      return { ok: false, error: 'domainId required / unknown' };
    }
    return { ok: true, domain: byId[domainId] };
  }
  return { ok: true, domain: domains[0] };
}
