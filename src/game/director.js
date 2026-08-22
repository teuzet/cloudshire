import { getLogger, truncate } from '../log.js';
import {
  createPlotline,
  normalizePlotlines,
  formatPlotlinesForPrompt,
  plotlinesConfig,
  listClosureCandidates,
  formatDirectorMetaForPrompt,
  grantAttention,
  clipPlotText,
  PLOT_SUMMARY_MAX,
} from './plotlines.js';
import { chronicleEntries } from './models.js';
import { toolFail } from '../agents/toolResult.js';

function sliceHook(s, max = 120) {
  return String(s || '')
    .trim()
    .slice(0, max);
}

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
  'Задача — интересный переплетающийся сюжет при короткой доске (мало нитей).',
  'ОБЯЗАТЕЛЬНО: затронутые нити → upsert с новым summary + openHook + closeWhen (rolling).',
  'T — котёл прорыва; A (attention) — право жить. bump даёт T и A. complete кандидатов с низким A.',
  'Если мандат НОВОЙ КРОВИ — создай самостоятельную нить по посеву БЕЗ relatedPlotlineIds.',
  'При открытых ≥ softMax — complete хотя бы одну слабую/дублирующую, если есть кандидаты.',
].join(' ');

const PAIR_GUIDANCE = [
  'Общий режиссёр стыка. Обе доски равноправны. domainId на каждом tool.',
  'upsert с summary + openHook + closeWhen; bump за интерес/связку; complete слабые по attention.',
  'Мандат новой крови — самостоятельная нить по посеву без relatedPlotlineIds.',
].join(' ');

/**
 * Режиссёр одного домена (обычный тик).
 * @param {object} [directorMeta] — { spawn, closureCandidates }
 */
export async function runDirector({
  config,
  runtime,
  domain,
  world,
  chronicleAdds = [],
  directorMeta = null,
  log: parentLog,
}) {
  return runDirectorSession({
    config,
    runtime,
    world,
    domains: [domain],
    chronicleByDomain: { [domain.id]: chronicleAdds },
    directorMetaByDomain: directorMeta ? { [domain.id]: directorMeta } : {},
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
  directorMetaByDomain = {},
  conflux = null,
  log: parentLog,
}) {
  return runDirectorSession({
    config,
    runtime,
    world,
    domains,
    chronicleByDomain,
    directorMetaByDomain,
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
  directorMetaByDomain = {},
  mode = 'solo',
  conflux = null,
  log: parentLog,
}) {
  const isPair = mode === 'pair' && domains.length >= 2;
  const plotCfg = plotlinesConfig(config);
  const log = (parentLog || getLogger()).child({
    scope: isPair ? 'director.conflux' : 'director',
    domainIds: domains.map((d) => d.id),
    confluxId: conflux?.id || null,
  });

  for (const d of domains) normalizePlotlines(d);

  const byId = Object.fromEntries(domains.map((d) => [d.id, d]));
  const session = {
    createdIds: new Set(),
    completedIds: new Set(),
    spawnSatisfied: new Set(),
  };

  const metaFor = (domainId) => {
    const d = byId[domainId];
    const raw = directorMetaByDomain[domainId] || {};
    const closureCandidates =
      raw.closureCandidates || listClosureCandidates(d, world.tickIndex, plotCfg);
    const spawn = raw.spawn || null;
    const openCount = d.plotlines.length;
    return {
      spawn,
      closureCandidates,
      softMax: plotCfg.softMax,
      maxOpen: plotCfg.maxOpen,
      openCount,
      boardMeta: formatDirectorMetaForPrompt({
        spawn,
        closureCandidates,
        softMax: plotCfg.softMax,
        maxOpen: plotCfg.maxOpen,
        openCount,
      }),
    };
  };

  const boardSnapshot = () =>
    domains
      .map((d) => {
        const m = metaFor(d.id);
        return (
          `=== «${d.name}» (${d.id}) ===\n${m.boardMeta}\n` +
          `${formatPlotlinesForPrompt(d, world.tickIndex)}`
        );
      })
      .join('\n\n');

  const tools = [
    {
      name: 'read_plot_board',
      description: isPair
        ? 'Доски, мандаты движка, хроника месяца, переписка'
        : 'Плотлайны, мандаты (новая кровь / кандидаты на закрытие), хроника, переписка',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        gameDate: world.gameDate,
        mode: isPair ? 'conflux' : 'solo',
        guidance: isPair ? PAIR_GUIDANCE : SOLO_GUIDANCE,
        domains: domains.map((d) => {
          const m = metaFor(d.id);
          return {
            domainId: d.id,
            name: d.name,
            plotlines: d.plotlines,
            engine: {
              spawnMandate: Boolean(m.spawn?.hit),
              spawnChance: m.spawn?.chance ?? null,
              seedTags: m.spawn?.seeds || [],
              seedText: m.spawn?.seedText || null,
              closureCandidates: m.closureCandidates,
              softMax: m.softMax,
              maxOpen: m.maxOpen,
              openCount: m.openCount,
            },
            boardMeta: m.boardMeta,
            monthChronicle: monthChronicleText(chronicleByDomain[d.id], d),
            tickDialog: dialogSinceLastTick(d),
            activePending: pendingLines(d) || '(нет)',
          };
        }),
        ...(isPair && conflux
          ? {
              conflux: {
                id: conflux.id,
                contact: conflux.contact,
                monthsDocked: conflux.monthsDocked,
                durationMonths: conflux.durationMonths,
              },
            }
          : {}),
      }),
    },
    {
      name: 'upsert_plotline',
      description:
        'Создать/обновить нить. Нужны summary, openHook, closeWhen. T — через bump. ' +
        'Новая кровь по мандату — без relatedPlotlineIds. ' +
        `Тексты режутся жёстко: summary до ${PLOT_SUMMARY_MAX}, крючки до ${plotCfg.hooksMaxLen} символов — ` +
        'укладывайся в бюджет и заканчивай фразу, иначе хвост потеряется.',
      parameters: {
        type: 'object',
        required: isPair
          ? ['domainId', 'title', 'summary', 'openHook', 'closeWhen']
          : ['title', 'summary', 'openHook', 'closeWhen'],
        properties: {
          domainId: { type: 'string' },
          plotlineId: { type: 'string' },
          title: { type: 'string' },
          summary: {
            type: 'string',
            description:
              `Состояние нити целиком, не летопись. Уложись в ${PLOT_SUMMARY_MAX} символов ` +
              'и закончи законченной фразой — обрезанный хвост попадёт в следующий месяц как мусор.',
          },
          openHook: {
            type: 'string',
            description: `Крючок дальше, одна законченная фраза до ${plotCfg.hooksMaxLen} символов.`,
          },
          closeWhen: {
            type: 'string',
            description: `Условие снятия нити, одна законченная фраза до ${plotCfg.hooksMaxLen} символов.`,
          },
          relatedPendingIds: { type: 'array', items: { type: 'string' } },
          relatedPlotlineIds: { type: 'array', items: { type: 'string' } },
          initialTemperature: { type: 'number' },
        },
      },
      handler: async ({
        domainId,
        plotlineId,
        title,
        summary,
        openHook,
        closeWhen,
        relatedPendingIds,
        relatedPlotlineIds,
        initialTemperature,
      }) => {
        const domain = resolveDomain(byId, domainId, domains, isPair);
        if (!domain.ok) return domain;
        const d = domain.domain;
        normalizePlotlines(d);
        const oh = sliceHook(openHook, plotCfg.hooksMaxLen);
        const cw = sliceHook(closeWhen, plotCfg.hooksMaxLen);
        if (oh.length < 3 || cw.length < 3) {
          return toolFail(
            'hooks_required',
            'Нужны openHook и closeWhen (короткие фразы ≥3 символов).',
          );
        }
        const m = metaFor(d.id);

        if (plotlineId) {
          const existing = d.plotlines.find((p) => p.id === plotlineId);
          if (!existing) {
            const ids = d.plotlines.map((p) => `${p.id} «${p.title}»`).join('; ') || '(нет)';
            return toolFail('plotline_not_found', `plotlineId=${plotlineId} не найден. Открытые: ${ids}.`);
          }
          if (title) existing.title = clipPlotText(title, 120);
          if (summary != null) existing.summary = clipPlotText(summary, PLOT_SUMMARY_MAX);
          existing.openHook = oh;
          existing.closeWhen = cw;
          if (relatedPendingIds) existing.relatedPendingIds = relatedPendingIds.map(String);
          if (relatedPlotlineIds) existing.relatedPlotlineIds = relatedPlotlineIds.map(String);
          existing.updatedTick = world.tickIndex;
          return { ok: true, domainId: d.id, plotline: existing, created: false };
        }

        if (d.plotlines.length >= plotCfg.maxOpen) {
          return toolFail(
            'too_many_plotlines',
            `Слишком много плотлайнов (макс ${plotCfg.maxOpen}). complete или сшей старые.`,
          );
        }
        const asNewBlood = Boolean(m.spawn?.hit) && !session.spawnSatisfied.has(d.id);
        if (asNewBlood && relatedPlotlineIds?.length) {
          return toolFail(
            'spawn_must_be_independent',
            'Мандат новой крови: создай нить БЕЗ relatedPlotlineIds.',
          );
        }
        const plot = createPlotline({
          title,
          summary,
          openHook: oh,
          closeWhen: cw,
          temperature: initialTemperature ?? 25,
          attention: plotCfg.attention.initial,
          tick: world.tickIndex,
          relatedPendingIds: asNewBlood ? [] : relatedPendingIds,
          relatedPlotlineIds: asNewBlood ? [] : relatedPlotlineIds,
          seedTags: asNewBlood ? (m.spawn?.seeds || []).map((s) => `${s.groupId}:${s.tagId}`) : [],
        });
        d.plotlines.push(plot);
        session.createdIds.add(plot.id);
        if (asNewBlood) session.spawnSatisfied.add(d.id);
        log.info('director.plot_created', {
          domainId: d.id,
          id: plot.id,
          title: plot.title,
          newBlood: asNewBlood,
        });
        return { ok: true, domainId: d.id, plotline: plot, created: true, newBlood: asNewBlood };
      },
    },
    {
      name: 'bump_temperature',
      description: 'Дельта T (+attention). За интерес в переписке или связку (+5…20).',
      parameters: {
        type: 'object',
        required: isPair ? ['domainId', 'plotlineId', 'delta'] : ['plotlineId', 'delta'],
        properties: {
          domainId: { type: 'string' },
          plotlineId: { type: 'string' },
          delta: { type: 'number' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ domainId, plotlineId, delta, reason }) => {
        const domain = resolveDomain(byId, domainId, domains, isPair);
        if (!domain.ok) return domain;
        const d = domain.domain;
        normalizePlotlines(d);
        const p = d.plotlines.find((x) => x.id === plotlineId);
        if (!p) {
          const ids = d.plotlines.map((x) => `${x.id} «${x.title}»`).join('; ') || '(нет)';
          return toolFail('plotline_not_found', `plotlineId=${plotlineId} не найден. Открытые: ${ids}.`);
        }
        const n = Math.max(-30, Math.min(40, Math.round(Number(delta) || 0)));
        if (n === 0) {
          return toolFail('delta_zero', 'delta=0. Передай заметный шаг (обычно +5…+20).');
        }
        const from = p.temperature;
        p.temperature = Math.max(0, Math.min(100, from + n));
        const attGain = grantAttention(p, Math.abs(n) * (plotCfg.attention.bumpFactor || 1));
        p.updatedTick = world.tickIndex;
        log.info('director.temp_bump', {
          domainId: d.id,
          id: p.id,
          from,
          to: p.temperature,
          delta: n,
          attentionDelta: attGain,
          attention: p.attention,
          reason: truncate(reason, 120),
        });
        return {
          ok: true,
          domainId: d.id,
          plotlineId: p.id,
          from,
          to: p.temperature,
          attention: p.attention,
          reason: reason || null,
        };
      },
    },
    {
      name: 'complete_plotline',
      description: 'Сюжет закрыт или бессмыслен — снять с доски',
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
        if (idx < 0) {
          const ids = d.plotlines.map((x) => `${x.id} «${x.title}»`).join('; ') || '(нет)';
          return toolFail('plotline_not_found', `plotlineId=${plotlineId} не найден. Открытые: ${ids}.`);
        }
        const [removed] = d.plotlines.splice(idx, 1);
        session.completedIds.add(removed.id);
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
      description: 'Завершить ход режиссёра',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string' } },
      },
      handler: async ({ note }) => {
        for (const d of domains) {
          const m = metaFor(d.id);
          if (m.spawn?.hit && !session.spawnSatisfied.has(d.id)) {
            return toolFail(
              'spawn_mandate_unmet',
              `Мандат новой крови для «${d.name}» не выполнен: upsert_plotline по посеву (${m.spawn.seedText}) без relatedPlotlineIds, затем submit_direction.`,
            );
          }
          const stillCandidates = m.closureCandidates.filter((c) =>
            d.plotlines.some((p) => p.id === c.id),
          );
          if (
            d.plotlines.length >= m.softMax &&
            stillCandidates.length > 0 &&
            session.completedIds.size === 0
          ) {
            return toolFail(
              'closure_required',
              `Открытых ≥${m.softMax} и есть кандидаты на закрытие. complete_plotline хотя бы одну: ` +
                stillCandidates.map((c) => `${c.id} «${c.title}»`).join('; '),
            );
          }
        }
        log.info('director.done', {
          note: truncate(note, 240),
          board: boardSnapshot(),
          created: [...session.createdIds],
          completed: [...session.completedIds],
        });
        return { ok: true };
      },
    },
  ];

  const names = domains.map((d) => `«${d.name}»`).join(' и ');
  const userPrompt = [
    isPair
      ? `Общая режиссура стыка ${names} (${world.gameDate?.label || ''}).`
      : `Режиссура месяца ${names} (${world.gameDate?.label || ''}).`,
    'Сначала read_plot_board (engine/boardMeta).',
    'Затронутые → upsert (summary+openHook+closeWhen); интерес → bump; кандидаты → complete.',
    'Мандат новой крови обязателен, если выпал. Затем submit_direction.',
    '',
    boardSnapshot(),
  ].join('\n');

  try {
    await runtime.run({
      agentId: 'director',
      userMessages: [{ role: 'user', content: userPrompt }],
      tools,
      maxTurns: isPair ? 14 : 12,
      toolChoice: { type: 'function', function: { name: 'read_plot_board' } },
      log,
      scene: isPair ? 'director_conflux' : 'director',
      domainId: domains.map((d) => d.id).join('+'),
    });
  } catch (err) {
    log.warn('director.failed', { error: err.message });
  }

  for (const d of domains) {
    normalizePlotlines(d);
    const stale = (d.plotlines || []).filter(
      (p) => p.updatedTick == null || p.updatedTick < (world.tickIndex ?? 0),
    );
    if (stale.length && Object.values(chronicleByDomain).some((a) => a?.length)) {
      log.info('director.stale_plotlines', {
        domainId: d.id,
        tick: world.tickIndex,
        stale: stale.map((p) => ({ id: p.id, title: p.title, updatedTick: p.updatedTick })),
      });
    }
  }
  return domains.map((d) => ({ domainId: d.id, plotlines: d.plotlines }));
}

function resolveDomain(byId, domainId, domains, isPair) {
  if (isPair) {
    if (!domainId || !byId[domainId]) {
      const known = Object.keys(byId).join(', ');
      return toolFail(
        'unknown_domain',
        `domainId обязателен и должен быть одним из: ${known}. Передай верный domainId.`,
      );
    }
    return { ok: true, domain: byId[domainId] };
  }
  return { ok: true, domain: domains[0] };
}
