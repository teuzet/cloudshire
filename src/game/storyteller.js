/**
 * Четыре автора историй. Движок решает, когда писать.
 *   storyStart  — новая история (посев или воля покровителя)
 *   storyBeat   — следующая запись хроники уже идущей истории
 *   storyKeep   — синопсис по свежей хронике; «история всплыла» → температуру поднимает система
 *   fillerNews  — быт, когда сюжета не было
 * След в статах города ставит отдельный агент (statJudge), не они.
 */

import { newId } from './ids.js';
import {
  createLoreFact,
  createCharacterRecord,
  formatCastForPrompt,
  findCharacterByName,
  chronicleEntries,
  castRecords,
} from './models.js';
import { textsLookSame } from './processes.js';
import {
  createPlotline,
  findPlotline,
  closePlotline,
  plotHasActiveProcess,
  attachChronicleToPlotlines,
  plotConfig,
  formatPlotTagsForPrompt,
  clipPlotText,
  pickPlotTags,
  judgePlotSeed,
  warmPlotlines,
  PLOT_SUMMARY_MAX,
  PLOT_HOOK_MAX,
} from './plotlines.js';
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

/** Контекст города для завязки: генезис, свежая хроника, дела, люди. */
function cityStoryContext(domain, { chronicleLimit = 8 } = {}) {
  const recent = chronicleEntries(domain.lore)
    .slice(-chronicleLimit)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${e.text}`)
    .join('\n');
  const processes = (domain.state?.pendingActions || [])
    .filter((p) => !p.status || p.status === 'active')
    .map((p) => `- ${p.summary}${p.detail ? `. ${p.detail}` : ''}`)
    .join('\n');
  return {
    genesis: cityBrief(domain),
    recent: recent || '- (записей пока нет)',
    processes: processes || '- (сейчас ничего особенного не делают)',
    people: formatCastForPrompt(domain.lore, { limit: 20 }),
  };
}

function recentPlayerTalk(domain, limit = 8) {
  const history = domain.characters?.[0]?.dialogHistory || [];
  return history
    .slice(-limit)
    .map((m) => {
      const who = m.role === 'user' ? 'Покровитель' : 'Правитель';
      return `${who}: ${String(m.content || '').replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');
}

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
          'Жив, мёртв или пропал без вести. dead/gone — только если это УЖЕ сказано в записи. ' +
          'Если пропавшего нашли живым — alive.',
      },
    },
  },
};

function rulerName(domain) {
  return String(domain?.characters?.[0]?.name || '').trim();
}

function registerCharacters(domain, list, { world, plotId = null, author = 'storyteller' }) {
  const added = [];
  const ruler = rulerName(domain).toLowerCase();
  for (const c of list || []) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    if (ruler && name.toLowerCase() === ruler) continue;
    const existing = findCharacterByName(domain.lore, name);
    if (existing) {
      if (plotId && !existing.relatedPlotlineIds.includes(plotId)) {
        existing.relatedPlotlineIds.push(plotId);
      }
      // Судьба меняется: живой мог умереть или пропасть — и пропавшего могли найти.
      if (['dead', 'gone'].includes(c.status) && existing.status !== c.status) {
        existing.status = c.status;
      } else if (c.status === 'alive' && ['gone', 'dead'].includes(existing.status)) {
        existing.status = 'alive';
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

function pushChronicle(domain, { text, importance, world, plotIds = [], processId = null, processFinish = null, author }) {
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
    processFinish,
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const roll = attempt === 0 && tags?.length ? tags : pickPlotTags(cfg);
    const draft = { data: null };
    const asked = await askPlotSeed({
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

    const reason = judgePlotSeed(domain, asked);
    if (reason) {
      log.info('storyteller.seed_rejected', {
        reason,
        attempt,
        title: asked.title,
        tags: roll.map((t) => t.tagId),
      });
      continue;
    }

    const plot = createPlotline({
      title: asked.title,
      synopsis: asked.synopsis,
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

async function askPlotSeed({ runtime, domain, world, tags, log, maxChars, statIds, draft }) {
  const tools = [
    {
      name: 'submit_plot_seed',
      description: 'Новая история: завязка, как она начинается в этом месяце, и карточка для продолжения.',
      parameters: {
        type: 'object',
        required: ['title', 'synopsis', 'closeWhen', 'importance', 'maxAgeMonths', 'relatedStats', 'entry'],
        properties: {
          title: { type: 'string', description: 'Название, 1–4 слова' },
          synopsis: {
            type: 'string',
            description:
              `Как сейчас обстоят дела и куда это может пойти, до ${PLOT_SUMMARY_MAX} символов. ` +
              'По этому тексту историю будут продолжать.',
          },
          closeWhen: {
            type: 'string',
            description:
              `Что должно произойти, чтобы историю закрыть по существу — не срок и не «что писать в последний месяц». ` +
              `Одна фраза, до ${PLOT_HOOK_MAX} символов. Пример: «Иару нашли или узнали, что с ней стало».`,
          },
          importance: {
            type: 'number',
            description: '0–100. 10 — двое на дворе, 50 — говорит весь город, 90 — судьба города.',
          },
          maxAgeMonths: {
            type: 'number',
            description:
              'Сколько месяцев история живёт без внимания (1–12). Срок сам по себе развязку не требует ' +
              'и историю не закрывает, пока ею занимаются или о ней говорят.',
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Каких сторон жизни касается, 1–3 из: ${statIds}. Первый — главный.`,
          },
          entry: {
            type: 'string',
            description: `Что случилось в этом месяце, до ${maxChars} символов. Сухой факт.`,
          },
          newCharacters: CHARACTERS_SCHEMA,
        },
      },
      handler: async (args) => {
        if (!String(args.title || '').trim() || !String(args.entry || '').trim() || !String(args.synopsis || '').trim()) {
          return toolFail('empty', 'Нужны название, синопсис и запись хроники.');
        }
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const city = cityStoryContext(domain);
  const open = (domain.plotlines || [])
    .map((p) => {
      const kind = p.kind === 'errand' ? 'текущее дело' : 'история';
      return `- «${p.title}» (${kind}): ${p.synopsis || 'только началась'}`;
    })
    .join('\n');

  await runtime.run({
    agentId: 'storyStart',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_plot_seed' } },
    log,
    scene: 'plot_seed',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}».\n${city.genesis}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Придумай новую историю города (${world.gameDate.label}).`,
          'Завязка должна быть оригинальной и интересной — конкретной и такой, чтобы захотелось узнать, что будет дальше.',
          '',
          `Направление (это тон, не готовая сцена): ${formatPlotTagsForPrompt(tags)}`,
          '',
          'Последние записи хроники:',
          city.recent,
          '',
          'Сейчас в городе делают (это чужая работа, не завязка новой истории):',
          city.processes,
          '',
          'Люди, которых город уже знает (можно назвать, но не делай их двигателем чужого дела):',
          city.people,
          '',
          'Уже идут другие истории и дела — не продолжай их и не делай вторую сторону того же случая:',
          open || '- (нет)',
          'Новый случай: свой предмет, не срыв и не тайна того, что уже делают.',
          '',
          'Напиши первую запись: что увидели в этом месяце.',
          'Синопсис — как обстоят дела сейчас, чтобы по нему можно было продолжить.',
          'closeWhen — условие настоящей развязки, не инструкция на последний месяц. ' +
            'Если это условие выполнится раньше срока (нашли пропавшую на шестом месяце из двенадцати) — историю можно закрыть сразу.',
          'Вызови submit_plot_seed.',
        ].join('\n'),
      },
    ],
  });

  return draft.data;
}

const PRIOR_CHRONICLE_LIMIT = 4;
const WATCH_RE = /розыск|задерж|пойм|арест|угроз|подозрева|разыск/i;

/** Уже записанное по этой нити — иначе следующий бит сочиняет поиск заново. */
export function priorPlotChronicle(domain, plot, limit = PRIOR_CHRONICLE_LIMIT) {
  if (!plot) return [];
  const ids = new Set((plot.chronicleIds || []).map(String));
  return chronicleEntries(domain?.lore)
    .filter((e) => ids.has(String(e.id)) || (e.relatedPlotlineIds || []).includes(plot.id))
    .slice(-limit)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${e.text}`);
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
export async function beatPlot({
  config,
  runtime,
  domain,
  world,
  beat,
  logLine = null,
  partner = null,
  confluxId = null,
  log: parentLog,
}) {
  const plot = findPlotline(domain, beat.plotId);
  if (!plot) return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.beat', domainId: domain.id });
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const finale = Boolean(beat.finale);
  // У финала своя длина и свой контракт: развязка не влезает в сухую строку.
  const entryMax = finale ? Math.round(maxChars * 1.6) : maxChars;

  const tools = [
    {
      name: 'submit_plot_beat',
      description: 'Запись хроники этого месяца по уже идущей истории.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: {
            type: 'string',
            description: finale
              ? `Чем история кончилась, до ${entryMax} символов: кто был, что сделали, что теперь иначе.`
              : `Что случилось в этом месяце, до ${entryMax} символов. Сухой факт.`,
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Каких сторон жизни касается теперь, 1–3 из: ${statIds}. Первый — главный.`,
          },
          newCharacters: CHARACTERS_SCHEMA,
          closes: {
            type: 'boolean',
            description:
              'true только если в ЭТОМ месяце случилось условие закрытия истории. ' +
              'Срок нити сам по себе не повод. Не выдумывай развязку, потому что «пора кончать».',
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
      ? [
          `Связанное дело «${outcome.summary}» ЗАВЕРШЕНО в этом месяце.`,
          `Исход броска (не спорь): ${outcome.finishLabel || outcome.finish || 'нейтральный успех'}.`,
          'Провал не значит, что цель не достигнута — чаще это тяжёлая цена или побочный вред при исполненном поручении.',
          outcome.detail ? `Поручение было: ${outcome.detail}` : null,
        ]
          .filter(Boolean)
          .join(' ')
      : outcome.kind === 'stall'
        ? `Связанное дело «${outcome.summary}» встало: месяц без сдвига — расскажи, что помешало.`
        : `Связанное дело «${outcome.summary}» пошло быстрее обычного — расскажи, что позволило.`
    : null;

  const prior = priorPlotChronicle(domain, plot);
  const watched = peopleUnderWatch(domain);
  const ruler = rulerName(domain);

  await runtime.run({
    agentId: 'storyBeat',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_plot_beat' } },
    log,
    scene: 'plot_beat',
    domainId: domain.id,
    extraSystem: [
      `Город «${domain.name}». ${cityBrief(domain, 600)}`,
      ruler ? `Правитель города — ${ruler}. Этого человека в newCharacters не заводи, второго с тем же именем тоже.` : null,
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 12 })}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          `История «${plot.title}» (${world.gameDate.label}).`,
          `Сейчас: ${plot.synopsis || 'только началась'}`,
          plot.closeWhen
            ? `Историю можно закрыть, когда случится: ${plot.closeWhen}. Это условие развязки, не срок.`
            : null,
          prior.length ? `\nУже записано по этой истории (не отменяй):\n${prior.join('\n')}` : null,
          watched.length
            ? `\nСейчас ищут или держат: ${watched.map((w) => `${w.name} («${w.process}»)`).join('; ')}. ` +
              'Им нельзя отдавать бумаги, ключи и доверие города, пока запись сама не скажет, что их поймали или сняли подозрение.'
            : null,
          '',
          `ИСХОД ЭТОГО МЕСЯЦА (решено броском, не спорь): ${TINT_LABELS[beat.tint]}.`,
          beat.statId ? `Решала сторона города: ${beat.statId}.` : null,
          processLine,
          finale
            ? 'Проходное дело закончилось: покажи итог. closes=true.'
            : outcome?.finished
              ? 'Дело закончилось. Напиши его итог, не отменяя уже записанную хронику: если человека нашли — не пиши, что его всё ещё ищут. closes=true, только если этим исполнилось условие закрытия самой истории.'
              : 'Сдвинь историю по исходу броска. closes=true — только если в этом месяце случилось условие закрытия, даже если до срока ещё далеко. Не закрывай и не выдумывай развязку просто потому что нить старая.',
          partner
            ? `Города сейчас состыкованы с «${partner.name}». Если поворот реально задел соседа — ` +
              'touchesNeighbor=true и одна фраза в neighborNote. Внутренние дела соседа не касаются.'
            : null,
          logLine ? `В городе этим месяцем: ${logLine}` : null,
          '',
          'Вызови submit_plot_beat. Только запись этого месяца; карточку истории не переписывай.',
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

  const fact = pushChronicle(domain, {
    text: d.entry,
    importance: beat.finale || d.closes || plot.importance >= 70 ? 'major' : 'minor',
    world,
    plotIds: [plot.id],
    processId: outcome?.processId || null,
    processFinish: outcome?.finished ? outcome.finish || null : null,
    author: 'storyteller:beat',
  });

  const cast = registerCharacters(domain, d.newCharacters, { world, plotId: plot.id });

  if (Array.isArray(d.relatedStats) && d.relatedStats.length) {
    const allowed = new Set((config.stats || []).map((s) => s.id));
    const next = d.relatedStats.map(String).filter((id) => allowed.has(id));
    if (next.length) plot.relatedStats = next;
  }
  plot.lastBeatTick = world.tickIndex;
  plot.beatCount += 1;

  const wantClose = Boolean(d.closes || beat.finale);
  const closed = wantClose && !plotHasActiveProcess(domain, plot);
  if (closed) {
    closePlotline(domain, plot.id, {
      tick: world.tickIndex,
      reason: d.closeReason || (beat.finale ? 'дело закончилось' : 'условие закрытия исполнилось'),
    });
  } else if (wantClose) {
    log.info('storyteller.beat_close_held', { plotId: plot.id, reason: 'active_process' });
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
    cast: cast.map((c) => c.name),
    mirrored: mirror?.plot?.id || null,
    textPreview: truncate(d.entry, 160),
  });

  return { fact, plot, closed, mirror };
}

/** Забытую нить закрываем без развязки: игроку она была не нужна. */
export function fadeQuietPlot({ domain, plot, world }) {
  const fact = pushChronicle(domain, {
    text: `Про историю «${plot.title}» в городе перестали говорить.`,
    importance: 'minor',
    world,
    plotIds: [plot.id],
    author: 'storyteller:fade',
  });
  plot.lastBeatTick = world.tickIndex;
  plot.beatCount += 1;
  closePlotline(domain, plot.id, {
    tick: world.tickIndex,
    reason: 'угасла: город перестал о ней говорить',
  });
  return { fact, plot, closed: true, fade: true };
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
    agentId: 'storyBeat',
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

  const fact = pushChronicle(domain, {
    text: d.entry,
    importance: 'minor',
    world,
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
    spawnedThread: plot?.id || null,
  });
  return { fact, plot };
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

const QUIET_SHAPES = [
  'мелкая удача: нашлось, наладилось, привезли',
  'починили то, что давно не работало',
  'спор кончился миром, договорились',
  'кто-то взялся за дело сам, без приказа',
  'вернулся тот, кого не ждали',
  'мелкая потеря: испортилось, разбилось, пропало',
  'поломка в неудобный час',
  'спор кончился ничем, разошлись злые',
  'кто-то не вышел на работу, дело встало',
  'подорожало или стало меньше, чем считали',
  'счёт и цена: сколько чего и по чём',
  'привычный порядок дня, никто не удивился',
  'работа шла как всегда, без событий',
  'разговор на площади, из которого ничего не вышло',
  'мелкая суета, которую к вечеру забыли',
];

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
 * Оптику решает жребий движка, рассказчик только пишет факт. След в статах — оценщик.
 */
export async function quietMonth({ config, runtime, domain, world, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.quiet', domainId: domain.id });
  const maxChars = chronicleMaxChars(config);
  const cfg = plotConfig(config);
  const draft = { text: null, characters: [] };

  const used = (domain.state?.quietPicks || []).slice(-cfg.quiet.avoidRepeat);
  const topic = pickAvoiding(
    QUIET_TOPICS,
    used.map((p) => p.topic),
  );
  const shape = pickFrom(QUIET_SHAPES);
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
    agentId: 'fillerNews',
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

  const fact = pushChronicle(domain, {
    text: draft.text,
    importance: 'minor',
    world,
    author: 'storyteller:quiet',
  });
  registerCharacters(domain, draft.characters, { world, author: 'storyteller:quiet' });
  rememberQuietPick(domain, { topic: topic.id, tick: world.tickIndex }, cfg.quiet.avoidRepeat);

  log.info('storyteller.quiet', {
    topic: topic.id,
    shape,
    focus,
    textPreview: truncate(draft.text, 140),
  });
  return { fact };
}

/**
 * Конец месяца: обновить синопсисы по свежей хронике.
 * «История всплыла» — сигнал; насколько поднять интерес, считает движок.
 * Один сигнал на нить за прогон: модель не может накрутить жар повторными вызовами.
 */
export async function keepStories({
  config,
  runtime,
  domain,
  world,
  chronicleAdds = [],
  log: parentLog,
}) {
  const plots = domain.plotlines || [];
  if (!plots.length) return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.keep', domainId: domain.id });
  const cfg = plotConfig(config);
  const surfaced = new Set();
  const draft = { plots: null };

  const bumpOnce = (plotId) => {
    const id = String(plotId || '').trim();
    const plot = findPlotline(domain, id);
    if (!plot) return { ok: false, error: 'unknown' };
    if (surfaced.has(id)) return { ok: true, already: true };
    surfaced.add(id);
    warmPlotlines(domain, [id], cfg);
    return { ok: true, already: false };
  };

  const tools = [
    {
      name: 'story_surfaced',
      description:
        'История всплыла: отозвалась в разговоре покровителя или перекликнулась с другой историей этого месяца. ' +
        'Вызывай по одной истории и только если отклик настоящий. Насколько поднять интерес — решит система.',
      parameters: {
        type: 'object',
        required: ['plotId'],
        properties: {
          plotId: { type: 'string', description: 'id истории из списка ниже' },
        },
      },
      handler: async ({ plotId }) => {
        const result = bumpOnce(plotId);
        if (!result.ok) return toolFail('unknown', 'Такой открытой истории нет.');
        return result;
      },
    },
    {
      name: 'submit_story_keep',
      description: 'Обновлённые синопсисы открытых историй. В конце вызови обязательно.',
      parameters: {
        type: 'object',
        required: ['plots'],
        properties: {
          plots: {
            type: 'array',
            description: 'Только те истории, чей синопсис реально изменился.',
            items: {
              type: 'object',
              required: ['plotId', 'synopsis'],
              properties: {
                plotId: { type: 'string' },
                synopsis: {
                  type: 'string',
                  description: `Как сейчас обстоят дела, до ${PLOT_SUMMARY_MAX} символов.`,
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

  const plotBlocks = plots
    .map((p) => {
      const fresh = byPlot.get(p.id) || [];
      return [
        `id ${p.id} — «${p.title}»`,
        `Сейчас: ${p.synopsis || 'только началась'}`,
        fresh.length ? `В этом месяце:\n${fresh.join('\n')}` : 'В этом месяце своей записи не было.',
      ].join('\n');
    })
    .join('\n\n');

  const monthNotes = (domain.state?.monthLog || [])
    .map((m) => `- ${m.text || m}`)
    .join('\n');
  const talk = recentPlayerTalk(domain);

  await runtime.run({
    agentId: 'storyKeep',
    tools,
    maxTurns: 6,
    toolChoice: 'required',
    log,
    scene: 'story_keep',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}».`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Конец месяца ${world.gameDate.label}. Обнови карточки открытых историй.`,
          'Синопсис — как обстоят дела СЕЙЧАС, чтобы по нему можно было продолжить. Не пересказывай хронику целиком.',
          'Развязка из хроники (нашли, умер, под стражей, в бегах) должна остаться в синопсисе. Нельзя вернуть человека в «ищем», если его уже нашли.',
          'Если у истории не было новой записи и картина не сдвинулась — не включай её в submit_story_keep.',
          'Если история отозвалась в разговоре покровителя или перекликнулась с другой историей этого месяца — вызови story_surfaced (по одной, и только тогда).',
          'Насколько поднять интерес, решит система. Новую хронику не пиши.',
          '',
          'Открытые истории:',
          plotBlocks,
          otherLines.length ? `\nПрочие записи месяца:\n${otherLines.join('\n')}` : null,
          monthNotes ? `\nЧто произошло в городе за разговоры этого месяца:\n${monthNotes}` : null,
          talk ? `\nПоследний разговор покровителя с правителем:\n${talk}` : null,
          '',
          'Сначала story_surfaced, если нужно. Затем обязательно submit_story_keep.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  let updated = 0;
  for (const item of draft.plots || []) {
    const plot = findPlotline(domain, item.plotId);
    if (!plot) continue;
    const next = clipPlotText(item.synopsis, PLOT_SUMMARY_MAX);
    if (!next) continue;
    plot.synopsis = next;
    updated += 1;
  }

  log.info('storyteller.keep', {
    plots: plots.length,
    updated,
    surfaced: [...surfaced],
  });
  return { updated, surfaced: [...surfaced] };
}
