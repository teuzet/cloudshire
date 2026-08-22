/**
 * Рассказчик: четыре маленькие сцены, которые превращают решения движка в текст.
 * Движок уже всё посчитал — сцена только облекает готовый факт в язык.
 *   plot_seed      — завязка нити по жребию тегов
 *   plot_beat      — очередной поворот нити с заданной окраской
 *   decision_echo  — последствия указов и деяний месяца
 *   quiet_month    — тихий месяц, когда не случилось ничего
 */

import { newId } from './ids.js';
import { createLoreFact, createCharacterRecord, formatCastForPrompt, findCharacterByName } from './models.js';
import { applyStatDeltas } from './stats.js';
import {
  createPlotline,
  findPlotline,
  closePlotline,
  attachChronicleToPlotlines,
  plotConfig,
  formatPlotTagsForPrompt,
  clipPlotText,
  PLOT_SUMMARY_MAX,
  PLOT_HOOK_MAX,
} from './plotlines.js';
import { resolveStatDeltas, lowStats } from './plotEngine.js';
import { TINT_LABELS } from './rolls.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function chronicleMaxChars(config) {
  const n = Number(config?.tick?.chronicleEntryMaxChars);
  return Number.isFinite(n) && n >= 80 ? Math.round(n) : 260;
}

function cityBrief(domain, max = 900) {
  const text = String(domain.description || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || '(описание пусто)';
}

const AFFECT_SCHEMA = {
  type: 'array',
  description:
    'Какие стороны жизни города задеты и в какую сторону. Величину посчитает движок — ' +
    'называй только направление и грубую силу.',
  items: {
    type: 'object',
    required: ['stat', 'direction'],
    properties: {
      stat: { type: 'string' },
      direction: { type: 'string', enum: ['up', 'down'] },
      force: { type: 'string', enum: ['slight', 'notable', 'heavy'] },
    },
  },
};

const CHARACTERS_SCHEMA = {
  type: 'array',
  description:
    'Люди, названные по имени ВПЕРВЫЕ. Уже известных из каста сюда не добавляй — просто используй.',
  items: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      role: { type: 'string' },
      about: { type: 'string', description: 'Одна фраза: чем занят, где его найти' },
    },
  },
};

function registerCharacters(domain, list, { world, plotId = null, author = 'storyteller' }) {
  const added = [];
  for (const c of list || []) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    const existing = findCharacterByName(domain.lore, name);
    if (existing) {
      if (plotId && !existing.relatedPlotlineIds.includes(plotId)) {
        existing.relatedPlotlineIds.push(plotId);
      }
      continue;
    }
    const record = createCharacterRecord({
      id: newId('lore'),
      name,
      role: c.role,
      about: c.about,
      tick: world.tickIndex,
      gameDateLabel: world.gameDate?.label || null,
      author,
      relatedPlotlineIds: plotId ? [plotId] : [],
    });
    domain.lore.push(record);
    added.push(record);
  }
  return added;
}

function pushChronicle(domain, { text, importance, world, plotIds = [], deltas = null, processId = null, author }) {
  const statChanges = deltas && Object.keys(deltas).length ? applyStatDeltas(domain.stats, deltas) : null;
  const fact = createLoreFact({
    id: newId('lore'),
    text: String(text || '').trim(),
    tags: ['chronicle'],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author,
    importance: importance || 'minor',
    relatedPlotlineIds: plotIds.length ? plotIds : null,
    relatedPendingId: processId || null,
    statChanges: statChanges && Object.keys(statChanges).length ? statChanges : null,
  });
  domain.lore = domain.lore || [];
  domain.lore.push(fact);
  attachChronicleToPlotlines(domain, fact.id, plotIds);
  return fact;
}

/** Завязка новой нити по жребию тегов. */
export async function seedPlot({ config, runtime, domain, world, tags, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.seed', domainId: domain.id });
  const cfg = plotConfig(config);
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const tools = [
    {
      name: 'submit_plot_seed',
      description: 'Завязка новой истории города по выпавшим тегам.',
      parameters: {
        type: 'object',
        required: ['title', 'synopsis', 'closeWhen', 'importance', 'maxAgeMonths', 'relatedStats', 'entry'],
        properties: {
          title: { type: 'string', description: 'Короткое название нити, 1–3 слова' },
          synopsis: {
            type: 'string',
            description: `Положение дел одной-двумя фразами, до ${PLOT_SUMMARY_MAX} символов.`,
          },
          closeWhen: {
            type: 'string',
            description: `Что будет считаться концом истории. Одна фраза до ${PLOT_HOOK_MAX} символов.`,
          },
          importance: {
            type: 'number',
            description:
              '0–100. 10 — спор двух жителей, 50 — обсуждает весь город, 90 — судьба города.',
          },
          maxAgeMonths: {
            type: 'number',
            description: 'Через сколько месяцев без развития история выдохнется (1–12).',
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Что сейчас в игре, 1–3 из: ${statIds}. Первый — главный.`,
          },
          entry: {
            type: 'string',
            description: `Первая запись хроники: сухой факт, до ${maxChars} символов.`,
          },
          newCharacters: CHARACTERS_SCHEMA,
        },
      },
      handler: async (args) => {
        if (!String(args.title || '').trim() || !String(args.entry || '').trim()) {
          return toolFail('empty', 'Нужны и название, и первая запись хроники.');
        }
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  await runtime.run({
    agentId: 'storyteller',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_plot_seed' } },
    log,
    scene: 'plot_seed',
    domainId: domain.id,
    extraSystem: [
      `Город «${domain.name}». ${cityBrief(domain)}`,
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 12 })}`,
    ].join('\n\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          `Заведи новую историю города (${world.gameDate.label}).`,
          `Жребий: ${formatPlotTagsForPrompt(tags)}`,
          'Придумай завязку по этим тегам: конкретное событие в конкретном месте с конкретными людьми.',
          'Уже идущие истории не повторяй:',
          (domain.plotlines || []).map((p) => `- «${p.title}»`).join('\n') || '- (нет)',
          '',
          'Вызови submit_plot_seed.',
        ].join('\n'),
      },
    ],
  });

  if (!draft.data) {
    log.warn('storyteller.seed_failed');
    return null;
  }

  const d = draft.data;
  const plot = createPlotline({
    title: d.title,
    synopsis: d.synopsis,
    closeWhen: d.closeWhen,
    relatedStats: d.relatedStats,
    importance: d.importance,
    maxAgeMonths: d.maxAgeMonths,
    temperature: cfg.temperature.initial,
    tags,
    tick: world.tickIndex,
    config,
  });
  domain.plotlines.push(plot);

  const fact = pushChronicle(domain, {
    text: d.entry,
    importance: Number(d.importance) >= 70 ? 'major' : 'minor',
    world,
    plotIds: [plot.id],
    author: 'storyteller:seed',
  });
  const cast = registerCharacters(domain, d.newCharacters, { world, plotId: plot.id });

  log.info('storyteller.seed', {
    plotId: plot.id,
    title: plot.title,
    importance: plot.importance,
    maxAgeMonths: plot.maxAgeMonths,
    relatedStats: plot.relatedStats,
    cast: cast.map((c) => c.name),
  });
  return { plot, fact, cast };
}

/** Очередной поворот нити: окраска уже брошена движком. */
export async function beatPlot({
  config,
  runtime,
  domain,
  world,
  beat,
  logLine = null,
  budget = null,
  partner = null,
  confluxId = null,
  log: parentLog,
}) {
  const plot = findPlotline(domain, beat.plotId);
  if (!plot) return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.beat', domainId: domain.id });
  const cfg = plotConfig(config);
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const tools = [
    {
      name: 'submit_plot_beat',
      description: 'Поворот истории за этот месяц.',
      parameters: {
        type: 'object',
        required: ['entry', 'synopsis', 'relatedStats'],
        properties: {
          entry: {
            type: 'string',
            description: `Запись хроники: сухой факт того, что случилось, до ${maxChars} символов.`,
          },
          synopsis: {
            type: 'string',
            description: `Новое положение дел целиком (не дописка), до ${PLOT_SUMMARY_MAX} символов.`,
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Что теперь в игре, 1–3 из: ${statIds}. Первый — главный.`,
          },
          affects: AFFECT_SCHEMA,
          newCharacters: CHARACTERS_SCHEMA,
          closes: {
            type: 'boolean',
            description: 'История закончилась этим поворотом.',
          },
          closeReason: { type: 'string' },
          touchesNeighbor: {
            type: 'boolean',
            description:
              'Только при стыковке: правда ли этот поворот задел соседний город ' +
              '(люди перешли, спор у прохода, слухи, общий вред). Обычные внутренние дела — нет.',
          },
          neighborNote: {
            type: 'string',
            description: 'Если задел: одной фразой, что видит и говорит сосед.',
          },
          catastrophe: {
            type: 'string',
            description:
              'Заполняй ТОЛЬКО при настоящей катастрофе города: коротко чем именно. ' +
              'Снимает обычные ограничения на величину последствий.',
          },
        },
      },
      handler: async (args) => {
        if (!String(args.entry || '').trim()) return toolFail('empty', 'Нужна запись хроники.');
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const outcome = beat.processOutcome;
  const processLine = outcome
    ? outcome.finished
      ? `Связанное дело «${outcome.summary}» ЗАВЕРШЕНО в этом месяце — расскажи, чем кончилось.`
      : outcome.kind === 'stall'
        ? `Связанное дело «${outcome.summary}» встало: месяц без сдвига — расскажи, что помешало.`
        : `Связанное дело «${outcome.summary}» пошло быстрее обычного — расскажи, что позволило.`
    : null;

  await runtime.run({
    agentId: 'storyteller',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_plot_beat' } },
    log,
    scene: 'plot_beat',
    domainId: domain.id,
    extraSystem: [
      `Город «${domain.name}». ${cityBrief(domain, 600)}`,
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 12 })}`,
    ].join('\n\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          `История «${plot.title}» (${world.gameDate.label}).`,
          `Сейчас: ${plot.synopsis || 'только началась'}`,
          plot.closeWhen ? `Концом считается: ${plot.closeWhen}` : null,
          '',
          `ИСХОД ЭТОГО МЕСЯЦА (решено броском, не спорь): ${TINT_LABELS[beat.tint]}.`,
          beat.statId ? `Решала сторона города: ${beat.statId}.` : null,
          processLine,
          beat.finale
            ? 'Это ПОСЛЕДНИЙ месяц истории: доведи её до конца и поставь closes=true.'
            : 'Это не финал: сдвинь историю, но не закрывай, если она не исчерпана.',
          partner
            ? `Города сейчас состыкованы с «${partner.name}». Если поворот реально задел соседа — ` +
              'touchesNeighbor=true и одна фраза в neighborNote. Внутренние дела соседа не касаются.'
            : null,
          logLine ? `В городе этим месяцем: ${logLine}` : null,
          '',
          'Вызови submit_plot_beat. Запись — сухой факт; чувство добавит правитель в письме.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!draft.data) {
    log.warn('storyteller.beat_failed', { plotId: plot.id });
    return null;
  }

  const d = draft.data;
  const catastrophe = String(d.catastrophe || '').trim();
  const deltas = resolveStatDeltas(domain, d.affects, {
    importance: plot.importance,
    finale: Boolean(beat.finale || d.closes),
    source: 'world',
    budget,
    config,
    catastrophe: Boolean(catastrophe),
  });

  const fact = pushChronicle(domain, {
    text: d.entry,
    importance: catastrophe
      ? 'critical'
      : beat.finale || d.closes
        ? 'major'
        : plot.importance >= 70
          ? 'major'
          : 'minor',
    world,
    plotIds: [plot.id],
    processId: outcome?.processId || null,
    deltas,
    author: 'storyteller:beat',
  });

  const cast = registerCharacters(domain, d.newCharacters, { world, plotId: plot.id });

  plot.synopsis = clipPlotText(d.synopsis || plot.synopsis, PLOT_SUMMARY_MAX);
  if (Array.isArray(d.relatedStats) && d.relatedStats.length) {
    const allowed = new Set((config.stats || []).map((s) => s.id));
    const next = d.relatedStats.map(String).filter((id) => allowed.has(id));
    if (next.length) plot.relatedStats = next;
  }
  plot.temperature = cfg.temperature.afterBeat;
  plot.lastBeatTick = world.tickIndex;
  plot.beatCount += 1;

  const closed = Boolean(d.closes || beat.finale);
  if (closed) {
    closePlotline(domain, plot.id, {
      tick: world.tickIndex,
      reason: d.closeReason || (beat.finale ? 'выдохлась' : 'доведена до конца'),
    });
  }

  // Зеркало у соседа: одна и та же правда с двух сторон, без второго вызова модели.
  let mirror = null;
  if (partner && d.touchesNeighbor) {
    mirror = mirrorBeatToPartner({
      partner,
      domain,
      plot,
      fact,
      note: d.neighborNote,
      world,
      confluxId,
      config,
    });
  }

  log.info('storyteller.beat', {
    plotId: plot.id,
    title: plot.title,
    tint: beat.tint,
    finale: Boolean(beat.finale),
    closed,
    deltas,
    catastrophe: catastrophe || null,
    cast: cast.map((c) => c.name),
    mirrored: mirror?.plot?.id || null,
    textPreview: truncate(d.entry, 160),
  });

  return { fact, plot, closed, deltas, mirror };
}

/**
 * Разнести поворот соседу: запись видна обоим, у соседа заводится своя нить
 * поменьше — при расстыковке каждый останется со своей версией истории.
 */
function mirrorBeatToPartner({ partner, domain, plot, fact, note, world, confluxId, config }) {
  const text = String(note || '').trim()
    ? `С той стороны, в «${domain.name}»: ${String(note).trim()}`
    : `С той стороны, в «${domain.name}»: ${fact.text}`;

  let mirrorPlot = (partner.plotlines || []).find((p) => p.mirrorOf === plot.id);
  if (!mirrorPlot) {
    mirrorPlot = createPlotline({
      title: plot.title,
      synopsis: text,
      closeWhen: 'Сосед ушёл в небо или дело у них кончилось.',
      relatedStats: plot.relatedStats,
      importance: Math.max(10, Math.round(plot.importance * 0.6)),
      maxAgeMonths: Math.max(2, Math.round(plot.maxAgeMonths * 0.6)),
      temperature: plotConfig(config).temperature.initial,
      tick: world.tickIndex,
      mirrorOf: plot.id,
      confluxId,
      config,
    });
    partner.plotlines = partner.plotlines || [];
    partner.plotlines.push(mirrorPlot);
  } else {
    mirrorPlot.synopsis = clipPlotText(text, PLOT_SUMMARY_MAX);
    mirrorPlot.lastBeatTick = world.tickIndex;
    mirrorPlot.beatCount += 1;
  }

  const copy = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'conflux', confluxId ? `conflux:${confluxId}` : 'conflux', 'shared'],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author: 'storyteller:mirror',
    importance: fact.importance,
    relatedPlotlineIds: [mirrorPlot.id],
    location: domain.name,
    concernsDomainIds: [domain.id, partner.id],
    concernsDomainNames: [domain.name, partner.name],
  });
  partner.lore = partner.lore || [];
  partner.lore.push(copy);
  attachChronicleToPlotlines(partner, copy.id, [mirrorPlot.id]);
  return { plot: mirrorPlot, fact: copy };
}

/** Отзвук указов и деяний месяца — одной записью на все. */
export async function echoDecisions({
  config,
  runtime,
  domain,
  world,
  edicts = [],
  acts = [],
  budget = null,
  log: parentLog,
}) {
  if (!edicts.length && !acts.length) return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.echo', domainId: domain.id });
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const tools = [
    {
      name: 'submit_decision_echo',
      description: 'Последствия воли покровителя за этот месяц.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: {
            type: 'string',
            description: `Одна запись хроники о последствиях, до ${maxChars} символов. Не пересказ указа.`,
          },
          affects: AFFECT_SCHEMA,
          becomesThread: {
            type: 'boolean',
            description:
              'true, если решение возмутило уклад настолько, что из него вырастает история.',
          },
          threadTitle: { type: 'string', description: 'Название такой истории, 1–3 слова' },
          threadSynopsis: { type: 'string' },
          affectedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Каких сторон города касается порядок, из: ${statIds}`,
          },
          newCharacters: CHARACTERS_SCHEMA,
        },
      },
      handler: async (args) => {
        if (!String(args.entry || '').trim()) return toolFail('empty', 'Нужна запись хроники.');
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const many = edicts.length + acts.length >= 3;
  await runtime.run({
    agentId: 'storyteller',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_decision_echo' } },
    log,
    scene: 'decision_echo',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}». ${cityBrief(domain, 600)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Воля покровителя за месяц (${world.gameDate.label}) — уже исполнена, нужны последствия:`,
          ...edicts.map((m) => `- указ: ${m.text}`),
          ...acts.map((a) => `- деяние: ${a.text}`),
          '',
          many
            ? 'Решений много: город не тянет столько сразу — покажи суету, путаницу и цену спешки.'
            : 'Покажи, кто выиграл, кто озлобился, что подорожало или изменилось в порядке.',
          'Сам указ не пересказывай — только его след в жизни города.',
          'Если решение возмутило уклад настолько, что из него растёт история — becomesThread=true.',
          '',
          'Вызови submit_decision_echo.',
        ].join('\n'),
      },
    ],
  });

  if (!draft.data) return null;
  const d = draft.data;

  const deltas = resolveStatDeltas(domain, d.affects, {
    importance: 45,
    source: 'player',
    budget,
    config,
  });
  const fact = pushChronicle(domain, {
    text: d.entry,
    importance: 'minor',
    world,
    deltas,
    author: 'storyteller:echo',
  });
  registerCharacters(domain, d.newCharacters, { world, author: 'storyteller:echo' });

  let plot = null;
  if (d.becomesThread && String(d.threadTitle || '').trim()) {
    plot = createPlotline({
      title: d.threadTitle,
      synopsis: d.threadSynopsis || d.entry,
      closeWhen: 'Порядок прижился или отменён.',
      relatedStats: d.affectedStats || [],
      importance: 45,
      maxAgeMonths: 5,
      temperature: plotConfig(config).temperature.initial,
      tick: world.tickIndex,
      config,
    });
    domain.plotlines.push(plot);
    attachChronicleToPlotlines(domain, fact.id, [plot.id]);
  }

  // Действующие указы дают бонус броскам по своим статам.
  if (Array.isArray(d.affectedStats) && d.affectedStats.length) {
    for (const m of edicts) m.affectedStats = d.affectedStats;
  }

  log.info('storyteller.echo', {
    edicts: edicts.length,
    acts: acts.length,
    deltas,
    spawnedThread: plot?.id || null,
  });
  return { fact, plot, deltas };
}

// Тему тихого месяца выбирает движок: примеры в промпте модель копирует дословно.
const QUIET_TOPICS = [
  'погода и небо над островом',
  'цены и товар на рынке',
  'вода: колодцы, водосборы, очереди',
  'ремесло: мастерская, инструмент, ученик',
  'храм и обряд, к которому все привыкли',
  'дети, старики, семейный быт',
  'скот, птицы, звери у края',
  'дороги, тропы, подъёмники',
  'соседская ссора из-за пустяка',
  'починка того, что давно ждало рук',
  'запасы, склады, счёт мешков',
  'песня, слух или байка, что ходит по городу',
];

/** Тихий месяц: не случилось ничего, и это нормально. */
export async function quietMonth({ config, runtime, domain, world, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.quiet', domainId: domain.id });
  const maxChars = chronicleMaxChars(config);
  const draft = { text: null };

  const tools = [
    {
      name: 'submit_quiet_month',
      description: 'Одна запись о тихом месяце: погода, цены, быт, люди. Без последствий для статов.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: { type: 'string', description: `Сухой факт быта, до ${maxChars} символов.` },
        },
      },
      handler: async ({ entry }) => {
        if (!String(entry || '').trim()) return toolFail('empty', 'Нужна запись.');
        draft.text = entry;
        return { ok: true };
      },
    },
  ];

  const season = domain.currentSeason || world.currentSeason || '';
  const topic = QUIET_TOPICS[Math.floor(Math.random() * QUIET_TOPICS.length)];
  const recentQuiet = (domain.lore || [])
    .filter((f) => f.author === 'storyteller:quiet')
    .slice(-3)
    .map((f) => `- ${String(f.text).slice(0, 100)}`)
    .join('\n');

  await runtime.run({
    agentId: 'storyteller',
    tools,
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_quiet_month' } },
    log,
    scene: 'quiet_month',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}». ${cityBrief(domain, 500)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Месяц ${world.gameDate.label} прошёл без событий${season ? ` (${season})` : ''}.`,
          `Тема этой записи: ${topic}.`,
          'Напиши одну запись о жизни города по этой теме — с местом и людьми этого города.',
          'Ничего значительного, никаких предвестий и намёков на будущее.',
          recentQuiet ? `Так уже писали в прошлые тихие месяцы — не повторяйся:\n${recentQuiet}` : null,
          '',
          'Вызови submit_quiet_month.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!draft.text) return null;
  const fact = pushChronicle(domain, {
    text: draft.text,
    importance: 'minor',
    world,
    author: 'storyteller:quiet',
  });
  log.info('storyteller.quiet', { textPreview: truncate(draft.text, 140) });
  return { fact };
}

export { lowStats };
