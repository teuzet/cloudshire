import { newId } from './ids.js';
import {
  rollPopulation,
  allocateStats,
  syncFaith,
  isForbiddenDomainName,
} from './stats.js';
import {
  createCharacter,
  createDomainRecord,
  createLoreFact,
  assembleDescription,
  applyPatronName,
  inferRulerGender,
} from './models.js';
import { formatPlayerBrief } from './onboarding.js';
import { seedOpeningPlots } from './storyteller.js';
import { ensureCityEntities } from './cityEntities.js';
import {
  clipCityText,
  CITY_BRIEF_MAX,
  parseCityBrief,
  formatCityBrief,
  normalizeCanonicalUnknowns,
} from './cityContext.js';
import { takeName } from './names.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { formatWorldContractForPrompt } from './worldContract.js';
import { formatFrozenConceptForPrompt, openingLoreFromConcept } from './genesisConcept.js';
import { axesSnapshotTags, normalizeAxesState } from './genesisAxes.js';
import { generateOfficers, requestCityStrengths } from './officers.js';

function aspectDefs(config) {
  return config.genesis.aspects || [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Канон мира приходит агенту через agents.genesis.canon; здесь только частности генезиса. */
function cosmologyBlock() {
  return [
    'ИЗОЛЯЦИЯ ДЛЯ ГЕНЕЗИСА (жёстко):',
    '- Нет регулярных путей, паломничеств, караванов и «соседних регионов» на твёрдой земле.',
    '- Нет материка, соседних провинций, приезжих из других городов как бытовой нормы.',
    '- Не выдумывай чужие народы у ворот и торговлю с чужими островами.',
    '- Хозяйство, вера, праздники, торговля — внутри СВОЕГО острова (~20 км до обрыва).',
    '- «Паломничество» бывает только местным (свой храм, свой край), не с других островов.',
    '- Low-magic: магия есть, но не повсеместна. Не делай школы заклинаний и магические пропитки нормой быта.',
  ].join('\n');
}

function fallbackName() {
  const names = ['Ирмала', 'Кальдра', 'Тавронь', 'Сатрея', 'Улдин', 'Веналь', 'Мардон', 'Оренга'];
  return names[Math.floor(Math.random() * names.length)];
}

function bindRulerName(world, core, config) {
  if (!core) return core;
  const gender = inferRulerGender({
    title: core.rulerTitle,
    name: core.rulerName,
  });
  const old = String(core.rulerName || '').trim();
  const next = takeName(world, gender, config);
  core.rulerName = next;
  core.rulerGender = gender;
  if (old && old !== next) {
    const swap = (s) => String(s || '').split(old).join(next);
    core.rulerDescription = swap(core.rulerDescription);
    core.greeting = swap(core.greeting);
    core.openingLore = (core.openingLore || []).map(swap);
  }
  return core;
}

function looksLikeTouristGreeting(text) {
  const t = String(text || '');
  return (
    /добро\s+пожалов/i.test(t) ||
    /пронизыва/i.test(t) ||
    /каждый\s+уголок/i.test(t) ||
    /добро\s+пожаловать\s+в/i.test(t) ||
    /здесь\s+вас?\s+ждут/i.test(t) ||
    /волшебство\s+прониз/i.test(t) ||
    /приятного\s+пребыв/i.test(t)
  );
}

function greetingAsksForName(text) {
  return /как\s+(тебя|вам|нам)\s+(звать|обращ)|назов(и|ите)\s+(себя|имя)|как\s+к\s+тебе\s+обращ/i.test(
    String(text || ''),
  );
}

function looksLikePatronAddress(text, patronName = null) {
  const t = String(text || '');
  if (looksLikeTouristGreeting(t)) return false;
  if (patronName) {
    return t.toLowerCase().includes(String(patronName).toLowerCase()) && !greetingAsksForName(t);
  }
  return /покровител|божеств|как\s+(тебя|вам|нам)\s+(звать|обращ)|назов|имя|знак|воли|слышу\s+тебя|алтар/i.test(t);
}

function defaultGreeting(domainName, patronName = null) {
  if (patronName) {
    return `${patronName}, я слышу тебя над «${domainName}». Город ждёт твоего слова.`;
  }
  return (
    `Покровитель, я слышу тебя над «${domainName}». ` +
    'Как нам к тебе обращаться — скажи имя или знак. Город ждёт твоего слова.'
  );
}

function fallbackCore(lockedName, playerBrief, patronName = null, frozenConcept = null) {
  const name = frozenConcept?.name || lockedName || fallbackName();
  const rulerWish =
    frozenConcept?.ruler?.description ||
    playerBrief?.ruler ||
    'Сдержанный правитель, внимательный к знамениям покровителя.';
  const lore = openingLoreFromConcept(frozenConcept || { name });
  return {
    domainName: name,
    rulerName: /жриц/i.test(rulerWish) ? 'Ицка' : 'Кайрен',
    rulerTitle: frozenConcept?.ruler?.title || (/жриц/i.test(rulerWish) ? 'Верховная жрица' : 'Правитель'),
    rulerAge: 40,
    rulerDescription: rulerWish,
    greeting: defaultGreeting(name, patronName),
    openingLore: lore.length
      ? lore
      : [
          `Город «${name}» стоит в центре летающего острова.`,
          'От стен до края острова — порядка двадцати километров земли.',
          'За обрывом — облака и ветер.',
          'Жители чтят покровителя и местные обряды.',
          'Главная площадь открыта к небу.',
          'Рынок собирается трижды в неделю.',
          'Стража несёт вахту у края острова.',
          'Совет старейшин собирается при храме.',
        ],
  };
}

/**
 * Step 1: имя, правитель, факты, приветствие.
 */
async function generateCore({
  config,
  runtime,
  population,
  forcedName,
  forcedPatronName = null,
  playerBrief,
  frozenConcept = null,
  onProgress,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ step: 'core' });
  const loreMin = Math.min(8, config.genesis.openingLoreCount?.min || 12);
  const draft = { submitted: null, lastError: null };
  const lockedName = frozenConcept?.name
    ? String(frozenConcept.name).trim()
    : forcedName
      ? String(forcedName).trim()
      : null;
  const lockedPatron = forcedPatronName ? String(forcedPatronName).trim() : null;
  const briefText = formatPlayerBrief(playerBrief);

  const tools = [
    {
      name: 'submit_core',
      description: 'Ядро домена: имя, правитель, greeting, openingLore (8+ коротких фактов)',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'domainName',
          'rulerName',
          'rulerTitle',
          'rulerDescription',
          'greeting',
          'openingLore',
        ],
        properties: {
          domainName: {
            type: 'string',
            description: lockedName
              ? `ОБЯЗАТЕЛЬНО точно: ${lockedName}`
              : 'Придуманное имя кириллицей: не русское и не земное',
          },
          rulerName: {
            type: 'string',
            description: 'Одно придуманное имя кириллицей, без фамилии и отчества',
          },
          rulerAge: {
            type: 'integer',
            description: 'Возраст правителя в полных годах (примерно 20–70).',
          },
          rulerTitle: { type: 'string' },
          rulerDescription: {
            type: 'string',
            description: 'Характер правителя-связного; учти пожелания игрока',
          },
          greeting: {
            type: 'string',
            description: lockedPatron
              ? `Первая реплика правителя к «${lockedPatron}» (1–3 предложения). Слуга снизу вверх, по имени. Не проси, как звать.`
              : 'Первая реплика правителя/жреца К божеству-покровителю (1–3 предложения). ' +
                'Слуга снизу вверх: слышит голос, просит имя/знак обращения, ждёт воли. ' +
                'НЕ туристическое «добро пожаловать в город», НЕ реклама острова.',
          },
          openingLore: {
            type: 'array',
            items: { type: 'string' },
            description: `Массив из ≥${loreMin} сухих фактов`,
          },
        },
      },
      handler: async (args) => {
        const fixed = { ...args };
        if (lockedName) fixed.domainName = lockedName;

        if (!fixed.domainName || isForbiddenDomainName(fixed.domainName)) {
          draft.lastError = 'Плохое имя';
          return toolFail(
            'bad_domain_name',
            'Имя города плохое или запрещённое. Придумай звучное фэнтезийное имя места (не общее «город», не маты, не «летающий остров»).',
          );
        }

        let lore = Array.isArray(fixed.openingLore) ? fixed.openingLore.filter(Boolean) : [];
        while (lore.length < loreMin) {
          lore.push(`Факт основания ${lore.length + 1}: город помнит знак покровителя.`);
        }
        fixed.openingLore = lore.slice(0, 20);

        if (!String(fixed.greeting || '').trim()) {
          fixed.greeting = defaultGreeting(fixed.domainName, lockedPatron);
        }
        if (String(fixed.greeting).length > 600) {
          fixed.greeting = String(fixed.greeting).slice(0, 500);
        }
        if (
          looksLikeTouristGreeting(fixed.greeting) ||
          !looksLikePatronAddress(fixed.greeting, lockedPatron)
        ) {
          draft.lastError = lockedPatron
            ? `greeting: речь слуги к «${lockedPatron}», без просьбы имени`
            : 'greeting: нужна речь слуги к божеству (имя/знак), не «добро пожаловать в город»';
          return toolFail(
            'bad_greeting',
            lockedPatron
              ? `greeting: обратись к «${lockedPatron}» по имени и не проси, как звать.`
              : 'greeting: нужна речь слуги к божеству (просить имя/знак), не туристическое «добро пожаловать в город». Перепиши greeting.',
          );
        }
        if (!fixed.rulerName) fixed.rulerName = 'Кайрен';
        if (!fixed.rulerTitle) fixed.rulerTitle = 'Правитель';
        const age = Math.round(Number(fixed.rulerAge));
        fixed.rulerAge = Number.isFinite(age) ? Math.max(18, Math.min(80, age)) : 32 + Math.floor(Math.random() * 20);
        if (!fixed.rulerDescription) {
          fixed.rulerDescription = playerBrief?.ruler || 'Внимательный к знамениям глава города.';
        }

        draft.submitted = fixed;
        draft.lastError = null;
        return { ok: true };
      },
    },
  ];

  await onProgress?.('ядро города');
  log.info('genesis.core.begin', {
    lockedName,
    briefPreview: truncate(briefText, 400),
    loreMin,
  });

  const basePrompt = [
    'Создай ЯДРО города. Обязательно вызови submit_core.',
    cosmologyBlock(),
    `Население (внутреннее): ${population}`,
    lockedName
      ? `Имя города УЖЕ выбрано: «${lockedName}» — поле domainName = точно это.`
      : 'Имя города — придуманное, кириллицей, не русское и не земное.',
    '',
    'ПОЖЕЛАНИЯ ИГРОКА:',
    briefText,
    '',
    frozenConcept
      ? [
          'ЗАМОРОЖЕННЫЙ КОНЦЕПТ (не выдумывай другой город):',
          formatFrozenConceptForPrompt(frozenConcept),
          '',
          'openingLore: скопируй постоянные факты из концепта (не новости месяца). Не выдумывай цистерны и прочий канон «по умолчанию».',
        ].join('\n')
      : `openingLore: минимум ${loreMin} коротких ПОСТОЯННЫХ фактов (не новости месяца).`,
    '',
    `openingLore: минимум ${loreMin} коротких строк.`,
    'Учти изоляцию острова: без паломников/торговцев «из соседних регионов».',
    '',
    lockedPatron
      ? [
          `Имя покровителя УЖЕ дано: «${lockedPatron}». Храм и культ города — его.`,
          'greeting — ПЕРВАЯ РЕПЛИКА правителя к этому богу по имени:',
          `- Обратись «${lockedPatron}». Не проси, как звать: имя уже известно.`,
          '- 1–3 коротких предложения, живая речь от первого лица.',
          '- ЗАПРЕЩЕНО: «Добро пожаловать в …», реклама острова, гид по городу.',
        ].join('\n')
      : [
          'greeting — ПЕРВАЯ РЕПЛИКА правителя/жреца божеству-покровителю (не игроку-туристу):',
          '- Ты слуга снизу вверх: голос дошёл до алтаря / ты слышишь покровителя.',
          '- Попроси, как обращаться: имя, титул или знак. Или попроси сказать волю.',
          '- 1–3 коротких предложения, живая речь от первого лица.',
          '- ЗАПРЕЩЕНО: «Добро пожаловать в …», реклама острова («волшебство пронизывает…»),',
          '  гид по достопримечательностям, тон онбординга/брошюры.',
          '- Пример тона: «Покровитель, я слышу тебя над [город]. Как нам звать тебя? Скажи знак — народ ждёт.»',
        ].join('\n'),
  ].join('\n');

  for (let attempt = 1; attempt <= 3 && !draft.submitted; attempt += 1) {
    const nudge =
      attempt === 1
        ? basePrompt
        : [
            basePrompt,
            '',
            `Попытка ${attempt}: прошлый вызов не принят (${draft.lastError || 'нет submit_core'}).`,
            'Снова вызови submit_core. Имя не меняй. openingLore — простой массив строк.',
            draft.lastError && /greeting/i.test(draft.lastError)
              ? lockedPatron
                ? `greeting перепиши: обратись к «${lockedPatron}» по имени, не проси как звать.`
                : 'greeting перепиши: слуга к божеству, просьба имени/знака; без «добро пожаловать».'
              : '',
          ]
            .filter(Boolean)
            .join('\n');

    const result = await runtime.run({
      agentId: 'genesis',
      userMessages: [{ role: 'user', content: nudge }],
      tools,
      maxTurns: 6,
      toolChoice: { type: 'function', function: { name: 'submit_core' } },
      log,
      scene: 'genesis_core',
    });

    if (!draft.submitted) {
      const fails = (result.toolTrace || [])
        .filter((t) => t.result && t.result.ok === false)
        .map((t) => t.result.error)
        .join('; ');
      draft.lastError = fails || draft.lastError || 'submit_core не вызван';
      log.warn('genesis.core.attempt_failed', {
        attempt,
        lastError: draft.lastError,
        tools: (result.toolTrace || []).map((t) => ({
          name: t.name,
          ok: t.result?.ok !== false,
          error: t.result?.error,
        })),
        truncated: Boolean(result.truncated),
        replyPreview: truncate(result.text, 200),
      });
    } else {
      log.info('genesis.core.ok', {
        attempt,
        domainName: draft.submitted.domainName,
        rulerName: draft.submitted.rulerName,
        loreCount: draft.submitted.openingLore?.length,
      });
    }
  }

  if (!draft.submitted) {
    log.warn('genesis.core.fallback', { lastError: draft.lastError });
    draft.submitted = fallbackCore(lockedName, playerBrief, lockedPatron, frozenConcept);
  }
  return draft.submitted;
}

/**
 * Step 2: аспекты пачками по 4.
 */
async function generateAspectBatch({
  config,
  runtime,
  core,
  population,
  playerBrief,
  frozenConcept = null,
  batch,
  already,
  onProgress,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({
    step: 'aspects',
    batch: batch.map((b) => b.id).join(','),
  });
  const minChars = config.genesis.aspectMinChars || 280;
  const draft = { texts: null };
  const briefText = formatPlayerBrief(playerBrief);
  const conceptBlock = frozenConcept
    ? formatFrozenConceptForPrompt(frozenConcept)
    : '(концепт не передан — пиши только из ядра и пожеланий, не выдумывай другой город)';

  const props = {};
  for (const def of batch) {
    props[def.id] = {
      type: 'string',
      description: `${def.title}. ${def.hint}. Минимум ${minChars} символов, 2–4 абзаца. Уникально, не копируй другие разделы.`,
    };
  }

  const tools = [
    {
      name: 'submit_aspects',
      description: 'Заполнить очередную пачку аспектов описания города',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: batch.map((b) => b.id),
        properties: props,
      },
      handler: async (args) => {
        const weak = [];
        for (const def of batch) {
          const text = String(args[def.id] || '').trim();
          if (text.length < minChars) {
            weak.push({ id: def.id, title: def.title, length: text.length, need: minChars });
          }
        }
        const norms = batch.map((d) => String(args[d.id] || '').replace(/\s+/g, ' ').slice(0, 120));
        const dupes = norms.filter((t, i) => t && norms.indexOf(t) !== i);
        if (weak.length || dupes.length) {
          return toolFail(
            'aspects_weak',
            'Слишком коротко или разделы повторяют друг друга. Перепиши слабые поля (см. weak[]) длиннее и без копипаста.',
            { weak },
          );
        }
        draft.texts = args;
        return { ok: true };
      },
    },
  ];

  const titles = batch.map((b) => `- ${b.id} «${b.title}»: ${b.hint}`).join('\n');
  const known = Object.entries(already)
    .slice(0, 3)
    .map(([id, text]) => `### уже есть ${id}\n${String(text).slice(0, 200)}…`)
    .join('\n');

  await onProgress?.(`аспекты: ${batch.map((b) => b.title).join(', ')}`);
  log.info('genesis.aspects.begin', { titles: batch.map((b) => b.title) });

  const result = await runtime.run({
    agentId: 'genesis',
    userMessages: [
      {
        role: 'user',
        content: [
          `Город «${core.domainName}», правитель ${core.rulerName}.`,
          cosmologyBlock(),
          formatWorldContractForPrompt(config),
          `Население ~${population}.`,
          '',
          'ЗАМОРОЖЕННЫЙ КОНЦЕПТ (не выдумывай другой город, не добавляй эльфов/школу магии/аэропорт без PLAYER_REQUIRED):',
          conceptBlock,
          '',
          'ПОЖЕЛАНИЯ ИГРОКА:',
          briefText,
          '',
          known ? `Контекст уже написанных разделов (не копируй):\n${known}` : '',
          '',
          'Заполни ТОЛЬКО эти аспекты через submit_aspects. Каждый уникален и конкретен.',
          'Пиши устойчивый лор (годы), не сиюминутные события — те для хроники/тика.',
          'Изоляция острова: без регулярных гостей с чужих островов и «соседних земель».',
          'Не пиши статы, офицеров и сановников власти — только жизнь города.',
          titles,
        ].join('\n'),
      },
    ],
    tools,
    maxTurns: 5,
    toolChoice: { type: 'function', function: { name: 'submit_aspects' } },
    log,
    scene: 'genesis_aspects',
  });

  if (!draft.texts) {
    log.error('genesis.aspects.failed', {
      tools: (result.toolTrace || []).map((t) => ({
        name: t.name,
        ok: t.result?.ok !== false,
        error: t.result?.error,
        weak: t.result?.weak,
      })),
    });
    throw new Error(`genesis aspects failed: ${batch.map((b) => b.id).join(',')}`);
  }
  log.info('genesis.aspects.ok', {
    lengths: Object.fromEntries(
      batch.map((b) => [b.id, String(draft.texts[b.id] || '').length]),
    ),
  });
  return draft.texts;
}

async function generateCityBrief({ runtime, domain, log }) {
  const draft = { text: '' };
  const tools = [
    {
      name: 'submit_city_brief',
      description:
        'Компактный фактический бриф города. Тело — устойчивые факты. unknowns — канонические неизвестности, не сюжет.',
      parameters: {
        type: 'object',
        required: ['brief'],
        properties: {
          brief: {
            type: 'string',
            description: `Сухие постоянные факты города, до ${CITY_BRIEF_MAX} символов: места, институты, ресурсы, уклады, напряжения. Без сиюминутного, без сюжета и без пересказа неизвестностей.`,
          },
          unknowns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Узкие канонические неизвестности из описания (что в мире официально не установлено). Не слухи, не календарь, не бытовые дыры. Пустой массив, если таких нет.',
          },
        },
      },
      handler: async (args) => {
        const parsed = parseCityBrief(args.brief);
        const unknowns = normalizeCanonicalUnknowns(
          Array.isArray(args.unknowns) && args.unknowns.length ? args.unknowns : parsed.unknowns,
        );
        const assembled = formatCityBrief({ body: parsed.body, unknowns });
        if (clipCityText(parsed.body, CITY_BRIEF_MAX).length < 80) {
          return toolFail('thin', 'Слишком коротко: нужны конкретные факты города.');
        }
        draft.text = assembled;
        return { ok: true, unknowns: unknowns.length };
      },
    },
  ];

  try {
    await runtime.run({
      agentId: 'cityBrief',
      tools,
      maxTurns: 3,
      toolChoice: { type: 'function', function: { name: 'submit_city_brief' } },
      log,
      scene: 'city_brief',
      domainId: domain.id,
      extraSystem: `Город «${domain.name}».\n${String(domain.description || '').trim()}`,
      userMessages: [
        {
          role: 'user',
          content: [
            'Собери КОМПАКТНЫЙ фактический бриф этого города для других агентов.',
            'Не пересказывай генезис литературно. Не пиши хронику месяца и не выдумывай тайну.',
            'Оставь: рельеф и хозяйство, институты, ключевые места, устойчивые напряжения, необычные постоянные черты.',
            'Только извлекай, ничего не добавляй. Не выдумывай офицеров, сановников и статы.',
            'Канонические неизвестности (в тексте прямо сказано, что X официально не установлено / никто не видел / не доказано) — в unknowns, узкими пунктами. Не дублируй их в brief. Слух и догадку в unknowns не клади. Бытовые дыры (даты, имена постов, сколько раз) — не unknowns.',
            'Бриф — живой документ: позже в нём могут поправить кусок, если город как место изменится навсегда.',
            'Вызови submit_city_brief.',
          ].join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('genesis.city_brief_failed', { error: err.message });
  }
  return draft.text;
}

export async function generateDomain({
  config,
  runtime,
  storage,
  ownerUserId,
  channel = null,
  onProgress,
  forcedName = null,
  forcedPatronName = null,
  frozenConcept = null,
  axes = null,
  playerDirectives = null,
  playerBrief = null,
  log: parentLog,
}) {
  if (!frozenConcept || frozenConcept.status !== 'READY') {
    throw new Error('generateDomain requires frozenConcept with status READY');
  }
  const log = (parentLog || getLogger()).child({ ownerUserId: String(ownerUserId) });
  const world = await storage.getWorld();
  const axesState = normalizeAxesState(axes || frozenConcept.axes || {});
  const tags = axesSnapshotTags(config, axesState);
  const population = rollPopulation(config);
  const aspectsConfig = aspectDefs(config);
  const batchSize = config.genesis.aspectBatchSize || 4;
  const lockedName = frozenConcept.name || forcedName || null;

  log.info('genesis.roll', {
    forcedName: lockedName,
    forcedPatronName,
    population,
    concept: frozenConcept.name,
    axes: Object.fromEntries(Object.entries(axesState).map(([k, v]) => [k, v.value])),
  });

  const core = await generateCore({
    config,
    runtime,
    population,
    forcedName: lockedName,
    forcedPatronName,
    playerBrief,
    frozenConcept,
    onProgress,
    log,
  });
  const loreFromConcept = openingLoreFromConcept(frozenConcept);
  if (loreFromConcept.length) core.openingLore = loreFromConcept;
  if (frozenConcept.name) core.domainName = frozenConcept.name;
  bindRulerName(world, core, config);
  await storage.saveWorld(world);

  const aspects = {};
  const batches = chunk(aspectsConfig, batchSize);
  await onProgress?.(`описание города, ${batches.length} части`);

  for (const batch of batches) {
    const part = await generateAspectBatch({
      config,
      runtime,
      core,
      population,
      playerBrief,
      frozenConcept,
      batch,
      already: aspects,
      onProgress,
      log,
    });
    Object.assign(aspects, part);
  }

  const samples = Object.values(aspects).map((t) => String(t).replace(/\s+/g, ' ').slice(0, 80));
  const unique = new Set(samples);
  if (unique.size < Math.min(5, samples.length)) {
    log.error('genesis.aspects.too_similar', { unique: unique.size, total: samples.length });
    throw new Error('genesis produced too many identical aspect texts');
  }

  const description = assembleDescription(aspects, aspectsConfig);

  await onProgress?.('силы города');
  const scores = await requestCityStrengths({ runtime, config, description, frozenConcept, log });
  const stats = allocateStats(scores, config);

  const character = createCharacter({
    id: newId('char'),
    name: core.rulerName,
    title: core.rulerTitle || 'Правитель',
    description: core.rulerDescription,
    role: 'ruler',
    gender: core.rulerGender,
    ageYears: core.rulerAge,
    world,
  });

  const lore = (core.openingLore || []).map((text) =>
    createLoreFact({
      id: newId('lore'),
      text,
      tags: ['genesis', 'fact'],
      gameDateLabel: world.gameDate.label,
      tick: world.tickIndex,
      author: 'genesis',
    }),
  );

  const domainName = isForbiddenDomainName(core.domainName)
    ? frozenConcept.name || fallbackName()
    : core.domainName;

  lore.unshift(
    createLoreFact({
      id: newId('lore'),
      text: `Город «${domainName}» принял покровительство. Население около ${population}.`,
      tags: ['genesis', 'meta', 'fact'],
      gameDateLabel: world.gameDate.label,
      tick: world.tickIndex,
      author: 'system',
    }),
  );

  const domain = createDomainRecord({
    id: newId('domain'),
    worldId: world.id,
    ownerUserId: String(ownerUserId),
    channel: channel || null,
    name: domainName,
    description,
    aspects,
    tags,
    stats,
    population,
    character,
    lore,
    createdTick: world.tickIndex || 0,
    playerBrief,
    concept: frozenConcept,
    genesisSeed: axesState,
    playerDirectives,
  });
  syncFaith(domain);

  if (forcedPatronName) {
    applyPatronName(domain, forcedPatronName, { world, allowReplace: true });
  }

  await onProgress?.('сановники города');
  await generateOfficers({ domain, world, config, runtime, log });
  await storage.saveWorld(world);

  await onProgress?.('бриф города');
  domain.cityBrief = await generateCityBrief({ runtime, domain, log });

  await storage.saveDomain(domain);
  const prev = await storage.getUserBinding(String(ownerUserId));
  await storage.saveUserBinding({
    ...(prev || {}),
    userId: String(ownerUserId),
    worldId: world.id,
    domainId: domain.id,
    channel: channel || prev?.channel || null,
    telegramChatId: prev?.telegramChatId ?? null,
    createdAt: prev?.createdAt || new Date().toISOString(),
  });

  domain._greeting =
    core.greeting && looksLikePatronAddress(core.greeting, forcedPatronName) && !looksLikeTouristGreeting(core.greeting)
      ? core.greeting
      : defaultGreeting(domain.name, forcedPatronName);

  await onProgress?.(`остров «${domain.name}» собран`);
  await onProgress?.('якоря города');
  await ensureCityEntities({ domain, config, runtime, log });
  await storage.saveDomain(domain);
  await onProgress?.('первые истории');
  await seedOpeningPlots({ config, runtime, domain, world, storage, log });
  await storage.saveDomain(domain);
  log.info('genesis.saved', {
    domainId: domain.id,
    name: domain.name,
    ruler: character.name,
    stats: domain.stats,
    faith: domain.state?.faith,
    officers: (domain.officers || []).map((o) => `${o.office}:${o.name}`),
    aspectChars: Object.fromEntries(
      Object.entries(aspects).map(([k, v]) => [k, String(v).length]),
    ),
    openingPlots: (domain.plotlines || []).map((p) => p.title),
    cityEntities: (domain.cityEntities || []).length,
  });
  return domain;
}

export function inferChannel(ownerUserId, explicit = null) {
  if (explicit) return String(explicit);
  const id = String(ownerUserId || '');
  if (/^\d+$/.test(id)) return 'telegram';
  if (id === 'local-user' || id.startsWith('local-')) return 'web';
  if (id.startsWith('playtest')) return 'playtest';
  if (id.startsWith('cli')) return 'cli';
  return 'unknown';
}

export function domainSummary(domain) {
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    ownerUserId: domain.ownerUserId,
    channel: inferChannel(domain.ownerUserId, domain.channel),
    population: domain.population,
    stats: domain.stats,
    tags: domain.tags || [],
    patronName: domain.state?.patronName || null,
    character: domain.characters[0]
      ? {
          id: domain.characters[0].id,
          name: domain.characters[0].name,
          title: domain.characters[0].title,
          role: domain.characters[0].role,
        }
      : null,
    pendingCount: (domain.state?.pendingActions || []).filter((a) => a.status === 'active').length,
    plotlineCount: (domain.plotlines || []).length,
    plotlines: (domain.plotlines || []).map((p) => ({
      id: p.id,
      title: p.title,
      temperature: p.temperature,
    })),
    loreCount: domain.lore?.length || 0,
    chronicleCount: (domain.lore || []).filter((f) => (f.tags || []).includes('chronicle')).length,
  };
}
