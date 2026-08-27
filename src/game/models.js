import { newId } from './ids.js';
import { seedWorldNamePool, normalizeNamePool } from './names.js';
import { normalizeOrders } from './orders.js';
import { stampPersonAge } from './ages.js';
import { normalizeCityEntities } from './cityEntities.js';

export function emptyState() {
  return {
    // Временные процессы месяца/сезона (бунт, фестиваль, осада…)
    events: [],
    // Важные постоянные модификаторы (институты, установленный порядок, хронические условия)
    modifiers: [],
    // Заявки правителя на создать/править/снять порядок. Карточку пишет агент в начале месяца.
    pendingOrderRequests: [],
    pendingActions: [],
    // Короткие пометки о том, что случилось в разговорах этого месяца (dayNote).
    // Доносит день до тика и очищается после него.
    monthLog: [],
    // Темы последних тихих месяцев: жребий не повторяет их подряд.
    quietPicks: [],
    // Как обращаться к божеству-покровителю; null = ещё не названо
    patronName: null,
  };
}

/** Подтянуть новые поля state/tags у старых доменов без миграции файлов. */
export function normalizeDomain(domain) {
  if (!domain || typeof domain !== 'object') return domain;
  if (!domain.state || typeof domain.state !== 'object') {
    domain.state = emptyState();
  } else {
    if (!Array.isArray(domain.state.events)) domain.state.events = [];
    if (!Array.isArray(domain.state.modifiers)) domain.state.modifiers = [];
    if (!Array.isArray(domain.state.pendingOrderRequests)) domain.state.pendingOrderRequests = [];
    if (!Array.isArray(domain.state.pendingActions)) domain.state.pendingActions = [];
    if (!Array.isArray(domain.state.monthLog)) domain.state.monthLog = [];
    if (!Array.isArray(domain.state.quietPicks)) domain.state.quietPicks = [];
    if (!('patronName' in domain.state)) domain.state.patronName = null;
  }
  if (!Array.isArray(domain.tags)) domain.tags = [];
  if (!Array.isArray(domain.plotlines)) domain.plotlines = [];
  if (typeof domain.chronicleDigest !== 'string') domain.chronicleDigest = domain.chronicleDigest || '';
  if (domain.chronicleDigestThroughTick == null) domain.chronicleDigestThroughTick = null;
  if (!Number.isInteger(domain.createdTick)) domain.createdTick = 0;
  if (!Number.isFinite(domain.confluxMonthsDocked)) domain.confluxMonthsDocked = 0;
  if (!Number.isFinite(domain.confluxMonthsSolo)) domain.confluxMonthsSolo = 0;
  if (!domain.confluxPartners || typeof domain.confluxPartners !== 'object') {
    domain.confluxPartners = {};
  }
  if (typeof domain.imagePath !== 'string') domain.imagePath = domain.imagePath || null;
  if (typeof domain.imageBase64 !== 'string') domain.imageBase64 = domain.imageBase64 || null;
  domain.cityEntities = normalizeCityEntities(domain.cityEntities);
  if (domain.cityEntities.length) domain.cityEntitiesReady = true;
  else if (typeof domain.cityEntitiesReady !== 'boolean') domain.cityEntitiesReady = false;
  ensurePatronFact(domain);
  // pendingActions = длительные процессы; нормализация полей — в processes.normalizeDomainProcesses
  if (Array.isArray(domain.characters)) {
    for (const ch of domain.characters) {
      if (!ch || typeof ch !== 'object') continue;
      if (!Number.isFinite(Number(ch.loyalty))) ch.loyalty = 50;
      else ch.loyalty = Math.max(0, Math.min(100, Math.round(Number(ch.loyalty))));
      if (!Number.isFinite(Number(ch.terror))) ch.terror = 50;
      else ch.terror = Math.max(0, Math.min(100, Math.round(Number(ch.terror))));
    }
  }
  normalizeOrders(domain);
  return domain;
}

export function createWorldFromConfig(config) {
  const now = new Date().toISOString();
  const world = {
    // Уникальный id экземпляра (один запуск / жизнь мира до wipe).
    id: newId('world'),
    // Ключ сезона/шаблона из конфига (не уникален между запусками).
    seasonKey: config.world?.id || 'season',
    name: config.world?.name || 'Мир',
    description: config.world?.description || '',
    cosmology: config.world?.cosmology || '',
    lore: [],
    globalEvents: [],
    tickIndex: 0,
    gameDate: {
      year: 1,
      month: 1,
      label: 'Год 1, месяц 1',
      tick: 0,
    },
    status: 'active',
    /** Wall-clock расписание тиков (переживает рестарт процесса). */
    scheduler: {
      lastTickAt: null,
      nextTickAt: null,
      tickInProgress: false,
      tickStartedAt: null,
    },
    createdAt: now,
    updatedAt: now,
  };
  seedWorldNamePool(world, config);
  return world;
}

/** Подтянуть поля у старых world.yaml (до уникальных id). */
export function normalizeWorld(world, config = null) {
  if (!world || typeof world !== 'object') return world;
  if (!world.seasonKey) {
    // Старые миры: id был ключом сезона из конфига.
    const looksUnique = /^world_[a-f0-9]+$/i.test(String(world.id || ''));
    world.seasonKey = looksUnique
      ? config?.world?.id || 'season'
      : String(world.id || config?.world?.id || 'season');
  }
  if (!world.status) world.status = 'active';
  if (!world.scheduler || typeof world.scheduler !== 'object') {
    world.scheduler = {
      lastTickAt: null,
      nextTickAt: null,
      tickInProgress: false,
      tickStartedAt: null,
    };
  } else {
    if (!('lastTickAt' in world.scheduler)) world.scheduler.lastTickAt = null;
    if (!('nextTickAt' in world.scheduler)) world.scheduler.nextTickAt = null;
    if (!('tickInProgress' in world.scheduler)) world.scheduler.tickInProgress = false;
    if (!('tickStartedAt' in world.scheduler)) world.scheduler.tickStartedAt = null;
  }
  seedWorldNamePool(world, config);
  normalizeNamePool(world);
  return world;
}

export function createDomainRecord({
  id,
  worldId,
  ownerUserId,
  channel = null,
  name,
  description,
  stats,
  population,
  aspects = {},
  tags = [],
  character,
  lore = [],
  createdTick = 0,
  playerBrief = null,
}) {
  const now = new Date().toISOString();
  return {
    id,
    worldId,
    ownerUserId,
    channel: channel || null,
    name,
    description,
    aspects,
    /** Стартовые теги генезиса (groupId/tagId + имена) — для отладки и контекста */
    tags: (tags || []).map((t) => ({
      groupId: t.groupId,
      groupName: t.groupName,
      tagId: t.tagId,
      tagName: t.tagName,
      source: t.source || null,
    })),
    stats,
    population,
    state: emptyState(),
    characters: [character],
    lore,
    plotlines: [],
    cityEntities: [],
    cityEntitiesReady: false,
    status: 'playing',
    lastTickAt: null,
    createdTick: Number.isInteger(createdTick) ? createdTick : 0,
    /** Месяцы в фазе docked (доля «конфлюкса»); approaching считается соло. */
    confluxMonthsDocked: 0,
    confluxMonthsSolo: 0,
    /** Сколько раз стыковались с другим domainId (после dock). */
    confluxPartners: {},
    createdAt: now,
    updatedAt: now,
    imagePath: null,
    imageBase64: null,
    playerBrief: playerBrief
      ? {
          city: String(playerBrief.city || ''),
          ruler: String(playerBrief.ruler || ''),
          freeform: String(playerBrief.freeform || ''),
        }
      : null,
  };
}

export function createCharacter({
  id,
  name,
  description,
  role = 'ruler',
  title = 'Правитель',
  ageYears = null,
  world = null,
}) {
  const person = {
    id,
    name,
    title,
    description,
    role,
    portrait: null,
    dialogHistory: [],
    /** Преданность покровителю 0–100 */
    loyalty: 50,
    /** Священный ужас / благоговение перед покровителем 0–100 */
    terror: 50,
  };
  stampPersonAge(person, world, { ageYears });
  return person;
}

/**
 * Персонаж города — третий тип записи в lore рядом с chronicle и fact.
 * Заводится при первом упоминании: рассказчиком на бите или лормастером в ответе.
 */
export function createCharacterRecord({
  id,
  name,
  role = '',
  about = '',
  gender = 'unknown',
  status = 'alive',
  ageYears = null,
  tick = null,
  gameDateLabel = null,
  author = 'system',
  relatedPlotlineIds = [],
  world = null,
}) {
  const sex = ['male', 'female'].includes(gender) ? gender : 'unknown';
  const state = ['alive', 'dead', 'gone'].includes(status) ? status : 'alive';
  const record = {
    id,
    tags: ['character'],
    name: String(name || '').trim().slice(0, 80),
    role: String(role || '').trim().slice(0, 120),
    about: String(about || '').trim().slice(0, 400),
    // Без пола рассказчик каждый месяц решает заново, и человек меняет род на ходу.
    gender: sex,
    text: [String(name || '').trim(), role, about].filter(Boolean).join(' — ').slice(0, 500),
    status: state,
    firstSeenTick: tick,
    gameDateLabel,
    author,
    relatedPlotlineIds: (relatedPlotlineIds || []).map(String),
    createdAt: new Date().toISOString(),
  };
  stampPersonAge(record, world, { ageYears });
  return record;
}

/** Схема newCharacters для рассказчика: имя, пол, возраст в годах. */
export function newCharactersSchema({ withCity = false } = {}) {
  const properties = {
    name: { type: 'string' },
    gender: {
      type: 'string',
      enum: ['male', 'female'],
      description: 'Мужчина или женщина: без этого город будет путать род человека.',
    },
    ageYears: {
      type: 'integer',
      description: 'Возраст в полных годах сейчас. Месяц рождения ставит движок и сам сдвигает возраст.',
    },
    role: {
      type: 'string',
      description: 'Должность или занятие: ткачиха, страж у края, старший рынка.',
    },
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
  };
  if (withCity) {
    properties.city = {
      type: 'string',
      description: 'Имя города, к которому человек принадлежит.',
    };
  }
  return {
    type: 'array',
    description:
      'Люди, названные по имени ВПЕРВЫЕ. Уже известных из каста сюда не добавляй — просто используй. ' +
      'Назвал в записи новое имя — обязан внести его сюда, иначе город о нём забудет. ' +
      'Возраст (ageYears) обязателен: сколько человеку полных лет.',
    items: {
      type: 'object',
      required: ['name', 'gender', 'ageYears'],
      properties,
    },
  };
}

export function castRecords(lore = []) {
  return (lore || []).filter((f) => (f.tags || []).includes('character') && !f.retiredAt);
}

/** Живой каст города для промптов: коротко, кто есть кто. */
export function formatCastForPrompt(lore = [], { limit = 20 } = {}) {
  const cast = castRecords(lore).slice(-limit);
  if (!cast.length) return '(названных людей пока нет)';
  const sexWord = { male: 'он', female: 'она' };
  const stateWord = { dead: 'мёртв', gone: 'пропал без вести' };
  return cast
    .map((c) => {
      const state = stateWord[c.status] ? ` [${stateWord[c.status]}]` : '';
      const role = c.role ? `, ${c.role}` : '';
      const sex = sexWord[c.gender] ? ` (${sexWord[c.gender]})` : '';
      const age = Number.isFinite(Number(c.ageYears)) ? `, ${c.ageYears} лет` : '';
      return `- ${c.name}${sex}${age}${role}${state}${c.about ? `: ${c.about}` : ''}`;
    })
    .join('\n');
}

/** Покровитель не знает каст наизусть: первое имя в этом тексте — с должностью. */
export function firstMentionHintForSpeech() {
  return [
    'ПЕРВОЕ УПОМИНАНИЕ ЧЕЛОВЕКА В ЭТОМ ТЕКСТЕ:',
    'Покровитель не знает всех по имени. Когда в этой реплике имя встречается впервые — назови его вместе с должностью или кто это («ткачиха Айра», «страж у края Кален»).',
    'Дальше в том же тексте можно говорить просто по имени.',
    'Себя (правителя) так представлять не надо.',
  ].join('\n');
}

/** Люди каста, чьи имена звучат в данных текстах. */
export function peopleNamedInTexts(lore = [], texts = []) {
  const blob = (texts || []).map((t) => String(t || '')).join('\n');
  if (!blob.trim()) return [];
  return castRecords(lore).filter((c) => c.name && blob.includes(c.name));
}

/** Найти персонажа по имени (без учёта регистра) — чтобы не плодить дубли. */
export function findCharacterByName(lore = [], name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  return (
    castRecords(lore).find((c) => String(c.name || '').trim().toLowerCase() === needle) || null
  );
}

export function createLoreFact({
  id,
  text,
  tags = [],
  gameDateLabel,
  tick,
  author = 'system',
  importance = null,
  relatedPendingId = null,
  relatedPlotlineIds = null,
  sourcePlotId = null,
  processFinish = null,
  statChanges = null,
  secret = false,
  secretForDomainId = null,
  location = null,
  concernsDomainIds = null,
  concernsDomainNames = null,
}) {
  const fact = {
    id,
    text,
    tags,
    gameDateLabel,
    tick,
    author,
    importance,
    createdAt: new Date().toISOString(),
  };
  if (relatedPendingId) fact.relatedPendingId = relatedPendingId;
  if (Array.isArray(relatedPlotlineIds) && relatedPlotlineIds.length) {
    fact.relatedPlotlineIds = [...new Set(relatedPlotlineIds.map(String))];
  }
  const source = sourcePlotId || fact.relatedPlotlineIds?.[0] || null;
  if (source) fact.sourcePlotId = String(source);
  if (processFinish) fact.processFinish = String(processFinish);
  if (statChanges && Object.keys(statChanges).length) fact.statChanges = statChanges;
  if (secret) {
    fact.secret = true;
    if (secretForDomainId) fact.secretForDomainId = String(secretForDomainId);
  }
  if (location) fact.location = String(location).trim();
  if (Array.isArray(concernsDomainIds) && concernsDomainIds.length) {
    fact.concernsDomainIds = concernsDomainIds.map(String);
  }
  if (Array.isArray(concernsDomainNames) && concernsDomainNames.length) {
    fact.concernsDomainNames = concernsDomainNames.map(String);
  }
  return fact;
}

export function patronFactText(patronName, cityName) {
  return `${patronName} является покровителем города «${cityName}».`;
}

export function findPatronFact(domain) {
  return (domain?.lore || []).find((f) => (f.tags || []).includes('patron')) || null;
}

/** Имя покровителя — факт города, не через лормастера. */
export function ensurePatronFact(domain, { world = null } = {}) {
  const name = String(domain?.state?.patronName || '').trim();
  const city = String(domain?.name || '').trim();
  if (!name || !city) return null;
  const text = patronFactText(name, city);
  const existing = findPatronFact(domain);
  if (existing) {
    existing.text = text;
    return existing;
  }
  const fact = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['fact', 'patron'],
    gameDateLabel: world?.gameDate?.label || null,
    tick: world?.tickIndex ?? domain.createdTick ?? null,
    author: 'system',
  });
  if (!Array.isArray(domain.lore)) domain.lore = [];
  domain.lore.push(fact);
  return fact;
}

export function applyPatronName(domain, raw, { world = null, allowReplace = false } = {}) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 64);
  if (cleaned.length < 2) return { error: 'too_short' };
  if (!domain.state) domain.state = emptyState();
  const prev = domain.state.patronName || null;
  if (prev && prev !== cleaned && !allowReplace) {
    return { error: 'locked', previous: prev, patronName: prev };
  }
  domain.state.patronName = cleaned;
  ensurePatronFact(domain, { world });
  return { ok: true, patronName: cleaned, previous: prev };
}

/** Краткая пометка «где / кого касается» для хроники стыка. */
export function formatChronicleScope(entry) {
  if (!entry) return '';
  const parts = [];
  if (entry.location) parts.push(`где: ${entry.location}`);
  const names = entry.concernsDomainNames || [];
  if (names.length) parts.push(`касается: ${names.join(', ')}`);
  return parts.length ? `(${parts.join('; ')}) ` : '';
}

/** Записи месяца, видимые правителю домена (учитывает secret). */
export function filterChronicleForDomain(entries = [], domainId) {
  return (entries || []).filter((e) => {
    if (!e?.secret) return true;
    return String(e.secretForDomainId || '') === String(domainId);
  });
}

export function loreToPromptText(lore = [], { excludeTags = [] } = {}) {
  const filtered = (lore || []).filter((f) => {
    const tags = f.tags || [];
    return !excludeTags.some((t) => tags.includes(t));
  });
  if (!filtered.length) return '(фактов пока нет)';
  return filtered
    .map((f) => {
      const n = f.id || '?';
      const date = f.gameDateLabel || 'без даты';
      const tags = (f.tags || []).length ? ` [${f.tags.join(', ')}]` : '';
      const imp = f.importance ? ` {${f.importance}}` : '';
      let stats = '';
      if (f.statChanges && typeof f.statChanges === 'object') {
        const parts = Object.entries(f.statChanges).map(
          ([k, v]) => `${k} ${v.from}→${v.to}`,
        );
        if (parts.length) stats = ` «статы: ${parts.join(', ')}»`;
      }
      const scope = formatChronicleScope(f);
      return `#${n} (${date})${tags}${imp}${stats}: ${scope}${f.text}`;
    })
    .join('\n');
}

/** Последние N записей хроники (для контекста резолвера). */
export function recentChronicleText(lore = [], limit = 12) {
  const chron = chronicleEntries(lore).slice(-limit);
  if (!chron.length) return '(хроники ещё нет)';
  return loreToPromptText(chron);
}

export function chronicleEntries(lore = []) {
  return (lore || []).filter((f) => (f.tags || []).includes('chronicle'));
}

export function newsChronicleEntries(entries = []) {
  // Новости правителя — только chronicle, не fact
  return entries.filter((f) => {
    const tags = f.tags || [];
    return tags.includes('chronicle') && !tags.includes('fact');
  });
}

/**
 * 1 tick = 1 game month. 12 months = 1 game year (= 1 real day at 2h ticks).
 */
export function advanceGameDate(world) {
  const prevTick = world.tickIndex || 0;
  let year = world.gameDate?.year;
  let month = world.gameDate?.month;

  if (year == null || month == null) {
    year = Math.floor(prevTick / 12) + 1;
    month = (prevTick % 12) + 1;
  }

  month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }

  const tick = prevTick + 1;
  world.tickIndex = tick;
  world.gameDate = {
    year,
    month,
    label: `Год ${year}, месяц ${month}`,
    tick,
  };
  world.updatedAt = new Date().toISOString();
  return world.gameDate;
}

export function assembleDescription(aspects = {}, aspectDefs = null) {
  const order = aspectDefs?.length
    ? aspectDefs.map((a) => [a.id, a.title])
    : [
        ['overview', 'Общий облик'],
        ['geography', 'География и климат'],
        ['economy', 'Хозяйство'],
        ['society', 'Общество'],
        ['faith', 'Вера и культы'],
        ['governance', 'Власть'],
        ['landmarks', 'Места силы'],
        ['dailyLife', 'Повседневность'],
        ['threats', 'Угрозы и напряжения'],
      ];

  return order
    .filter(([key]) => aspects[key])
    .map(([key, title]) => `## ${title}\n\n${aspects[key]}`)
    .join('\n\n');
}
