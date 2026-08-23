/**
 * Рассказчик: четыре маленькие сцены, которые превращают решения движка в текст.
 * Движок уже всё посчитал — сцена только облекает готовый факт в язык.
 *   plot_seed      — завязка нити по жребию тегов
 *   plot_beat      — очередной поворот нити с заданной окраской
 *   decision_echo  — последствия указов месяца
 *   quiet_month    — тихий месяц: сюжета нет, но есть быт и небольшой дрифт статов
 */

import { newId } from './ids.js';
import {
  createLoreFact,
  createCharacterRecord,
  formatCastForPrompt,
  findCharacterByName,
  chronicleEntries,
} from './models.js';
import { applyStatDeltas } from './stats.js';
import { textsLookSame } from './processes.js';
import {
  createPlotline,
  findPlotline,
  closePlotline,
  attachChronicleToPlotlines,
  plotConfig,
  formatPlotTagsForPrompt,
  clipPlotText,
  pickPlotTags,
  occupiedPlotThemes,
  composeSeedSynopsis,
  judgePlotSeed,
  PLOT_SUMMARY_MAX,
  PLOT_HOOK_MAX,
} from './plotlines.js';
import { resolveStatDeltas, lowStats, planQuietDrift } from './plotEngine.js';
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

/** Чем жил город последние месяцы — чтобы новая история росла из жизни, а не из пустоты. */
function recentChronicleLines(domain, limit = 4, max = 170) {
  return chronicleEntries(domain.lore)
    .slice(-limit)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${String(e.text).slice(0, max)}`)
    .join('\n');
}

function activeProcessLines(domain) {
  return (domain.state?.pendingActions || [])
    .filter((p) => p.status === 'active')
    .map((p) => `- «${p.summary}» (ещё ~${p.monthsLeft ?? '?'} мес.)`)
    .join('\n');
}

/** Крайние стороны города: где тонко и где крепко. */
function strainLine(domain, config) {
  const defs = config?.stats || [];
  const low = [];
  const high = [];
  for (const def of defs) {
    const v = Number(domain?.stats?.[def.id]);
    if (!Number.isFinite(v)) continue;
    if (v <= 30) low.push(`${def.name} (${v})`);
    else if (v >= 70) high.push(`${def.name} (${v})`);
  }
  const parts = [];
  if (low.length) parts.push(`Тонко: ${low.join(', ')}`);
  if (high.length) parts.push(`Крепко: ${high.join(', ')}`);
  return parts.length ? parts.join('. ') + '.' : '';
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
    'Люди, названные по имени ВПЕРВЫЕ. Уже известных из каста сюда не добавляй — просто используй. ' +
    'Назвал в записи новое имя — обязан внести его сюда, иначе город о нём забудет.',
  items: {
    type: 'object',
    required: ['name', 'gender'],
    properties: {
      name: { type: 'string' },
      gender: {
        type: 'string',
        enum: ['male', 'female'],
        description: 'Мужчина или женщина: без этого город будет путать род человека.',
      },
      role: { type: 'string' },
      about: {
        type: 'string',
        description:
          'Одна фраза: чем занят, где его найти. ТОЛЬКО кто он есть — не события. ' +
          'Смерть, пропажа, отъезд, находка тела — это событие месяца, его место в записи хроники, ' +
          'а не здесь: карточку читают немногие, хронику — весь город.',
      },
      status: {
        type: 'string',
        enum: ['alive', 'dead', 'gone'],
        description:
          'Жив, мёртв или пропал без вести. Ставь dead/gone только если это УЖЕ сказано ' +
          'в записи хроники этого месяца.',
      },
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
      // Судьба меняется: живой мог умереть или пропасть — это надо донести до каста.
      if (['dead', 'gone'].includes(c.status) && existing.status !== c.status) {
        existing.status = c.status;
      }
      if (!['male', 'female'].includes(existing.gender) && ['male', 'female'].includes(c.gender)) {
        existing.gender = c.gender;
      }
      continue;
    }
    const record = createCharacterRecord({
      id: newId('lore'),
      name,
      role: c.role,
      about: c.about,
      gender: c.gender,
      status: c.status,
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
export async function seedPlot({ config, runtime, domain, world, tags = null, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.seed', domainId: domain.id });
  const cfg = plotConfig(config);
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const occupied = occupiedPlotThemes(domain);
  const avoid = { avoidIds: [...occupied.tagIds], avoidThemes: [...occupied.themes] };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const roll = attempt === 0 && tags?.length ? tags : pickPlotTags(cfg, Math.random, avoid);
    const draft = { data: null };
    const asked = await askPlotSeed({
      config,
      runtime,
      domain,
      world,
      tags: roll,
      log,
      maxChars,
      statIds,
      draft,
    });
    if (!asked) {
      log.warn('storyteller.seed_failed', { attempt });
      continue;
    }

    const reason = judgePlotSeed(domain, asked, roll);
    if (reason) {
      log.info('storyteller.seed_rejected', {
        reason,
        attempt,
        title: asked.title,
        who: asked.who,
        tags: roll.map((t) => t.tagId),
      });
      for (const t of roll) {
        if (t.tagId) avoid.avoidIds.push(t.tagId);
      }
      continue;
    }

    const synopsis = composeSeedSynopsis(asked) || asked.synopsis;
    const plot = createPlotline({
      title: asked.title,
      synopsis,
      closeWhen: asked.closeWhen,
      relatedStats: asked.relatedStats,
      importance: asked.importance,
      maxAgeMonths: asked.maxAgeMonths,
      temperature: cfg.temperature.initial,
      tags: roll,
      tick: world.tickIndex,
      config,
    });
    domain.plotlines.push(plot);

    const fact = pushChronicle(domain, {
      text: asked.entry,
      importance: Number(asked.importance) >= 70 ? 'major' : 'minor',
      world,
      plotIds: [plot.id],
      author: 'storyteller:seed',
    });
    const cast = registerCharacters(domain, asked.newCharacters, { world, plotId: plot.id });

    log.info('storyteller.seed', {
      plotId: plot.id,
      title: plot.title,
      who: asked.who,
      attempt,
      importance: plot.importance,
      maxAgeMonths: plot.maxAgeMonths,
      relatedStats: plot.relatedStats,
      cast: cast.map((c) => c.name),
    });
    return { plot, fact, cast };
  }

  log.info('storyteller.seed_skipped', { reason: 'no_clean_seed' });
  return null;
}

async function askPlotSeed({
  config,
  runtime,
  domain,
  world,
  tags,
  log,
  maxChars,
  statIds,
  draft,
}) {
  const tools = [
    {
      name: 'submit_plot_seed',
      description: 'Завязка новой истории: человек, желание, препятствие и первая сцена.',
      parameters: {
        type: 'object',
        required: [
          'title',
          'who',
          'wants',
          'obstacle',
          'closeWhen',
          'importance',
          'maxAgeMonths',
          'relatedStats',
          'entry',
        ],
        properties: {
          title: { type: 'string', description: 'Короткое название нити, 1–3 слова' },
          who: {
            type: 'string',
            description: 'Имя того, кто действует. Из каста — если есть подходящий; иначе новый.',
          },
          wants: {
            type: 'string',
            description:
              'Чего добивается, с глаголом: удержать чашу, найти сына, закрыть лавку соседа. ' +
              'Не порядок и не очередь — желание человека.',
          },
          obstacle: {
            type: 'string',
            description: 'Кто или что мешает прямо сейчас. Одна фраза.',
          },
          threat: {
            type: 'string',
            description: 'Чем это грозит городу, если желание не решится. Одна фраза, без пафоса.',
          },
          synopsis: {
            type: 'string',
            description:
              'Необязательно: движок сам соберёт синопсис из who/wants/obstacle. ' +
              'Если пишешь — теми же словами, до ' +
              `${PLOT_SUMMARY_MAX} символов.`,
          },
          closeWhen: {
            type: 'string',
            description:
              `Конец — когда человек добился своего или потерял это навсегда. До ${PLOT_HOOK_MAX} символов. ` +
              'Не «установили порядок» и не «решили спор о праве».',
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
            description:
              `Первая сцена хроники, до ${maxChars} символов: человек что-то сделал на глазах у людей. ` +
              'Имя who должно быть в записи. Не «предмет оказался полным» и не правило очереди.',
          },
          newCharacters: CHARACTERS_SCHEMA,
        },
      },
      handler: async (args) => {
        if (!String(args.title || '').trim() || !String(args.entry || '').trim()) {
          return toolFail('empty', 'Нужны и название, и первая запись хроники.');
        }
        if (!String(args.who || '').trim() || !String(args.wants || '').trim() || !String(args.obstacle || '').trim()) {
          return toolFail('no_plot', 'Нужны who, wants и obstacle — без этого это не история.');
        }
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const recentChronicle = recentChronicleLines(domain);
  const processLines = activeProcessLines(domain);
  const strain = strainLine(domain, config);

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
          `Жребий (только направление, не список для галочки): ${formatPlotTagsForPrompt(tags)}`,
          '',
          'ЧЕМ ЖИВЁТ ГОРОД СЕЙЧАС — из этого и расти:',
          recentChronicle || '- (записей пока нет)',
          processLines ? `Дела в работе:\n${processLines}` : null,
          strain,
          '',
          'ЭТО ДОЛЖЕН БЫТЬ СЮЖЕТ, НЕ ЗАМЕТКА:',
          'Покровитель прочтёт первую запись как новость месяца. Он не знает новых людей и вещей.',
          'Он должен понять: кто действует, чего хочет, что ему мешает.',
          'who + wants + obstacle обязательны. Синопсис на доске соберётся из них.',
          '',
          'Плохо: «на дворе чаша с водой; берут по кувшину; двое спорят о праве обряда».',
          'Это быт и процедура. Нет желания, нет цены.',
          'Хорошо: «Водоносица Лейна нашла чашу, которая наполняется сама, и хочет оставить её себе,',
          'чтобы двор не ходил к общему водосбору. Каста требует чашу в общий дом — иначе лотки останутся без платы».',
          '',
          '- Зацепись за человека из каста, место из последних записей или дело в работе.',
          '  История ниоткуда, про людей ниоткуда — плохая история.',
          '- Свой предмет, своё место, свои люди. Не вторая сторона уже идущего спора',
          '  и не тот же камень / сосуд / клятва с другого конца улицы.',
          '- Люди приходят со своего острова. Чужих островов нет.',
          '- Жребий можно взять частично, если иначе выходит нелепица.',
          '- Первая запись — поступок на глазах у людей, не правило и не намёк на будущее.',
          '',
          'УЖЕ ИДУЩИЕ ИСТОРИИ — не про них и не рядом с ними:',
          (domain.plotlines || [])
            .map((p) => `- «${p.title}»: ${p.synopsis || 'только началась'}`)
            .join('\n') || '- (нет)',
          '',
          'Вызови submit_plot_seed.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  return draft.data;
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

  const finale = Boolean(beat.finale);
  // У финала своя длина и свой контракт: развязка не влезает в сухую строку.
  const entryMax = finale ? Math.round(maxChars * 1.6) : maxChars;

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
            description: finale
              ? `Запись хроники о развязке, до ${entryMax} символов: чем всё кончилось, ` +
                'кто при этом был и что теперь иначе.'
              : `Запись хроники: сухой факт того, что случилось, до ${entryMax} символов.`,
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
          finale
            ? [
                'Это ПОСЛЕДНИЙ месяц истории: доведи её до конца и поставь closes=true.',
                'РАЗВЯЗКА — не строчка о работах. Покажи её как случай: место, названные люди,',
                'что они сделали и чем это кончилось для них. Если у дела был смысл для города',
                '(храм, суд, поход, договор) — покажи и его: сход, обряд, расчёт, приговор, первый день новой жизни.',
                'В финале РАЗРЕШЕНА одна фраза о том, что теперь в городе иначе, — без пафоса,',
                'без «эпохи» и «вехи», просто чем эта жизнь отличается от прежней.',
              ].join(' ')
            : [
                'Это не финал: сдвинь желание человека из синопсиса ближе к удаче или к провалу.',
                'Не подменяй сюжет новым правилом очереди, отложенным чтением или «пока решает жрец».',
              ].join(' '),
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

  return { fact, plot, closed, deltas, mirror, catastrophe: catastrophe || null };
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

/** Отзвук указов месяца — одной записью на все. */
export async function echoDecisions({
  config,
  runtime,
  domain,
  world,
  edicts = [],
  budget = null,
  log: parentLog,
}) {
  if (!edicts.length) return null;
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
          threadCloseWhen: {
            type: 'string',
            description: `Что будет считаться концом этой истории. Одна фраза до ${PLOT_HOOK_MAX} символов.`,
          },
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

  const many = edicts.length >= 3;
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
    const title = String(d.threadTitle).trim();
    const synopsis = d.threadSynopsis || d.entry;
    // Приказ по уже идущей истории её и продолжает, а не заводит вторую такую же.
    const twin = (domain.plotlines || []).find((p) =>
      textsLookSame(`${p.title} ${p.synopsis}`, `${title} ${synopsis}`),
    );
    if (twin) {
      attachChronicleToPlotlines(domain, fact.id, [twin.id]);
      twin.temperature = plotConfig(config).temperature.afterBeat;
      log.info('storyteller.echo_thread_merged', { into: twin.id, title });
    } else {
      plot = createPlotline({
        title,
        synopsis,
        closeWhen: d.threadCloseWhen || 'Дело улеглось или обернулось новой бедой.',
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
  }

  // Действующие указы дают бонус броскам по своим статам.
  if (Array.isArray(d.affectedStats) && d.affectedStats.length) {
    for (const m of edicts) m.affectedStats = d.affectedStats;
  }

  log.info('storyteller.echo', {
    edicts: edicts.length,
    deltas,
    spawnedThread: plot?.id || null,
  });
  return { fact, plot, deltas };
}

// Оптику тихого месяца жребий собирает из трёх осей: о чём, через кого и какой формы факт.
// Одна фиксированная тема давала однообразие; сочетаний хватает, чтобы месяцы не совпадали.
const QUIET_TOPICS = [
  { id: 'weather', text: 'погода и небо над островом' },
  { id: 'market', text: 'цены и товар на рынке' },
  { id: 'water', text: 'вода: колодцы, водосборы, очереди' },
  { id: 'craft', text: 'ремесло: мастерская, инструмент, ученик' },
  { id: 'rite', text: 'храм и обряд, к которому все привыкли' },
  { id: 'family', text: 'дети, старики, семейный быт' },
  { id: 'beasts', text: 'скот, птицы, звери у края' },
  { id: 'roads', text: 'дороги, тропы, подъёмники' },
  { id: 'quarrel', text: 'соседская ссора из-за пустяка' },
  { id: 'repair', text: 'починка того, что давно ждало рук' },
  { id: 'stores', text: 'запасы, склады, счёт мешков' },
  { id: 'talk', text: 'песня, слух или байка, что ходит по городу' },
  { id: 'watch', text: 'дозор, ночные смены, порядок на улицах' },
  { id: 'edge', text: 'край острова: ветер, туман, что видно в небе' },
  { id: 'work', text: 'наём и плата: кто кого нанял и за сколько' },
  { id: 'ledger', text: 'записи и счёт: писцы, тяжбы о меже, недоимки' },
  { id: 'fields', text: 'поля, огороды, сады за городской чертой' },
  { id: 'guests', text: 'приезжие с окрестных деревень, торг на въезде' },
  { id: 'sick', text: 'хвори, знахарки, снадобья' },
  { id: 'stone', text: 'камень, лес, глина: откуда берут и как везут' },
];

const QUIET_FOCUS = [
  'мастер и его ученик',
  'торговка на лотке',
  'стражник в дозоре',
  'жрец или служка',
  'ребёнок и его родня',
  'старик, который всё помнит',
  'писец с ведомостью',
  'пастух или птичник',
  'лодочник у причала',
  'артель работников',
  'вдова или сирота на попечении',
  'сосед, который вечно недоволен',
];

// Форма факта согласована с дрифтом: если стат окреп — мелкая удача, если просел — мелкая потеря.
const QUIET_SHAPES = {
  up: [
    'мелкая удача: нашлось, наладилось, привезли',
    'починили то, что давно не работало',
    'спор кончился миром, договорились',
    'кто-то взялся за дело сам, без приказа',
    'вернулся тот, кого не ждали',
  ],
  down: [
    'мелкая потеря: испортилось, разбилось, пропало',
    'поломка в неудобный час',
    'спор кончился ничем, разошлись злые',
    'кто-то не вышел на работу, дело встало',
    'подорожало или стало меньше, чем считали',
  ],
  flat: [
    'счёт и цена: сколько чего и по чём',
    'привычный порядок дня, никто не удивился',
    'работа шла как всегда, без событий',
    'разговор на площади, из которого ничего не вышло',
    'мелкая суета, которую к вечеру забыли',
  ],
};

function pickFrom(list, rng = Math.random) {
  return list[Math.floor(rng() * list.length)];
}

/** Жребий с оглядкой на прошлые тихие месяцы: не повторять тему подряд. */
function pickAvoiding(list, usedIds, rng = Math.random) {
  const fresh = list.filter((item) => !usedIds.includes(item.id ?? item));
  return pickFrom(fresh.length ? fresh : list, rng);
}

function rememberQuietPick(domain, pick, keep) {
  if (!domain.state) return;
  const list = Array.isArray(domain.state.quietPicks) ? domain.state.quietPicks : [];
  list.push(pick);
  domain.state.quietPicks = keep > 0 ? list.slice(-keep) : [];
}

/**
 * Тихий месяц: сюжет не стрелял, но месяц не пустой.
 * Оптику и след в статах решает жребий движка, рассказчик только пишет факт.
 */
export async function quietMonth({ config, runtime, domain, world, budget = null, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.quiet', domainId: domain.id });
  const maxChars = chronicleMaxChars(config);
  const cfg = plotConfig(config);
  const draft = { text: null, characters: [] };

  const drift = planQuietDrift(domain, config);
  const used = (domain.state?.quietPicks || []).slice(-cfg.quiet.avoidRepeat);
  const topic = pickAvoiding(
    QUIET_TOPICS,
    used.map((p) => p.topic),
  );
  const shapePool = QUIET_SHAPES[drift?.direction || 'flat'] || QUIET_SHAPES.flat;
  const shape = pickFrom(shapePool);
  const focus = pickFrom(QUIET_FOCUS);

  const tools = [
    {
      name: 'submit_quiet_month',
      description: 'Одна запись о тихом месяце: погода, цены, быт, люди.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: { type: 'string', description: `Сухой факт быта, до ${maxChars} символов.` },
          newCharacters: CHARACTERS_SCHEMA,
        },
      },
      handler: async ({ entry, newCharacters }) => {
        if (!String(entry || '').trim()) return toolFail('empty', 'Нужна запись.');
        draft.text = entry;
        draft.characters = newCharacters || [];
        return { ok: true };
      },
    },
  ];

  const season = domain.currentSeason || world.currentSeason || '';
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
    extraSystem: [
      `Город «${domain.name}». ${cityBrief(domain, 500)}`,
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 10 })}`,
    ].join('\n\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          `Месяц ${world.gameDate.label} прошёл без больших событий${season ? ` (${season})` : ''}.`,
          `О чём запись: ${topic.text}.`,
          `Кто в кадре: ${focus}.`,
          `Что за случай: ${shape}.`,
          drift
            ? `След в жизни города: «${drift.name}» ${drift.direction === 'up' ? 'чуть окрепло' : 'чуть просело'}. ` +
              'Покажи это делом и вещами, не называй ни стат, ни числа.'
            : 'Ничего в городе от этого не сдвинулось.',
          'Одна запись: место этого города, названные люди, предметный исход.',
          'Никаких предвестий и намёков на будущее — это не завязка истории.',
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

  const deltas = drift
    ? resolveStatDeltas(domain, [{ stat: drift.stat, direction: drift.direction, force: drift.force }], {
        importance: 50,
        source: 'world',
        budget,
        config,
      })
    : null;

  const fact = pushChronicle(domain, {
    text: draft.text,
    importance: 'minor',
    world,
    deltas,
    author: 'storyteller:quiet',
  });
  registerCharacters(domain, draft.characters, { world, author: 'storyteller:quiet' });
  rememberQuietPick(domain, { topic: topic.id, tick: world.tickIndex }, cfg.quiet.avoidRepeat);

  log.info('storyteller.quiet', {
    topic: topic.id,
    shape,
    focus,
    drift: drift ? `${drift.stat} ${drift.direction} ${drift.force}` : null,
    deltas,
    textPreview: truncate(draft.text, 140),
  });
  return { fact };
}

export { lowStats };
