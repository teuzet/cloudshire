/**
 * Оценщик статов. Рассказчики пишут, что случилось; этот агент читает
 * записи месяца и ставит, какие стороны города задеты. Величину считает движок.
 */

import { findPlotline } from './plotlines.js';
import { resolveStatDeltas } from './plotEngine.js';
import { applyStatDeltas, statEpithet } from './stats.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function sourceForFact(fact) {
  return fact?.author === 'storyteller:echo' ? 'player' : 'world';
}

function plotForFact(domain, fact) {
  for (const id of fact?.relatedPlotlineIds || []) {
    const open = findPlotline(domain, id);
    if (open) return open;
  }
  return null;
}

function closedThisTick(domain, fact, tick) {
  const closed = domain.closedPlotlines || [];
  return (fact?.relatedPlotlineIds || []).some((id) =>
    closed.some((p) => p.id === id && p.closedTick === tick),
  );
}

function importanceForFact(domain, fact) {
  const plot = plotForFact(domain, fact);
  if (plot) return plot.importance;
  if (fact?.author === 'storyteller:echo') return 45;
  if (fact?.importance === 'major' || fact?.importance === 'critical') return 70;
  return 40;
}

function statsBrief(domain, config) {
  return (config.stats || [])
    .map((def) => {
      const raw = Number(domain.stats?.[def.id]);
      const v = Number.isFinite(raw) ? raw : 50;
      const about = def.about ? ` ${def.about}` : '';
      return `- ${def.name} (${def.id}): сейчас «${statEpithet(v, config)}».${about}`;
    })
    .join('\n');
}

function entryKind(fact, domain) {
  if (fact.author === 'storyteller:echo') return 'воля покровителя';
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
  const log = (parentLog || getLogger()).child({ scope: 'statJudge', domainId: domain.id });
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const byId = new Map(chronicleAdds.map((f) => [f.id, f]));
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
              required: ['factId'],
              properties: {
                factId: { type: 'string', description: 'id записи из списка' },
                affects: {
                  type: 'array',
                  description:
                    'Какие стороны задеты. Пусто или опусти запись — ничего не сдвинулось. ' +
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

  const listing = chronicleAdds
    .map((f, i) => {
      const kind = entryKind(f, domain);
      return `${i + 1}. id ${f.id} [${kind}]\n${f.text}`;
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
          'Пустой affects — нормально. Несколько сторон — только если запись реально про несколько.',
          'Не добивай сторону, которая уже в бедственном положении, мелкой бытовой записью.',
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
    const deltas = resolveStatDeltas(domain, mark.affects || [], {
      importance: importanceForFact(domain, fact),
      finale: closedThisTick(domain, fact, world.tickIndex),
      source: sourceForFact(fact),
      budget,
      config,
      catastrophe: Boolean(note),
    });
    if (!deltas || !Object.keys(deltas).length) {
      if (note) {
        fact.importance = 'critical';
        if (!catastrophe) catastrophe = { title: entryKind(fact, domain), text: fact.text, note };
      }
      continue;
    }

    const changes = applyStatDeltas(domain.stats, deltas);
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

  log.info('statJudge.done', {
    entries: chronicleAdds.length,
    scored,
    catastrophe: catastrophe?.note || null,
    budgetSpent: budget ? { world: budget.spentWorld, player: budget.spentPlayer } : null,
    stats: domain.stats,
  });

  return { scored, catastrophe };
}
