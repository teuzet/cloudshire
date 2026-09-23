/**
 * Оценщик статов. Рассказчики пишут, что случилось; этот агент читает
 * записи хроники и ставит, какие стороны города задеты. Величину считает движок.
 */

import {
  findPlotline,
  plotConfig,
  isStoryPlot,
  seedStatBudget,
  depthStatPoints,
  endingStatPoints,
} from './plotlines.js';
import { deedValue, CRIT_DEPTH_MULTIPLIER } from './deedMath.js';
import { worldDateLabel } from './gameClock.js';
import { resolveStatDeltas, scaleTaggedAffects } from './plotEngine.js';
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

/** Концовка приходит уже закрытой нитью, но бюджет надо списать с неё же. */
function closedPlotForFact(domain, fact) {
  const ids = fact?.relatedPlotlineIds || [];
  return (domain?.closedPlotlines || []).find((p) => ids.includes(p.id)) || null;
}

/**
 * Статы дела: deedValue × statsPerDeedValue, crit дороже, провал пустой.
 * CrossIsland — тот же счётчик × confluxStatGainModifier; провал через проход
 * оставляет долю crossIslandFailShare.
 */
export function deedStatBudget(process, config = null, { finish = null } = {}) {
  if (!process) return 0;
  const done = finish || process.finishKind || 'ok';
  const value = deedValue({
    durationBand: process.durationBand,
    difficulty: process.difficulty,
  });
  if (value <= 0) return 0;
  const cfg = plotConfig(config);
  const per = Number(cfg.stats?.statsPerDeedValue ?? config?.tick?.statsPerDeedValue ?? 5);
  const mod = Number(cfg.stats?.confluxStatGainModifier ?? config?.tick?.confluxStatGainModifier ?? 1.5);
  const cross = Boolean(process.crossIsland);
  if (done === 'fail') {
    if (!cross) return 0;
    const share = Number(config?.tick?.crossIslandFailShare ?? 0.6);
    return Math.max(1, Math.round(value * per * mod * share));
  }
  const crit = done === 'crit' ? CRIT_DEPTH_MULTIPLIER : 1;
  return Math.max(1, Math.round(value * per * crit * (cross ? mod : 1)));
}

/** @deprecated курс больше не от gravity RUPTURE; оставлен для старых тестов. */
export function confluxStatRate(config = null) {
  const cfg = plotConfig(config);
  return Number(cfg.stats?.statsPerDeedValue ?? 5) * Number(cfg.stats?.confluxStatGainModifier ?? 1.5);
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

/** Удар по городу с чужого берега: успех нападавших — наши потери. */
export function finishForFact(fact) {
  const impact = fact?.pairImpact;
  if (impact?.hostile) {
    const f = String(impact.finish || '');
    if (f === 'crit' || f === 'ok' || f === 'success') return 'fail';
    if (f === 'fail') return 'ok';
  }
  return fact?.processFinish || null;
}

/** Тихий месяц и пропуски оценщика больше не двигают статы. */
export function applyFallbackStatDrift() {
  return null;
}

function polarityOf(fact) {
  const pocket = String(fact?.statPocket || '');
  const endingKind = String(fact?.endingKind || '');
  if (pocket === 'threat' && !fact?.plotClosed) return 'nonpos';
  if (pocket === 'ending' || fact?.plotClosed) {
    if (endingKind === 'GOOD_ENDING') return 'nonneg';
    if (endingKind === 'BAD_ENDING') return 'nonpos';
    if (endingKind === 'NEUTRAL_ENDING') return 'mixed';
  }
  const f = String(finishForFact(fact) || '');
  if (f === 'crit') return 'nonneg';
  if (f === 'fail') return 'nonpos';
  return 'any';
}

/**
 * Две стороны одной хроники.
 * down — завязка или беда. up — глубина и закрытие истории.
 * deed — цена дела без истории: знак по-прежнему берёт исход.
 */
export function statPartsForFact(domain, fact, config) {
  const empty = { up: 0, down: 0, deed: 0 };
  if (fact?.statsSettled) return empty;
  if (fact?.author === 'storyteller:quiet') return empty;
  if (fact?.author === 'engine:rule') return empty;

  const pocket = String(fact?.statPocket || '');
  const author = String(fact?.author || '');
  const plot = plotForFact(domain, fact) || closedPlotForFact(domain, fact);
  let up = 0;
  let down = 0;

  const isSeed = pocket === 'seed' || /seed/i.test(author);
  if (isSeed && plot && isStoryPlot(plot)) down += seedStatBudget(plot, config);

  const wound = Number(fact?.woundBudget);
  if (Number.isFinite(wound) && wound > 0) down += Math.round(wound);

  const finish = String(fact?.processFinish || '');
  const gain = Number(fact?.depthGain);
  const depthAdvanced = Number.isFinite(gain) && gain > 0 && finish !== 'fail';
  if (depthAdvanced) up += depthStatPoints(gain, config);

  const closed = Boolean(fact?.plotClosed) || pocket === 'ending';
  if (closed && plot && isStoryPlot(plot)) up += endingStatPoints(plot, config);

  const impact = fact?.pairImpact;
  let deedMagnitude = 0;
  if (impact?.crossIsland) {
    deedMagnitude = deedStatBudget(
      {
        crossIsland: true,
        durationBand: impact.durationBand,
        difficulty: impact.difficulty,
        objectiveDays: impact.objectiveDays,
      },
      config,
      { finish: impact.finish },
    );
  } else if (fact?.processFinish && !depthAdvanced) {
    const proc = (domain.state?.pendingActions || []).find((a) => a.id === fact.relatedPendingId) || {
      durationBand: impact?.durationBand,
      difficulty: impact?.difficulty,
      crossIsland: Boolean(impact?.crossIsland),
      finishKind: fact.processFinish,
    };
    deedMagnitude = deedStatBudget(proc, config, { finish: fact.processFinish });
  }

  if (deedMagnitude > 0 && !depthAdvanced) {
    const alongside = up > 0 || down > 0;
    if (!alongside) return { up: 0, down: 0, deed: deedMagnitude };
    if (finishForFact(fact) === 'fail') down += deedMagnitude;
    else up += deedMagnitude;
  }

  return { up, down, deed: 0 };
}

export function absBudgetForFact(domain, fact, config) {
  const parts = statPartsForFact(domain, fact, config);
  return parts.up + parts.down + parts.deed;
}

function statTraceNote(parts) {
  if (parts.up > 0 && parts.down > 0) return 'и потери, и отдельный плюс';
  if (parts.down > 0 && parts.deed === 0 && parts.up === 0) return 'только потери';
  if (parts.up > 0 && parts.deed === 0 && parts.down === 0) return 'только плюс';
  return '';
}

function deltasForParts(domain, fact, affects, parts, { config, note }) {
  const source = sourceForFact(fact);
  const catastrophe = Boolean(note);
  if (parts.up > 0 && parts.down > 0) {
    return resolveStatDeltas(domain, affects, {
      source,
      config,
      catastrophe,
      polarity: 'split',
      upBudget: parts.up,
      downBudget: parts.down,
    });
  }
  if (parts.deed > 0) {
    return enforceFinishPolarity(
      resolveStatDeltas(domain, affects, {
        source,
        config,
        catastrophe,
        absBudget: parts.deed,
        polarity: polarityOf(fact),
      }),
      finishForFact(fact),
    );
  }
  if (parts.down > 0) {
    return resolveStatDeltas(domain, affects, {
      source,
      config,
      catastrophe,
      absBudget: parts.down,
      polarity: 'nonpos',
    });
  }
  return resolveStatDeltas(domain, affects, {
    source,
    config,
    catastrophe,
    absBudget: parts.up,
    polarity: 'nonneg',
  });
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
  return 'запись хроники';
}

/**
 * Проставить след в статах каждой новой записи хроники.
 * @returns {{ scored: number, catastrophe: { title: string, text: string } | null }}
 */
export async function scoreChronicleStats({
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
        'След каждой записи хроники в жизни города. Направление и грубая сила — ты, величину посчитает система.',
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
      const finish = finishForFact(f);
      const hit = f.pairImpact?.hostile ? ' удар с чужого берега' : '';
      const finishNote = finish ? ` исход: ${finish}` : '';
      const trace = statTraceNote(statPartsForFact(domain, f, config));
      const traceNote = trace ? ` (${trace})` : '';
      return `${i + 1}. id ${f.id} [${kind}]${hit}${finishNote}${traceNote}\n${f.text}`;
    })
    .join('\n\n');
  const hitUs = toScore.some((f) => f?.pairImpact?.hostile);

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
          `Сейчас ${world?.gameDate?.label || worldDateLabel(world)}.` +
            ' Проставь след каждой записи в сторонах жизни города.',
          'Оценивай только то, что явно следует из текста: вещи, люди, исход.',
          'Направление и грубую силу называй ты. Насколько сдвинуть — решит система, не ты.',
          'Каждая запись задевает хотя бы одну сторону.',
          'Несколько сторон — только если запись реально про несколько.',
          'Если исход записи crit / [КРИТИЧЕСКИЙ УСПЕХ] — только плюсы, без down.',
          'Если fail / [ПРОВАЛ] — без плюсов, город теряет.',
          'Если ok / [УСПЕХ] — плюсы есть, небольшая негативная побочка обязательна.',
          'Если у записи в скобках сказано «и потери, и отдельный плюс» — поставь и down, и up, даже при провале или критическом успехе.',
          hitUs
            ? 'Удар с чужого берега: этот город — пострадавший. Ставь потери (down), не добычу нападавших.'
            : '',
          '',
          'Сейчас в городе:',
          statsBrief(domain, config),
          '',
          'Записи:',
          listing,
          '',
          'Вызови submit_stat_marks.',
        ]
          .filter((line) => line != null)
          .join('\n'),
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
    const parts = statPartsForFact(domain, fact, config);
    const absBudget = parts.up + parts.down + parts.deed;
    if (!absBudget) {
      if (note) {
        fact.importance = 'critical';
        if (!catastrophe) catastrophe = { title: entryKind(fact, domain), text: fact.text, note };
      }
      continue;
    }
    const deltas = deltasForParts(domain, fact, mark.affects || [], parts, { config, note });
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

/**
 * Две субъектификации — один бюджет: пометки с обоих берегов делят deedStatBudget.
 */
export async function scorePairChronicleStats({
  config,
  runtime,
  world,
  process,
  rows = [],
  log: parentLog,
} = {}) {
  const list = (rows || []).filter((r) => r?.domain && r?.fact);
  if (!list.length) return { scored: 0 };
  const budget = deedStatBudget(process, config, { finish: process?.finishKind || process?.finish });
  if (!budget) {
    for (const row of list) row.fact.statsSettled = true;
    return { scored: 0 };
  }
  const log = (parentLog || getLogger()).child({ scope: 'statJudge.pair' });
  const marks = [];
  for (const row of list) {
    const collected = { affects: [] };
    const domain = row.domain;
    const fact = row.fact;
    const statIds = (config.stats || []).map((s) => s.id).join(', ');
    const draft = { entries: null };
    try {
      await runtime.run({
        agentId: 'statJudge',
        tools: [
          {
            name: 'submit_stat_marks',
            description: 'След записи в жизни города.',
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
                      factId: { type: 'string' },
                      affects: {
                        type: 'array',
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
                    },
                  },
                },
              },
            },
            handler: async (args) => {
              draft.entries = args.entries;
              return { ok: true };
            },
          },
        ],
        maxTurns: 3,
        toolChoice: { type: 'function', function: { name: 'submit_stat_marks' } },
        log,
        scene: 'stat_judge_pair',
        domainId: domain.id,
        extraSystem: `Город «${domain.name}».`,
        userMessages: [
          {
            role: 'user',
            content: [
              `Сейчас ${world?.gameDate?.label || worldDateLabel(world)}.`,
              `Город «${domain.name}». Проставь след записи. stat из: ${statIds}.`,
              fact.text,
              'Вызови submit_stat_marks.',
            ].join('\n'),
          },
        ],
      });
    } catch (err) {
      log.warn('statJudge.pair_failed', { error: err.message, domainId: domain.id });
    }
    for (const mark of draft.entries || []) {
      for (const a of mark.affects || []) {
        collected.affects.push(a);
        marks.push({
          domainId: domain.id,
          stat: a.stat,
          direction: a.direction,
          force: a.force,
        });
      }
    }
    void collected;
  }
  const byDomain = scaleTaggedAffects(marks, budget, { polarity: 'any' });
  let scored = 0;
  for (const row of list) {
    const raw = byDomain.get(row.domain.id) || {};
    const deltas = enforceFinishPolarity(raw, finishForFact(row.fact));
    row.fact.statsSettled = true;
    if (!Object.keys(deltas).length) continue;
    const changes = applyStatDeltasToDomain(row.domain, deltas);
    if (Object.keys(changes).length) {
      row.fact.statChanges = changes;
      scored += 1;
    }
  }
  return { scored };
}
