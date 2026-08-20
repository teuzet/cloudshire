export function emptyState() {
  return {
    // Временные процессы месяца/сезона (бунт, фестиваль, осада…)
    events: [],
    // Важные постоянные модификаторы (институты, установленный порядок, хронические условия)
    modifiers: [],
    pendingActions: [],
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
    if (!Array.isArray(domain.state.pendingActions)) domain.state.pendingActions = [];
    if (!('patronName' in domain.state)) domain.state.patronName = null;
  }
  if (!Array.isArray(domain.tags)) domain.tags = [];
  return domain;
}

export function createWorldFromConfig(config) {
  return {
    id: config.world.id,
    name: config.world.name,
    description: config.world.description || '',
    cosmology: config.world.cosmology || '',
    lore: [],
    milestonePool: structuredClone(config.world.milestonePool || []),
    globalEvents: [],
    tickIndex: 0,
    gameDate: {
      year: 1,
      month: 1,
      label: 'Год 1, месяц 1',
      tick: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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
  milestones = [],
  tags = [],
  character,
  lore = [],
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
    milestones,
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
    status: 'playing',
    lastTickAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createCharacter({ id, name, description, role = 'ruler', title = 'Правитель' }) {
  return {
    id,
    name,
    title,
    description,
    role,
    portrait: null,
    dialogHistory: [],
  };
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
  statChanges = null,
  secret = false,
  secretForDomainId = null,
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
  if (statChanges && Object.keys(statChanges).length) fact.statChanges = statChanges;
  if (secret) {
    fact.secret = true;
    if (secretForDomainId) fact.secretForDomainId = String(secretForDomainId);
  }
  return fact;
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
      return `#${n} (${date})${tags}${imp}${stats}: ${f.text}`;
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
