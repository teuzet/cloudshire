/**
 * Авторы хроники. Движок решает, когда писать.
 *   storyStart    — завязка саспенса
 *   mysteryStart  — завязка тайны: сначала truth, в хронику он не идёт
 *   storyBeat     — default: поручения, старые нити, зеркала (агент как был)
 *   suspenseBeat  — бит саспенса
 *   mysteryBeat   — бит тайны (канон truth только у этого агента)
 *   orderBeat     — тик постоянного порядка
 *   storyKeep     — синопсис по свежей хронике
 *   fillerNews    — быт, когда сюжета не было
 * Главная линия сопряжения — confluxBeat, не этот модуль.
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
  newCharactersSchema,
} from './models.js';
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
  pickOpeningPlotTags,
  openingPlotCount,
  judgePlotSeed,
  warmPlotlines,
  pickStoryType,
  isThreeActPlot,
  plotBeatAgentId,
  PLOT_SUMMARY_MAX,
  PLOT_HOOK_MAX,
} from './plotlines.js';
import { pickOrderOutcome, markOrderFired } from './orders.js';
import { TINT_LABELS, pickRollStat, rollTint, formatFinishForPrompt } from './rolls.js';
import { offerNames, formatOfferedNamesForPrompt, bindCharacterNames } from './names.js';
import { assignPlotStakes } from './plotStakes.js';
import { formatActMoveForPrompt } from './storyActs.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function chronicleMaxChars(config) {
  const n = Number(config?.tick?.chronicleEntryMaxChars);
  return Number.isFinite(n) && n >= 80 ? Math.round(n) : 260;
}

function cityBrief(domain) {
  return String(domain.description || '').trim() || '(описание пусто)';
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

const CHARACTERS_SCHEMA = newCharactersSchema();

function adoptPeople(domain, list, { world, plotId = null, author = 'storyteller', config = null, texts = [], offered = null }) {
  const bound = bindCharacterNames(world, list, { offered, texts, config });
  const cast = registerCharacters(domain, bound.list, { world, plotId, author });
  return { cast, texts: bound.texts };
}

function peopleNamesBlock(world, config) {
  const offered = offerNames(world, { female: 4, male: 4 }, config);
  return { offered, block: formatOfferedNamesForPrompt(offered) };
}

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
      ageYears: c.ageYears,
      tick: world.tickIndex,
      gameDateLabel: world.gameDate?.label || null,
      author,
      relatedPlotlineIds: plotId ? [plotId] : [],
      world,
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
export async function seedPlot({
  config,
  runtime,
  domain,
  world,
  tags = null,
  fromClosed = null,
  opening = false,
  storyType: forcedType = null,
  log: parentLog,
}) {
  const storyType =
    forcedType === 'mystery' || forcedType === 'suspense' ? forcedType : pickStoryType();
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.seed', domainId: domain.id, storyType });
  const cfg = plotConfig(config);
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const roll =
      attempt === 0 && tags?.length
        ? tags
        : opening
          ? pickOpeningPlotTags(cfg)
          : pickPlotTags(cfg);
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
      fromClosed,
      opening,
      storyType,
    });
    if (!asked) {
      log.warn('storyteller.seed_failed', { attempt });
      continue;
    }

    const reason = judgePlotSeed(domain, asked, { storyType });
    if (reason) {
      log.info('storyteller.seed_rejected', {
        reason,
        attempt,
        title: asked.title,
        tags: roll.map((t) => t.tagId),
      });
      continue;
    }

    if (opening) {
      asked.importance = Math.min(40, Math.max(15, Number(asked.importance) || 25));
      asked.maxAgeMonths = Math.min(5, Math.max(2, Number(asked.maxAgeMonths) || 4));
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
      relatedPlotlineIds: fromClosed?.id ? [fromClosed.id] : [],
      storyType,
      act: 1,
      truth: storyType === 'mystery' ? String(asked.truth || '').trim() : '',
      config,
    });
    domain.plotlines.push(plot);
    await assignPlotStakes({ runtime, domain, plot, world, log });

    const fact = pushChronicle(domain, {
      text: asked.entry,
      importance: Number(asked.importance) >= 70 ? 'major' : 'minor',
      world,
      plotIds: [plot.id],
      author: 'storyteller:seed',
    });
    const adopted = adoptPeople(domain, asked.newCharacters, {
      world,
      plotId: plot.id,
      author: 'storyteller:seed',
      texts: [asked.entry],
      offered: draft.offered,
    });
    if (adopted.texts[0] && adopted.texts[0] !== fact.text) {
      fact.text = adopted.texts[0];
    }
    const cast = adopted.cast;

    log.info('storyteller.seed', {
      plotId: plot.id,
      title: plot.title,
      attempt,
      sequelOf: fromClosed?.id || null,
      importance: plot.importance,
      storyType: plot.storyType,
      urgency: plot.urgency,
      gravity: plot.gravity,
      maxAgeMonths: plot.maxAgeMonths,
      relatedStats: plot.relatedStats,
      cast: cast.map((c) => c.name),
    });
    return { plot, fact, cast };
  }

  log.info('storyteller.seed_skipped', { reason: 'no_clean_seed' });
  return null;
}

/** 1–2 коротких истории сразу после генезиса. Ошибка посева город не ломает. */
export async function seedOpeningPlots({ config, runtime, domain, world, log: parentLog, rng = Math.random }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.opening', domainId: domain.id });
  const want = openingPlotCount(config, rng);
  if (want <= 0) return [];
  const seeded = [];
  for (let i = 0; i < want; i += 1) {
    try {
      const one = await seedPlot({
        config,
        runtime,
        domain,
        world,
        opening: true,
        log,
      });
      if (one?.plot) seeded.push(one);
    } catch (err) {
      log.warn('storyteller.opening_failed', { error: err.message, index: i });
    }
  }
  log.info('storyteller.opening_done', {
    wanted: want,
    got: seeded.length,
    titles: seeded.map((s) => s.plot.title),
  });
  return seeded;
}

async function askPlotSeed({
  runtime,
  domain,
  world,
  tags,
  log,
  maxChars,
  statIds,
  draft,
  fromClosed = null,
  opening = false,
  storyType = 'suspense',
}) {
  const mystery = storyType === 'mystery';
  const required = ['title', 'synopsis', 'closeWhen', 'importance', 'maxAgeMonths', 'relatedStats', 'entry'];
  if (mystery) required.push('truth');
  const tools = [
    {
      name: 'submit_plot_seed',
      description: mystery
        ? 'Новая тайна: сначала канон разгадки (truth), потом экспозиция, из которой разгадки не следует.'
        : 'Новая история-саспенс: завязка, как она начинается в этом месяце, и карточка для продолжения.',
      parameters: {
        type: 'object',
        required,
        properties: {
          title: { type: 'string', description: 'Название, 1–4 слова' },
          synopsis: {
            type: 'string',
            description: mystery
              ? `Как сейчас обстоят дела и куда это может пойти, до ${PLOT_SUMMARY_MAX} символов. ` +
                'По этому тексту историю будут продолжать. Разгадку тайны сюда не пиши.'
              : `Как сейчас обстоят дела и куда это может пойти, до ${PLOT_SUMMARY_MAX} символов. ` +
                'По этому тексту историю будут продолжать.',
          },
          closeWhen: {
            type: 'string',
            description: mystery
              ? `Что должно произойти, чтобы тайну считали разгаданной. Одна фраза, до ${PLOT_HOOK_MAX} символов.`
              : `Что должно произойти, чтобы историю закрыть по существу. Одна фраза, до ${PLOT_HOOK_MAX} символов.`,
          },
          importance: {
            type: 'number',
            description: '0–100. Держись масштаба жребия: город ≈ 55, остров ≈ 75.',
          },
          maxAgeMonths: {
            type: 'number',
            description: 'Сколько месяцев история живёт без внимания (1–12).',
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Каких сторон жизни касается, 1–3 из: ${statIds}. Первый — главный.`,
          },
          entry: {
            type: 'string',
            description: mystery
              ? `Экспозиция этого месяца, до ${maxChars} символов. Разгадку не называй и не намекай впрямую.`
              : `Что случилось в этом месяце, до ${maxChars} символов. Сухой факт.`,
          },
          truth: mystery
            ? {
                type: 'string',
                description:
                  'Полная разгадка тайны: что на самом деле было. Не попадёт в хронику и не будет видно правителю. Только движок и агент бита.',
              }
            : undefined,
          newCharacters: CHARACTERS_SCHEMA,
        },
      },
      handler: async (args) => {
        if (!String(args.title || '').trim() || !String(args.entry || '').trim() || !String(args.synopsis || '').trim()) {
          return toolFail('empty', 'Нужны название, синопсис и запись хроники.');
        }
        if (mystery && !String(args.truth || '').trim()) {
          return toolFail('empty', 'Нужна разгадка тайны в поле truth.');
        }
        draft.data = args;
        return { ok: true };
      },
    },
  ];
  if (!mystery) delete tools[0].parameters.properties.truth;

  const city = cityStoryContext(domain);
  const open = (domain.plotlines || [])
    .map((p) => {
      const kind = p.kind === 'errand' ? 'текущее дело' : p.kind === 'order' ? 'постоянный порядок' : 'история';
      return `- «${p.title}» (${kind}): ${p.synopsis || 'только началась'}`;
    })
    .join('\n');

  const names = peopleNamesBlock(world);
  draft.offered = names.offered;

  await runtime.run({
    agentId: mystery ? 'mysteryStart' : 'storyStart',
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
          mystery
            ? `Придумай новую ТАЙНУ города (${world.gameDate.label}). Тип уже выбран движком.`
            : `Придумай новую историю-саспенс города (${world.gameDate.label}). Тип уже выбран движком.`,
          mystery
            ? [
                'Сначала придумай разгадку (`truth`) — что на самом деле происходит.',
                'Потом напиши завязку (`entry`, `synopsis`), из которой правда ещё не читается.',
                '`closeWhen` — когда тайна считается разгаданной, без самой разгадки.',
                '`truth` никуда больше не копируй: не в entry, не в synopsis, не в closeWhen.',
              ].join('\n')
            : [
                'Фокусируйся на саспенсе — развитии истории.',
                'Отдавай приоритет продвижению сюжета вперёд, развитию конфликтов, сюжетным поворотам, а не открытию неизвестной информации.',
                'Это не поручение правителя и не сопряжение — сюжет, который остров проживает сам.',
              ].join('\n'),
          fromClosed
            ? [
                `Только что закрылась история «${fromClosed.title}».`,
                fromClosed.synopsis ? `Как она шла: ${fromClosed.synopsis}` : null,
                fromClosed.lastEntry ? `Чем кончилась в этом месяце: ${fromClosed.lastEntry}` : null,
                fromClosed.reason ? `Развязка: ${fromClosed.reason}` : null,
                `Что осталось нерешённым: ${fromClosed.hook}`,
                'Новая история растёт из этого остатка: свой предмет и своя развязка, не повтор уже закрытого.',
              ]
                .filter(Boolean)
                .join('\n')
            : opening
              ? [
                  'Это СТАРТ нового города: короткая живая завязка, не катастрофа и не тайна мироздания.',
                  'Масштаб — соседство или несколько человек. Важность 15–35, срок 2–5 месяцев.',
                  'Игрок сразу должен понять, куда можно вмешаться: решение, поручение или вопрос правителю.',
                  'Не делай проклятие всего острова, войну, мор и конец света.',
                ].join(' ')
              : 'Завязка должна быть оригинальной и интересной — такой, чтобы захотелось узнать, что будет дальше.',
          '',
          `Направление: ${formatPlotTagsForPrompt(tags)}`,
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
          names.block,
          '',
          mystery
            ? 'Напиши экспозицию этого месяца: что увидели, без разгадки.'
            : 'Напиши первую запись: что увидели в этом месяце.',
          'Синопсис — как обстоят дела сейчас, чтобы по нему можно было продолжить.',
          'closeWhen — условие настоящей развязки, не инструкция на последний месяц. ' +
            'Если это условие выполнится раньше срока (нашли пропавшую на шестом месяце из двенадцати) — историю можно закрыть сразу.',
          'Вызови submit_plot_seed.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  return draft.data;
}

const PRIOR_CHRONICLE_LIMIT = 30;
const WATCH_RE = /розыск|задерж|пойм|арест|угроз|подозрева|разыск/i;

/** Уже записанное по этой нити — иначе следующий бит сочиняет поиск заново. */
export function priorPlotChronicle(domain, plot, limit = PRIOR_CHRONICLE_LIMIT) {
  if (!plot) return [];
  const ids = new Set((plot.chronicleIds || []).map(String));
  return chronicleEntries(domain?.lore)
    .filter((e) => ids.has(String(e.id)) || (e.relatedPlotlineIds || []).includes(plot.id))
    .sort((a, b) => (Number(a.tick) || 0) - (Number(b.tick) || 0))
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

  const threeAct = isThreeActPlot(plot);
  const mystery = threeAct && plot.storyType === 'mystery';
  const engineEnding = beat.actMove?.ending || plot.ending || null;
  const finale = Boolean(beat.finale || engineEnding);
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
            description: threeAct
              ? 'Игнорируется: закрытие трёхтактной истории решает движок, не ты.'
              : 'true только если в ЭТОМ месяце случилось условие закрытия истории. ' +
                'Срок нити сам по себе не повод. Не выдумывай развязку, потому что «пора кончать».',
          },
          closeReason: { type: 'string' },
          sequelHook: {
            type: 'string',
            description: threeAct
              ? 'Только если история закрывается: если развязка сама оставила новый нерешённый узел — одна фраза, что осталось. ' +
                'Нет узла — оставь пустым. Это не пересказ конца и не готовая следующая история.'
              : 'Только при closes=true: если развязка сама оставила новый нерешённый узел — одна фраза, что осталось. ' +
                'Нет узла — оставь пустым. Это не пересказ конца и не готовая следующая история.',
          },
          touchesNeighbor: {
            type: 'boolean',
            description:
              'Только при сопряжении: правда ли этот поворот задел соседний город ' +
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
          `Исход броска (не спорь): ${formatFinishForPrompt(outcome.finish, { blessed: outcome.blessed })}.`,
          outcome.goal ? `Цель дела: ${outcome.goal}` : null,
          outcome.detail ? `Поручение было: ${outcome.detail}` : null,
        ]
          .filter(Boolean)
          .join(' ')
      : outcome.kind === 'stall'
        ? threeAct
          ? `Связанное дело «${outcome.summary}» встало: месяц без сдвига — расскажи, что помешало. Такт и ставки не меняй.`
          : `Связанное дело «${outcome.summary}» встало: месяц без сдвига — расскажи, что помешало.`
        : threeAct
          ? `Связанное дело «${outcome.summary}» пошло быстрее обычного — расскажи, что позволило. Такт и ставки не меняй.`
          : `Связанное дело «${outcome.summary}» пошло быстрее обычного — расскажи, что позволило.`
    : null;

  const prior = priorPlotChronicle(domain, plot);
  const watched = peopleUnderWatch(domain);
  const names = peopleNamesBlock(world);
  const ruler = rulerName(domain);
  const actBlock = threeAct ? formatActMoveForPrompt(plot, beat.actMove) : '';

  const closeHint = threeAct
    ? engineEnding
      ? 'Движок уже закрывает историю. closes не выбирай. Если развязка оставила новый нерешённый узел — sequelHook одной фразой, иначе пусто.'
      : 'Историю этим месяцем не закрывай. closes не выбирай.'
    : finale
      ? 'Проходное дело закончилось: покажи итог. closes=true.'
      : outcome?.finished
        ? 'Дело закончилось. Напиши его итог, не отменяя уже записанную хронику: если человека нашли — не пиши, что его всё ещё ищут. closes=true, только если этим исполнилось условие закрытия самой истории.'
        : 'Сдвинь историю по исходу броска. closes=true — только если в этом месяце случилось условие закрытия, даже если до срока ещё далеко. Не закрывай и не выдумывай развязку просто потому что нить старая. Если закрываешь и после развязки остался новый нерешённый узел — sequelHook одной фразой, иначе пусто.';

  await runtime.run({
    agentId: plotBeatAgentId(plot),
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_plot_beat' } },
    log,
    scene: 'plot_beat',
    domainId: domain.id,
    extraSystem: [
      `Город «${domain.name}». ${cityBrief(domain)}`,
      ruler ? `Правитель города — ${ruler}. Этого человека в newCharacters не заводи, второго с тем же именем тоже.` : null,
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 12 })}`,
      mystery && plot.truth
        ? `ТАЙНА (канон, не в хронику пока движок не велел):\n${plot.truth}`
        : null,
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
          actBlock || null,
          !threeAct && !beat.skipTint ? `ИСХОД ЭТОГО МЕСЯЦА (решено броском, не спорь): ${TINT_LABELS[beat.tint]}.` : null,
          !threeAct && beat.statId ? `Решала сторона города: ${beat.statId}.` : null,
          processLine,
          closeHint,
          partner
            ? `Города сейчас в сопряжении с «${partner.name}». Если поворот реально задел соседа — ` +
              'touchesNeighbor=true и одна фраза в neighborNote. Внутренние дела соседа не касаются.'
            : null,
          logLine ? `В городе этим месяцем: ${logLine}` : null,
          '',
          names.block,
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
  const finishToken = engineEnding || (outcome?.finished ? outcome.finish || null : null);
  const major =
    Boolean(engineEnding) ||
    (!threeAct && (beat.finale || d.closes)) ||
    plot.importance >= 70;

  const fact = pushChronicle(domain, {
    text: d.entry,
    importance: major ? 'major' : 'minor',
    world,
    plotIds: [plot.id],
    processId: outcome?.processId || null,
    processFinish: finishToken,
    author: 'storyteller:beat',
  });

  const adopted = adoptPeople(domain, d.newCharacters, {
    world,
    plotId: plot.id,
    author: 'storyteller:beat',
    texts: [d.entry, d.synopsis],
    offered: names.offered,
  });
  if (adopted.texts[0]) fact.text = adopted.texts[0];
  if (adopted.texts[1]) d.synopsis = adopted.texts[1];
  const cast = adopted.cast;

  if (Array.isArray(d.relatedStats) && d.relatedStats.length) {
    const allowed = new Set((config.stats || []).map((s) => s.id));
    const next = d.relatedStats.map(String).filter((id) => allowed.has(id));
    if (next.length) plot.relatedStats = next;
  }
  plot.lastBeatTick = world.tickIndex;
  plot.beatCount += 1;

  const wantClose = threeAct ? Boolean(engineEnding) : Boolean(d.closes || beat.finale);
  const closed = wantClose && !plotHasActiveProcess(domain, plot);
  const closeReason = threeAct
    ? engineEnding === 'crit'
      ? 'критический успех'
      : engineEnding === 'fail'
        ? 'провал'
        : 'успех'
    : d.closeReason || (beat.finale ? 'дело закончилось' : 'условие закрытия исполнилось');
  const sequelHook =
    closed && plot.kind !== 'errand' ? clipPlotText(String(d.sequelHook || '').trim(), PLOT_HOOK_MAX) : '';
  if (closed) {
    closePlotline(domain, plot.id, {
      tick: world.tickIndex,
      reason: closeReason,
      sequelHook,
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
    sequelHook: sequelHook || null,
    cast: cast.map((c) => c.name),
    mirrored: mirror?.plot?.id || null,
    textPreview: truncate(d.entry, 160),
  });

  return { fact, plot, closed, closeReason, sequelHook, mirror };
}

function statValue(domain, statId) {
  const v = Number(domain?.stats?.[statId]);
  return Number.isFinite(v) ? v : 50;
}

/**
 * Тик постоянного порядка. Формат (история | хроника) уже брошен движком.
 * Историю пишем как обычный story; хронику — на нити указа. Синопсис указа не трогаем.
 */
export async function tickOrder({
  config,
  runtime,
  domain,
  world,
  plot,
  mode,
  log: parentLog,
}) {
  if (!plot || plot.kind !== 'order') return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.order', domainId: domain.id });
  const cfg = plotConfig(config);
  const resolvedMode = mode === 'story' || mode === 'chronicle' ? mode : pickOrderOutcome(domain, cfg);
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const statId = pickRollStat(plot.relatedStats, Math.random, cfg.roll);
  const tintRoll = rollTint(statValue(domain, statId), Math.random, cfg.roll);
  const tint = tintRoll.tint;
  const ruler = rulerName(domain);
  const prior = priorPlotChronicle(domain, plot);
  const toolName = resolvedMode === 'story' ? 'submit_order_story' : 'submit_order_chronicle';

  const chronicleFields = {
    entry: {
      type: 'string',
      description: `Что случилось в этом месяце из-за этого порядка, до ${maxChars} символов. Сухой факт.`,
    },
    relatedStats: {
      type: 'array',
      items: { type: 'string' },
      description: `Каких сторон жизни касается, 1–3 из: ${statIds}. Первый — главный.`,
    },
    newCharacters: CHARACTERS_SCHEMA,
  };

  const tools =
    resolvedMode === 'story'
      ? [
          {
            name: 'submit_order_story',
            description: 'Завязка обычной истории, которая выросла из этого постоянного порядка.',
            parameters: {
              type: 'object',
              required: ['title', 'synopsis', 'closeWhen', 'importance', 'maxAgeMonths', 'relatedStats', 'entry'],
              properties: {
                title: { type: 'string', description: 'Название, 1–4 слова' },
                synopsis: {
                  type: 'string',
                  description: `Как сейчас обстоят дела и куда это может пойти, до ${PLOT_SUMMARY_MAX} символов.`,
                },
                closeWhen: {
                  type: 'string',
                  description: `Что должно произойти, чтобы эту историю закрыть. До ${PLOT_HOOK_MAX} символов.`,
                },
                importance: {
                  type: 'number',
                  description: '0–100. Держись масштаба случая, не всего указа сразу.',
                },
                maxAgeMonths: {
                  type: 'number',
                  description: 'Сколько месяцев история живёт без внимания (1–12).',
                },
                ...chronicleFields,
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
        ]
      : [
          {
            name: 'submit_order_chronicle',
            description: 'Запись хроники о том, как в этом месяце жил постоянный порядок.',
            parameters: {
              type: 'object',
              required: ['entry'],
              properties: chronicleFields,
            },
            handler: async (args) => {
              if (!String(args.entry || '').trim()) return toolFail('empty', 'Нужна запись хроники.');
              draft.data = args;
              return { ok: true };
            },
          },
        ];

  const modifier = (domain.state?.modifiers || []).find((m) => m.id === plot.modifierId);
  const rule = modifier?.text || plot.title;

  await runtime.run({
    agentId: 'orderBeat',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: toolName } },
    log,
    scene: resolvedMode === 'story' ? 'order_story' : 'order_chronicle',
    domainId: domain.id,
    extraSystem: [
      `Город «${domain.name}». ${cityBrief(domain)}`,
      ruler ? `Правитель города — ${ruler}. Этого человека в newCharacters не заводи.` : null,
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 12 })}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          `Постоянный порядок «${plot.title}» (${world.gameDate.label}).`,
          `Правило: ${rule}`,
          `Как устроен: ${plot.synopsis || 'только объявлен'}`,
          plot.closeWhen ? `Порядок снимут, когда: ${plot.closeWhen}` : null,
          prior.length ? `\nУже писали про этот порядок:\n${prior.join('\n')}` : null,
          '',
          `ИСХОД ЭТОГО МЕСЯЦА (решено броском, не спорь): ${TINT_LABELS[tint]}.`,
          resolvedMode === 'story'
            ? [
                'Формат уже решён: заведи ОБЫЧНУЮ историю, которая выросла из этого порядка.',
                'Это не продолжение карточки указа и не новое правило. Конкретный случай: бунт из-за налога, ложный избранный, саботаж осмотра.',
                'Первая запись — что увидели в этом месяце. Синопсис — как обстоят дела у ЭТОЙ истории, не у указа.',
                'Карточку самого порядка не переписывай.',
                'Вызови submit_order_story.',
              ].join(' ')
            : [
                'Формат уже решён: одна запись хроники на нити этого порядка, без новой истории.',
                'Покажи, как правило отозвалось в жизни города в этом месяце. Не развивай интригу к развязке.',
                'Карточку порядка не переписывай.',
                'Вызови submit_order_chronicle.',
              ].join(' '),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!draft.data) {
    log.warn('storyteller.order_failed', { plotId: plot.id, mode: resolvedMode });
    const fact = pushChronicle(domain, {
      text: `Порядок «${plot.title}» снова дал о себе знать.`,
      importance: 'minor',
      world,
      plotIds: [plot.id],
      author: 'storyteller:order-fallback',
    });
    markOrderFired(plot, world.tickIndex);
    return { fact, plot, mode: 'chronicle', spawned: null };
  }

  const d = draft.data;
  let spawned = null;
  let fact = null;

  if (resolvedMode === 'story') {
    const reason = judgePlotSeed(domain, d);
    if (!reason) {
      spawned = createPlotline({
        title: d.title,
        synopsis: d.synopsis,
        closeWhen: d.closeWhen,
        relatedStats: d.relatedStats,
        importance: d.importance,
        maxAgeMonths: d.maxAgeMonths,
        temperature: cfg.temperature.initial,
        tick: world.tickIndex,
        relatedPlotlineIds: [plot.id],
        config,
      });
      domain.plotlines.push(spawned);
      if (!plot.relatedPlotlineIds.includes(spawned.id)) plot.relatedPlotlineIds.push(spawned.id);
      fact = pushChronicle(domain, {
        text: d.entry,
        importance: Number(d.importance) >= 70 ? 'major' : 'minor',
        world,
        plotIds: [spawned.id],
        author: 'storyteller:order-story',
      });
    } else {
      log.info('storyteller.order_story_rejected', { reason, title: d.title });
    }
  }

  if (!fact) {
    fact = pushChronicle(domain, {
      text: d.entry,
      importance: 'minor',
      world,
      plotIds: [plot.id],
      author: 'storyteller:order',
    });
  }

  const plotIdForCast = spawned?.id || plot.id;
  registerCharacters(domain, d.newCharacters, { world, plotId: plotIdForCast, author: 'storyteller:order' });
  if (Array.isArray(d.relatedStats) && d.relatedStats.length) {
    const allowed = new Set((config.stats || []).map((s) => s.id));
    const next = d.relatedStats.map(String).filter((id) => allowed.has(id));
    if (next.length && !spawned) plot.relatedStats = next;
  }
  markOrderFired(plot, world.tickIndex);

  log.info('storyteller.order', {
    plotId: plot.id,
    title: plot.title,
    mode: spawned ? 'story' : 'chronicle',
    spawnedId: spawned?.id || null,
    tint,
    textPreview: truncate(d.entry, 160),
  });
  return { fact, plot, mode: spawned ? 'story' : 'chronicle', spawned };
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
  const draft = { text: null };

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
      description: 'Одна запись о тихом месяце: погода, цены, быт. Без личных имён.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: { type: 'string', description: `Сухой факт быта, до ${maxChars} символов. Без личных имён.` },
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
    extraSystem: `Город «${domain.name}». ${cityBrief(domain)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Месяц ${world.gameDate.label} прошёл без больших событий${season ? ` (${season})` : ''}.`,
          `О чём запись: ${topic.text}.`,
          `Кто в кадре: ${focus}.`,
          `Что за случай: ${shape}.`,
          'Одна запись: место этого города, ремесло или случай, предметный исход.',
          'Людей по имени не называй — ни известных, ни новых.',
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
  const plots = (domain.plotlines || []).filter((p) => p.kind !== 'order');
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
