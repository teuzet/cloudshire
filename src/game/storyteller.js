/**
 * Посев городской истории и сжатие синопсиса после события.
 * Живой посев — plantStakedStory. Синопсис — keepStories / keepSharedStories.
 */

import { worldDateLabel } from './gameClock.js';
import { chronicleEntries, castRecords, formatChroniclePriestMark } from './models.js';
import {
  findPlotline,
  clipPlotText,
  isStakedStory,
  formatCloseWhen,
  formatFreeformEndings,
  defaultFreeformMaxDepth,
  maxFailsForGravity,
  PLOT_SUMMARY_MAX,
} from './plotlines.js';
import { sharedPlots } from './confluxBoard.js';
import { brainstormFreeformPack, shouldRequireSeedMystery } from './freeformBrainstorm.js';
import { assembleFreeformLabStory } from './freeformAssemble.js';
import { writePlotSeedDump } from './seedDump.js';
import { createFreeformPlot, appendChronicle, openStoryTitlesLine, chronicleBudget } from './freeform.js';
import { refreshFreeformEndings } from './freeformEndings.js';
import { setFreeformUrgency } from './freeformUrgency.js';
import { voidGrainPack } from './seedChannels.js';
import { getLogger } from '../log.js';

const PRIOR_CHRONICLE_LIMIT = 30;
const WATCH_RE = /розыск|задерж|пойм|арест|угроз|подозрева|разыск/i;

export function voidSeedPackArgs(domain, { config, rng = Math.random } = {}) {
  return voidGrainPack(domain, { config, rng });
}

export function pickLiveVoidGravity(rng = Math.random) {
  return rng() < 0.5 ? 'SITUATION' : 'EPISODE';
}

export async function plantStakedStory({
  config,
  runtime,
  domain,
  world,
  seedText,
  gravity,
  fromVoid = false,
  fromGenesis = false,
  requireMystery,
  rng = Math.random,
  day = null,
  log,
}) {
  const wantMystery = shouldRequireSeedMystery(config, { requireMystery, rng });
  const request = {
    seedText,
    gravity,
    fromVoid: Boolean(fromVoid) && !fromGenesis,
    fromGenesis: Boolean(fromGenesis) && !fromVoid,
    requireMystery: wantMystery,
  };
  let drafted = null;
  try {
    drafted = await brainstormFreeformPack({
      config,
      runtime,
      seedText,
      gravity,
      fromVoid: request.fromVoid,
      fromGenesis: request.fromGenesis,
      requireMystery: wantMystery,
      note: openStoryTitlesLine(domain),
      log,
      domainId: domain?.id,
    });
    if (!drafted?.winner) {
      log.warn('storyteller.opening_failed', { gravity, error: 'no_winner', fromVoid, fromGenesis });
      await writePlotSeedDump({ domain, request, pack: drafted, outcome: 'no_winner' }, config);
      return null;
    }
    const assembled = await assembleFreeformLabStory({
      config,
      runtime,
      domain,
      world,
      candidate: drafted.winner,
      gravity,
      requireMystery: wantMystery,
      log,
    });
    const plot = createFreeformPlot({
      domain,
      world,
      variant: assembled,
      config,
    });
    const chronicleText = assembled.chronicle || drafted.winner.chronicle || drafted.winner.text;
    const fact = chronicleText
      ? appendChronicle(domain, world, {
          text: chronicleText,
          plotId: plot.id,
          author: 'freeform:seed',
          day,
          maxChars: chronicleBudget(config, 'seed'),
        })
      : null;
    await refreshFreeformEndings({ runtime, domain, plot, config, log });
    await setFreeformUrgency({ runtime, domain, plot, log });
    await writePlotSeedDump(
      {
        domain,
        request,
        pack: drafted,
        assembled: { title: assembled?.title || '', chronicle: assembled?.chronicle || chronicleText || '' },
        plot: { id: plot.id, title: plot.title },
        outcome: 'planted',
      },
      config,
    );
    return { plot, fact, requireMystery: wantMystery };
  } catch (err) {
    await writePlotSeedDump(
      { domain, request, pack: drafted, outcome: 'error', error: err.message },
      config,
    );
    throw err;
  }
}

export function priorPlotChronicle(domain, plot, limit = PRIOR_CHRONICLE_LIMIT) {
  if (!plot) return [];
  const ids = new Set((plot.chronicleIds || []).map(String));
  return chronicleEntries(domain?.lore)
    .filter((e) => ids.has(String(e.id)) || (e.relatedPlotlineIds || []).includes(plot.id))
    .sort((a, b) => (Number(a.tick) || 0) - (Number(b.tick) || 0))
    .slice(-limit)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${e.text}${formatChroniclePriestMark(e)}`);
}

/** Имя в поручении может стоять в падеже: Левра / Левры / Иару. */
function nameMentioned(text, name) {
  const blob = String(text || '').toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  if (!n || n.length < 2) return false;
  if (blob.includes(n)) return true;
  const stem = n.replace(/[аяуюиеыоь]+$/u, '');
  return stem.length >= 3 && blob.includes(stem);
}

/** Кого сейчас ищут или держат — им нельзя отдавать бумаги и доверие города. */
export function peopleUnderWatch(domain) {
  const procs = (domain?.state?.pendingActions || []).filter((p) => !p.status || p.status === 'active');
  if (!procs.length) return [];
  const hits = [];
  const seen = new Set();
  for (const c of castRecords(domain?.lore)) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    for (const p of procs) {
      const blob = `${p.summary || ''} ${p.detail || ''}`;
      if (!nameMentioned(blob, name)) continue;
      if (!WATCH_RE.test(blob)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ name, process: p.summary || p.detail || '' });
    }
  }
  return hits;
}

/** Очередной поворот нити: окраска уже брошена движком. */
export function formatKeepPlotBlock(plot, freshLines = []) {
  const staked = isStakedStory(plot);
  const lines = [`id ${plot.id} — «${plot.title}»`, `Сейчас: ${plot.synopsis || 'только началась'}`];

  if (staked) {
    const endings = formatFreeformEndings(plot);
    if (endings) {
      lines.push('ВОЗМОЖНЫЕ ИСХОДЫ (варианты будущего, ни один ещё не наступил):', endings);
    }
    const depth = Math.round((Number(plot.depth) || 0) * 100) / 100;
    const maxDepth = Number(plot.maxDepth) || defaultFreeformMaxDepth(plot.gravity);
    const fails = Math.max(0, Math.round(Number(plot.failCount) || 0));
    const maxFails = plot.maxFails == null ? maxFailsForGravity(plot.gravity) : Number(plot.maxFails);
    lines.push(
      plot.status === 'closed'
        ? 'История ЗАКРЫТА: её развязка уже в свежих записях.'
        : `История ОТКРЫТА и не разрешена: пройдено ${depth} из ${maxDepth}, промахов ${fails} из ${maxFails}.`,
    );
  } else {
    const close = formatCloseWhen(plot);
    if (close && close !== '—') lines.push(`Успешный исход: ${close}`);
    if (plot.mootWhen) lines.push(`Теряет смысл, когда: ${plot.mootWhen}`);
  }

  lines.push(freshLines.length ? `Свежие записи:\n${freshLines.join('\n')}` : 'Свежих записей у неё нет.');
  return lines.join('\n');
}

/**
 * Обновить синопсисы по свежей хронике.
 * Reducer: ничего нового не придумывает. Ставки и интерес — не его работа.
 */
async function runStoryKeep({
  agentId,
  scene,
  board,
  plots,
  chronicleAdds = [],
  extraSystem,
  userLead,
  runtime,
  world,
  log,
  domainId,
}) {
  if (!plots.length) return null;
  const draft = { plots: null };
  const tools = [
    {
      name: 'submit_story_keep',
      description: 'Обновлённые синопсисы. Только сжатие уже установленного. Новую хронику не пиши.',
      parameters: {
        type: 'object',
        required: ['plots'],
        properties: {
          plots: {
            type: 'array',
            description: 'Только те истории, чей синопсис реально изменился. Пустой массив, если ничего не сдвинулось.',
            items: {
              type: 'object',
              required: ['plotId', 'synopsis'],
              properties: {
                plotId: { type: 'string' },
                synopsis: {
                  type: 'string',
                  description:
                    `Сжатие уже установленного, до ${PLOT_SUMMARY_MAX} символов. ` +
                    'Сначала что уже произошло, затем как ситуация выглядит сейчас. Без прогноза и нового мотива. ' +
                    'Без «Год N, месяц M», «в месяц 5» и прочих нумерованных дат.',
                },
              },
            },
          },
        },
      },
      handler: async (args) => {
        draft.plots = Array.isArray(args.plots) ? args.plots : [];
        return { ok: true };
      },
    },
  ];

  const byPlot = new Map(plots.map((p) => [p.id, []]));
  const otherLines = [];
  for (const fact of chronicleAdds) {
    const ids = fact.relatedPlotlineIds || [];
    const line = `- ${fact.text}`;
    if (!ids.length) {
      otherLines.push(line);
      continue;
    }
    let linked = false;
    for (const id of ids) {
      if (byPlot.has(id)) {
        byPlot.get(id).push(line);
        linked = true;
      }
    }
    if (!linked) otherLines.push(line);
  }

  const plotBlocks = plots.map((p) => formatKeepPlotBlock(p, byPlot.get(p.id) || [])).join('\n\n');

  await runtime.run({
    agentId,
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_story_keep' } },
    log,
    scene,
    domainId,
    extraSystem,
    userMessages: [
      {
        role: 'user',
        content: [
          ...userLead,
          'Ничего нового в историю не добавляй: ни будущего, ни мотива, ни скрытого смысла.',
          'Синопсис — только сжатие уже установленного: сначала что произошло за всё время, затем как ситуация выглядит сейчас.',
          'Не датируй календарём: не пиши «Год 3, месяц 6», «в месяц 5», номера лет и месяцев. Перескажи сюжет.',
          'Если уместно, одной фразой назови, что остаётся нерешённым — только если это уже следует из самой истории.',
          'Не пиши, куда история может пойти. Не прогнозируй сюжет.',
          'Для тайны: не раскрывай скрытый канон, если его ещё нет в хронике. Не достраивай разгадку из догадок.',
          'ВОЗМОЖНЫЕ ИСХОДЫ — это варианты будущего. Пока история помечена открытой, ни один не наступил:',
          'не пиши в синопсисе, что вопрос решён, беда ушла или город успокоился.',
          'Развязка из хроники (нашли, умер, под стражей, в бегах) должна остаться в синопсисе.',
          'Если у истории не было новой записи и картина не сдвинулась — не включай её.',
          'Новую хронику не пиши. Вызови submit_story_keep.',
          '',
          'Открытые истории:',
          plotBlocks,
          null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  let updated = 0;
  for (const item of draft.plots || []) {
    const plot = findPlotline(board, item.plotId);
    if (!plot) continue;
    const next = clipPlotText(item.synopsis, PLOT_SUMMARY_MAX);
    if (!next) continue;
    plot.synopsis = next;
    updated += 1;
  }

  log.info(`${scene}.done`, { plots: plots.length, updated });
  return { updated };
}

export async function keepStories({
  config,
  runtime,
  domain,
  world,
  chronicleAdds = [],
  plots: onlyPlots = null,
  log: parentLog,
}) {
  const requested = Array.isArray(onlyPlots) ? onlyPlots : null;
  const plots = (requested || domain.plotlines || []).filter(Boolean);
  if (!plots.length) return null;
  const keepIds = new Set(plots.map((p) => p.id));
  chronicleAdds = (chronicleAdds || []).filter((f) =>
    (f.relatedPlotlineIds || []).some((id) => keepIds.has(id)),
  );
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.keep', domainId: domain.id });
  return runStoryKeep({
    agentId: 'storyKeep',
    scene: 'story_keep',
    board: domain,
    plots,
    chronicleAdds,
    extraSystem: `Город «${domain.name}».`,
    userLead: [
      `Сейчас ${world?.gameDate?.label || worldDateLabel(world)}.` +
        ' Обнови карточки открытых историй этого города.',
    ],
    runtime,
    world,
    log,
    domainId: domain.id,
  });
}

/** Синопсисы общих нитей сопряжения. После события пары, не вместо него. */
export async function keepSharedStories({
  runtime,
  conflux,
  domains = [],
  world,
  chronicleAdds = [],
  log: parentLog,
}) {
  const plots = sharedPlots(conflux);
  if (!plots.length) return null;
  const log = (parentLog || getLogger()).child({ scope: 'conflux.keep', confluxId: conflux.id });
  const names = (domains || []).map((d) => `«${d.name}»`).join(' и ');
  return runStoryKeep({
    agentId: 'confluxStoryKeep',
    scene: 'conflux_story_keep',
    board: conflux,
    plots,
    chronicleAdds,
    extraSystem: [
      names ? `Города: ${names}.` : 'История на сопряжении двух островов.',
      'Оба берега равноправны. Не суди, кто прав, и не пиши письмо одного правителя.',
    ].join(' '),
    userLead: [
      world?.gameDate?.label ? `Сейчас ${world.gameDate.label}.` : '',
      names ? `Обнови карточки общих историй ${names}.` : 'Обнови карточки общих историй, пока острова вместе.',
      'Синопсис общий для обоих городов: назови оба, если событие задело оба.',
    ].filter(Boolean),
    runtime,
    world,
    log,
    domainId: (conflux.domainIds || []).join('+'),
  });
}
