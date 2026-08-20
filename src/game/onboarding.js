const BANNED_EXACT = new Set(
  [
    'город',
    'просто город',
    'мой город',
    'новый город',
    'тест',
    'test',
    'asdf',
    'qwerty',
    'xxx',
    'cloudshire',
    'облачный шир',
    'зажопинск',
    'залупинск',
    'хуйск',
    'жопск',
    'гавноград',
    'говнюк',
  ].map((s) => s.toLowerCase()),
);

const BANNED_SUBSTR = [
  'хуй',
  'пизд',
  'ебан',
  'ёбан',
  'бляд',
  'сука',
  'муда',
  'залуп',
  'жопа',
  'говн',
  'срат',
  'fuck',
  'shit',
  'dick',
];

const NAME_SUGGESTIONS = [
  'Ветроград',
  'Острокрыл',
  'Туманск',
  'Крутолом',
  'Яснояр',
  'Шипоград',
  'Небокрай',
  'Сребролом',
  'Ирийск',
  'Заоблачье',
  'Камнепад',
  'Лучезёрск',
  'Буревск',
  'Тихокрай',
  'Златоуступ',
  'Пеплоград',
  'Росопад',
  'Скитальск',
  'Громолом',
  'Белокрыл',
];

export function emptyOnboardingDraft() {
  return {
    messages: [],
    cityName: null,
    cityNameApproved: false,
    tagChoices: {}, // groupId -> tagId
    /** Саммари пожеланий игрока для генезиса */
    playerBrief: {
      city: '', // каким видит город/остров
      ruler: '', // каким хочет правителя-связного
      freeform: '', // прочее
    },
    pitched: false,
  };
}

export function formatPlayerBrief(brief = {}) {
  const parts = [];
  if (brief.city) parts.push(`Город/остров: ${brief.city}`);
  if (brief.ruler) parts.push(`Правитель (связной): ${brief.ruler}`);
  if (brief.freeform) parts.push(`Ещё: ${brief.freeform}`);
  return parts.length ? parts.join('\n') : '(пожеланий нет — полная свобода генезиса)';
}

export function validateCityName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) {
    return { ok: false, reason: 'Слишком коротко.' };
  }
  if (name.length > 32) {
    return { ok: false, reason: 'Слишком длинно (до 32 символов).' };
  }
  if (!/^[\p{L}\p{M}\d\s\-']+$/u.test(name)) {
    return { ok: false, reason: 'Только буквы, цифры, пробел, дефис.' };
  }
  const lower = name.toLowerCase();
  if (BANNED_EXACT.has(lower)) {
    return { ok: false, reason: 'Слишком плоское или запрещённое имя. Нужно звучное фэнтезийное.' };
  }
  for (const bad of BANNED_SUBSTR) {
    if (lower.includes(bad)) {
      return { ok: false, reason: 'Имя неприемлемо. Давай без мата и пошлостей.' };
    }
  }
  if (/^(город|island|city)\b/i.test(name) || /\b(город|city)$/i.test(name)) {
    return { ok: false, reason: 'Не «просто город». Нужно собственное имя места.' };
  }
  if (/^\d+$/.test(name)) {
    return { ok: false, reason: 'Одни цифры — не имя.' };
  }
  // Too generic: single common word
  if (['остров', 'небо', 'облако', 'земля', 'мир'].includes(lower)) {
    return { ok: false, reason: 'Слишком общее. Сделай имя конкретнее и характернее.' };
  }
  return { ok: true, name };
}

export function suggestCityNames(count = 5, rng = Math.random) {
  const pool = [...NAME_SUGGESTIONS];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

export function listTagCatalog(config) {
  return (config.genesis.tagGroups || []).map((g) => ({
    groupId: g.id,
    groupName: g.name,
    tags: g.tags.map((t) => ({ tagId: t.id, tagName: t.name })),
  }));
}

/** Короткий текст каталога для system/extra — чтобы агент не выдумывал группы. */
export function formatTagCatalogForPrompt(config) {
  return listTagCatalog(config)
    .map((g) => {
      const tags = g.tags.map((t) => `${t.tagId}=${t.tagName}`).join('; ');
      return `- ${g.groupId} «${g.groupName}»: ${tags}`;
    })
    .join('\n');
}

export function resolveTagChoice(config, tagChoices = {}) {
  return (config.genesis.tagGroups || []).map((group) => {
    const forcedId = tagChoices[group.id];
    const tag =
      (forcedId && group.tags.find((t) => t.id === forcedId)) ||
      group.tags[Math.floor(Math.random() * group.tags.length)];
    return {
      groupId: group.id,
      groupName: group.name,
      tagId: tag.id,
      tagName: tag.name,
      forced: Boolean(forcedId && group.tags.some((t) => t.id === forcedId)),
    };
  });
}
