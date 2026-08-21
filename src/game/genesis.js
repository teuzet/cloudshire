import { newId } from './ids.js';
import {
  rollDomainStats,
  rollPopulation,
  pickTags,
  pickMilestones,
  formatStatsForPrompt,
  formatTagsForPrompt,
  isForbiddenDomainName,
} from './stats.js';
import {
  createCharacter,
  createDomainRecord,
  createLoreFact,
  assembleDescription,
} from './models.js';
import { formatPlayerBrief } from './onboarding.js';
import { getLogger, truncate } from '../log.js';

function aspectDefs(config) {
  return config.genesis.aspects || [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function cosmologyBlock(config) {
  return [
    config.world.cosmology || '',
    '',
    'КОСМОЛОГИЯ ДЛЯ ГЕНЕЗИСА (жёстко):',
    '- Мир — летающие острова в небе. Большую часть времени каждый остров ИЗОЛИРОВАН.',
    '- Нет регулярных путей, паломничеств, караванов и «соседних регионов» на твёрдой земле.',
    '- Нет материка, соседних провинций, приезжих из других городов как бытовой нормы.',
    '- Чужие острова — редкие далёкие силуэты; без имён, договоров, войн и обмена людьми,',
    '  пока мир явно не дал стыковку (conflux). Не выдумывай чужие народы у ворот.',
    '- Хозяйство, вера, праздники, торговля — внутри СВОЕГО острова (~20 км до обрыва).',
    '- «Паломничество» может быть только местным (свой храм, свой край), не из-за моря/с других островов.',
  ].join('\n');
}

function fallbackName() {
  const names = ['Ветроград', 'Острокрыл', 'Туманск', 'Крутолом', 'Яснояр', 'Шипоград', 'Небокрай'];
  return names[Math.floor(Math.random() * names.length)];
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

function looksLikePatronAddress(text) {
  const t = String(text || '');
  return (
    /покровител|божеств|как\s+(тебя|вам|нам)\s+(звать|обращ)|назов|имя|знак|воли|слышу\s+тебя|алтар/i.test(
      t,
    ) && !looksLikeTouristGreeting(t)
  );
}

function defaultGreeting(domainName) {
  return (
    `Покровитель, я слышу тебя над «${domainName}». ` +
    'Как нам к тебе обращаться — скажи имя или знак. Город ждёт твоего слова.'
  );
}

function fallbackCore(lockedName, playerBrief) {
  const name = lockedName || fallbackName();
  const rulerWish = playerBrief?.ruler || 'Сдержанный правитель, внимательный к знамениям покровителя.';
  return {
    domainName: name,
    rulerName: /жриц/i.test(rulerWish) ? 'Ицка' : 'Кайрен',
    rulerTitle: /жриц/i.test(rulerWish) ? 'Верховная жрица' : 'Правитель',
    rulerDescription: rulerWish,
    greeting: defaultGreeting(name),
    openingLore: [
      `Город «${name}» стоит в центре летающего острова.`,
      'От стен до края острова — порядка двадцати километров земли.',
      'За обрывом — облака и ветер.',
      'Жители чтят покровителя и местные обряды.',
      'Главная площадь открыта к небу.',
      'Питьевую воду собирают и хранят в цистернах.',
      'Рынок собирается трижды в неделю.',
      'Стража несёт вахту у небесной пристани.',
      'Совет старейшин собирается при храме.',
      'Дети учат предания у края обрыва, но не подходят близко.',
      'Чужаков встречают осторожно, но с угощением.',
      'В тумане иногда мелькает далёкий силуэт чужого острова — курс его неподвластен людям.',
    ],
  };
}

/**
 * Step 1: имя, правитель, факты, приветствие.
 */
async function generateCore({
  config,
  runtime,
  stats,
  population,
  tags,
  forcedName,
  playerBrief,
  onProgress,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ step: 'core' });
  const loreMin = Math.min(8, config.genesis.openingLoreCount?.min || 12);
  const draft = { submitted: null, lastError: null };
  const lockedName = forcedName ? String(forcedName).trim() : null;
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
              : 'Фэнтезийное имя по-русски',
          },
          rulerName: { type: 'string' },
          rulerTitle: { type: 'string' },
          rulerDescription: {
            type: 'string',
            description: 'Характер правителя-связного; учти пожелания игрока',
          },
          greeting: {
            type: 'string',
            description:
              'Первая реплика правителя/жреца К божеству-покровителю (1–3 предложения). ' +
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
          return { ok: false, error: draft.lastError };
        }

        let lore = Array.isArray(fixed.openingLore) ? fixed.openingLore.filter(Boolean) : [];
        while (lore.length < loreMin) {
          lore.push(`Факт основания ${lore.length + 1}: город помнит знак покровителя.`);
        }
        fixed.openingLore = lore.slice(0, 20);

        if (!String(fixed.greeting || '').trim()) {
          fixed.greeting = defaultGreeting(fixed.domainName);
        }
        if (String(fixed.greeting).length > 600) {
          fixed.greeting = String(fixed.greeting).slice(0, 500);
        }
        if (
          looksLikeTouristGreeting(fixed.greeting) ||
          !looksLikePatronAddress(fixed.greeting)
        ) {
          draft.lastError =
            'greeting: нужна речь слуги к божеству (имя/знак), не «добро пожаловать в город»';
          return { ok: false, error: draft.lastError };
        }
        if (!fixed.rulerName) fixed.rulerName = 'Кайрен';
        if (!fixed.rulerTitle) fixed.rulerTitle = 'Правитель';
        if (!fixed.rulerDescription) {
          fixed.rulerDescription = playerBrief?.ruler || 'Внимательный к знамениям глава города.';
        }

        draft.submitted = fixed;
        draft.lastError = null;
        return { ok: true };
      },
    },
  ];

  onProgress?.('Шаг 1/2: ядро города…');
  log.info('genesis.core.begin', {
    lockedName,
    briefPreview: truncate(briefText, 400),
    loreMin,
  });

  const basePrompt = [
    'Создай ЯДРО города. Обязательно вызови submit_core.',
    cosmologyBlock(config),
    `Население (внутреннее): ${population}`,
    lockedName
      ? `Имя города УЖЕ выбрано: «${lockedName}» — поле domainName = точно это.`
      : 'Имя — фэнтезийное по-русски.',
    '',
    'ПОЖЕЛАНИЯ ИГРОКА:',
    briefText,
    '',
    'Статы (не называй в текстах):',
    formatStatsForPrompt(stats, config),
    '',
    'Теги / тон (свободные слова игрока или random-базис; не механика):',
    formatTagsForPrompt(tags),
    '',
    `openingLore: минимум ${loreMin} коротких ПОСТОЯННЫХ фактов (не новости месяца).`,
    'Учти изоляцию острова: без паломников/торговцев «из соседних регионов».',
    '',
    'greeting — ПЕРВАЯ РЕПЛИКА правителя/жреца божеству-покровителю (не игроку-туристу):',
    '- Ты слуга снизу вверх: голос дошёл до алтаря / ты слышишь покровителя.',
    '- Попроси, как обращаться: имя, титул или знак. Или попроси сказать волю.',
    '- 1–3 коротких предложения, живая речь от первого лица.',
    '- ЗАПРЕЩЕНО: «Добро пожаловать в …», реклама острова («волшебство пронизывает…»),',
    '  гид по достопримечательностям, тон онбординга/брошюры.',
    '- Пример тона: «Покровитель, я слышу тебя над [город]. Как нам звать тебя? Скажи знак — народ ждёт.»',
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
              ? 'greeting перепиши: слуга к божеству, просьба имени/знака; без «добро пожаловать».'
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
    draft.submitted = fallbackCore(lockedName, playerBrief);
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
  stats,
  tags,
  population,
  playerBrief,
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
          return {
            ok: false,
            error: 'Слишком коротко или разделы повторяют друг друга. Перепиши.',
            weak,
          };
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

  onProgress?.(`Аспекты: ${batch.map((b) => b.title).join(', ')}`);
  log.info('genesis.aspects.begin', { titles: batch.map((b) => b.title) });

  const result = await runtime.run({
    agentId: 'genesis',
    userMessages: [
      {
        role: 'user',
        content: [
          `Город «${core.domainName}», правитель ${core.rulerName}.`,
          cosmologyBlock(config),
          `Население ~${population}. Теги / тон: ${formatTagsForPrompt(tags)}`,
          'Статы (скрыто):',
          formatStatsForPrompt(stats, config),
          '',
          'ПОЖЕЛАНИЯ ИГРОКА:',
          briefText,
          '',
          known ? `Контекст уже написанных разделов (не копируй):\n${known}` : '',
          '',
          'Заполни ТОЛЬКО эти аспекты через submit_aspects. Каждый уникален и конкретен.',
          'Пиши устойчивый лор (годы), не сиюминутные события — те для хроники/тика.',
          'Изоляция острова: без регулярных гостей с чужих островов и «соседних земель».',
          titles,
        ].join('\n'),
      },
    ],
    tools,
    maxTurns: 5,
    toolChoice: { type: 'function', function: { name: 'submit_aspects' } },
    log,
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

export async function generateDomain({
  config,
  runtime,
  storage,
  ownerUserId,
  channel = null,
  onProgress,
  forcedName = null,
  forcedTagChoices = {},
  playerBrief = null,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ ownerUserId: String(ownerUserId) });
  const world = await storage.getWorld();
  const stats = rollDomainStats(config);
  const population = rollPopulation(config);
  const tags = pickTags(config, Math.random, forcedTagChoices || {});
  const milestones = pickMilestones(config);
  const aspectsConfig = aspectDefs(config);
  const batchSize = config.genesis.aspectBatchSize || 4;

  log.info('genesis.roll', {
    forcedName,
    population,
    tags: tags.map((t) => `${t.groupId}:${t.tagId}`),
    milestones: milestones.map((m) => m.text),
  });

  const core = await generateCore({
    config,
    runtime,
    stats,
    population,
    tags,
    forcedName,
    playerBrief,
    onProgress,
    log,
  });

  const aspects = {};
  const batches = chunk(aspectsConfig, batchSize);
  onProgress?.(`Шаг 2/2: описание (${batches.length} пачек)…`);

  for (const batch of batches) {
    const part = await generateAspectBatch({
      config,
      runtime,
      core,
      stats,
      tags,
      population,
      playerBrief,
      batch,
      already: aspects,
      onProgress,
      log,
    });
    Object.assign(aspects, part);
  }

  // Sanity: no global identical paste
  const samples = Object.values(aspects).map((t) => String(t).replace(/\s+/g, ' ').slice(0, 80));
  const unique = new Set(samples);
  if (unique.size < Math.min(5, samples.length)) {
    log.error('genesis.aspects.too_similar', { unique: unique.size, total: samples.length });
    throw new Error('genesis produced too many identical aspect texts');
  }

  const description = assembleDescription(aspects, aspectsConfig);

  const character = createCharacter({
    id: newId('char'),
    name: core.rulerName,
    title: core.rulerTitle || 'Правитель',
    description: core.rulerDescription,
    role: 'ruler',
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

  const domainName = isForbiddenDomainName(core.domainName) ? fallbackName() : core.domainName;

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
    milestones,
    tags,
    stats,
    population,
    character,
    lore,
  });

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
    core.greeting && looksLikePatronAddress(core.greeting) && !looksLikeTouristGreeting(core.greeting)
      ? core.greeting
      : defaultGreeting(domain.name);

  onProgress?.(`Остров «${domain.name}» готов.`);
  log.info('genesis.saved', {
    domainId: domain.id,
    name: domain.name,
    ruler: character.name,
    aspectChars: Object.fromEntries(
      Object.entries(aspects).map(([k, v]) => [k, String(v).length]),
    ),
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
    milestones: domain.milestones || [],
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
