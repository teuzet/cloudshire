/**
 * Оценщик статов. Рассказчики пишут, что случилось; этот агент читает
 * записи месяца и ставит, какие стороны города задеты. Величину считает движок.
 */

import { findPlotline, plotStatForce } from './plotlines.js';
import { resolveStatDeltas } from './plotEngine.js';
import { applyStatDeltasToDomain, statEpithet } from './stats.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

const PLAYER_AUTHORS = new Set([
  'storyteller:echo',
  'storyteller:order',
  'storyteller:order-story',
  'storyteller:order-fallback',
]);

export function sourceForFact(fact) {
  return PLAYER_AUTHORS.has(fact?.author) ? 'player' : 'world';
}

function plotForFact(domain, fact) {
  for (const id of fact?.relatedPlotlineIds || []) {
    const open = findPlotline(domain, id);
    if (open) return open;
  }
  return null;
}

export function factsForStatJudge(chronicleAdds = []) {
  return (chronicleAdds || []).filter((f) => f && f.author !== 'storyteller:quiet');
}

/** Концовка дела/истории задаёт знак следа: crit без минусов, fail без плюсов. */
export function enforceFinishPolarity(deltas, finish) {
  if (!deltas || !finish) return deltas;
  const next = { ...deltas };
  if (finish === 'crit') {
    for (const k of Object.keys(next)) {
      if (next[k] < 0) delete next[k];
    }
  } else if (finish === 'fail') {
    for (const k of Object.keys(next)) {
      if (next[k] > 0) delete next[k];
    }
  }
  return next;
}

/** Тихий месяц и пропуски оценщика больше не двигают статы. */
export function applyFallbackStatDrift() {
  return null;
}

function polarityOf(fact) {
  const f = String(fact?.processFinish || '');
  if (f === 'crit') return 'nonneg';
  if (f === 'fail') return 'nonpos';
  return 'any';
}

function absBudgetForFact(domain, fact, config) {
  if (/order/i.test(String(fact?.author || ''))) return 0;
  if (fact?.author === 'storyteller:quiet') return 0;
  if (fact?.processFinish) {
    const proc = (domain.state?.pendingActions || []).find((a) => a.id === fact.relatedPendingId);
    const months = Math.max(1, Number(proc?.expectedMonths || proc?.durationMonths || 1));
    return months * (Number(config?.tick?.officerStatPerMonth) || 1);
  }
  const plot = plotForFact(domain, fact);
  if (!plot || plot.kind === 'order' || plot.kind === 'errand') return 0;
  const opening = /start/i.test(String(fact.author || ''));
  return plotStatForce(plot, { opening, config });
}

function statsBrief(domain, config) {
  return (config.stats || [])
    .map((def) => {
      const raw = Number(domain.stats?.[def.id]);
      const v = Number.isFinite(raw) ? raw : 50;
      const about = def.about ? ` ${def.about}` : '';
      const when = def.changeWhen ? ` Менять, когда: ${def.changeWhen}` : '';
      return `- ${def.name} (${def.id}): сейчас «${statEpithet(v, config)}».${about}${when}`;
    })
    .join('\n');
}

function entryKind(fact, domain) {
  if (fact.author === 'storyteller:echo') return 'воля покровителя';
  if (
    fact.author === 'storyteller:order' ||
    fact.author === 'storyteller:order-story' ||
    fact.author === 'storyteller:order-fallback'
  ) {
    return 'постоянный порядок покровителя';
  }
  if (fact.author === 'storyteller:quiet') return 'быт';
  if (fact.author === 'storyteller:seed') return 'завязка истории';
  const plot = plotForFact(domain, fact);
  if (plot) return `история «${plot.title}»`;
  const closed = (domain.closedPlotlines || []).find((p) =>
    (fact.relatedPlotlineIds || []).includes(p.id),
  );
  if (closed) return `история «${closed.title}» (кончилась)`;
  return 'запись месяца';
}

/**
 * Проставить след в статах каждой новой записи хроники.
 * @returns {{ scored: number, catastrophe: { title: string, text: string } | null }}
 */
export async function scoreMonthStats({
  config,
  runtime,
  domain,
  world,
  chronicleAdds = [],
  budget = null,
  log: parentLog,
}) {
  if (!chronicleAdds.length) return { scored: 0, catastrophe: null };
  const toScore = factsForStatJudge(chronicleAdds);
  if (!toScore.length) return { scored: 0, catastrophe: null };
  const log = (parentLog || getLogger()).child({ scope: 'statJudge', domainId: domain.id });
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const byId = new Map(toScore.map((f) => [f.id, f]));
  const draft = { entries: null };

  const tools = [
    {
      name: 'submit_stat_marks',
      description:
        'След каждой записи месяца в жизни города. Направление и грубая сила — ты, величину посчитает система.',
      parameters: {
        type: 'object',
        required: ['entries'],
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              required: ['factId', 'affects'],
              properties: {
                factId: { type: 'string', description: 'id записи из списка' },
                affects: {
                  type: 'array',
                  minItems: 1,
                  description:
                    'Какие стороны задеты. Хотя бы одна. ' +
                    `stat — один из: ${statIds}.`,
                  items: {
                    type: 'object',
                    required: ['stat', 'direction'],
                    properties: {
                      stat: { type: 'string' },
                      direction: { type: 'string', enum: ['up', 'down'] },
                      force: { type: 'string', enum: ['slight', 'notable', 'heavy'] },
                    },
                  },
                },
                catastrophe: {
                  type: 'string',
                  description:
                    'Только настоящая катастрофа города: коротко чем именно. ' +
                    'Снимает обычный потолок последствий. Соседская ссора — не катастрофа.',
                },
              },
            },
          },
        },
      },
      handler: async (args) => {
        if (!Array.isArray(args.entries)) return toolFail('empty', 'Нужен массив entries.');
        draft.entries = args.entries;
        return { ok: true };
      },
    },
  ];

  const listing = toScore
    .map((f, i) => {
      const kind = entryKind(f, domain);
      const finish = f.processFinish ? ` исход: ${f.processFinish}` : '';
      return `${i + 1}. id ${f.id} [${kind}]${finish}\n${f.text}`;
    })
    .join('\n\n');

  await runtime.run({
    agentId: 'statJudge',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_stat_marks' } },
    log,
    scene: 'stat_judge',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}».`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Месяц ${world.gameDate.label}. Проставь след каждой записи в сторонах жизни города.`,
          'Оценивай только то, что явно следует из текста: вещи, люди, исход.',
          'Направление и грубую силу называй ты. Насколько сдвинуть — решит система, не ты.',
          'Каждая запись задевает хотя бы одну сторону.',
          'Несколько сторон — только если запись реально про несколько.',
          'Если исход записи crit / [КРИТИЧЕСКИЙ УСПЕХ] — только плюсы, без down.',
          'Если fail / [ПРОВАЛ] — без плюсов, город теряет.',
          'Если ok / [УСПЕХ] — плюсы есть, небольшая негативная побочка обязательна.',
          '',
          'Сейчас в городе:',
          statsBrief(domain, config),
          '',
          'Записи этого месяца:',
          listing,
          '',
          'Вызови submit_stat_marks.',
        ].join('\n'),
      },
    ],
  });

  let scored = 0;
  let catastrophe = null;
  const seen = new Set();

  for (const mark of draft.entries || []) {
    const id = String(mark?.factId || '').trim();
    if (!id || seen.has(id)) continue;
    const fact = byId.get(id);
    if (!fact) continue;
    seen.add(id);

    const note = String(mark.catastrophe || '').trim();
    const absBudget = absBudgetForFact(domain, fact, config);
    if (!absBudget) {
      if (note) {
        fact.importance = 'critical';
        if (!catastrophe) catastrophe = { title: entryKind(fact, domain), text: fact.text, note };
      }
      continue;
    }
    const deltas = enforceFinishPolarity(
      resolveStatDeltas(domain, mark.affects || [], {
        source: sourceForFact(fact),
        config,
        catastrophe: Boolean(note),
        absBudget,
        polarity: polarityOf(fact),
      }),
      fact.processFinish,
    );
    if (!deltas || !Object.keys(deltas).length) {
      if (note) {
        fact.importance = 'critical';
        if (!catastrophe) catastrophe = { title: entryKind(fact, domain), text: fact.text, note };
      }
      continue;
    }

    const changes = applyStatDeltasToDomain(domain, deltas);
    if (Object.keys(changes).length) {
      fact.statChanges = changes;
      scored += 1;
    }
    if (note) {
      fact.importance = 'critical';
      if (!catastrophe) catastrophe = { title: entryKind(fact, domain), text: fact.text, note };
    }
    log.info('statJudge.mark', {
      factId: fact.id,
      author: fact.author,
      deltas,
      catastrophe: note || null,
      preview: truncate(fact.text, 120),
    });
  }

  const fallback = applyFallbackStatDrift({
    domain,
    config,
    chronicleAdds: toScore,
    budget,
    log,
  });
  if (fallback) scored = Math.max(scored, 1);

  log.info('statJudge.done', {
    entries: toScore.length,
    scored,
    catastrophe: catastrophe?.note || null,
    budgetSpent: budget ? { world: budget.spentWorld, player: budget.spentPlayer } : null,
    stats: domain.stats,
  });

  return { scored, catastrophe };
}
