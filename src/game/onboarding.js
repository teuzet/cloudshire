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

/** Слова, от которых лучше уходить в именах (все острова и так летают / не вывески). */
const NAME_CLICHE_SUBSTR = [
  'облак',
  'небо',
  'летаю',
  'остров',
  'аэро',
  'скай',
  'cloud',
  'шире',
  'cloudshire',
  'верстак',
  'наковальн',
  'базар',
  'рынок',
  'колодец',
  'жернов',
];

export function emptyOnboardingDraft() {
  return {
    messages: [],
    cityName: null,
    cityNameApproved: false,
    tagChoices: {}, // groupId -> tagId | freeform label
    /** quick | brief | questions | null */
    mode: null,
    /** Саммари пожеланий игрока для генезиса */
    playerBrief: {
      city: '',
      ruler: '',
      freeform: '',
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
  if (name.length > 40) {
    return { ok: false, reason: 'Слишком длинно (до 40 символов).' };
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
  for (const cliche of NAME_CLICHE_SUBSTR) {
    if (lower.includes(cliche)) {
      return {
        ok: false,
        reason:
          'Имя слишком «про летающий остров/небо». Назови город по местным чертам (камень, торг, храм, руда…), не по полёту.',
      };
    }
  }
  return { ok: true, name };
}

/** Случайно заполнить все группы тегов из каталога (перезаписывает текущие). */
export function randomizeAllTags(config, rng = Math.random) {
  const chosen = {};
  const applied = [];
  for (const group of config.genesis?.tagGroups || []) {
    const tag = group.tags[Math.floor(rng() * group.tags.length)];
    chosen[group.id] = tag.id;
    applied.push({ groupId: group.id, group: group.name, tagId: tag.id, tag: tag.name });
  }
  return { chosen, applied, forPlayer: formatTagChoicesForPlayer(config, chosen) };
}

/** Человекочитаемая сводка выбранных тегов для речи к игроку. */
export function formatTagChoicesForPlayer(config, tagChoices = {}) {
  const lines = [];
  for (const group of config.genesis?.tagGroups || []) {
    const raw = tagChoices[group.id];
    if (raw == null || raw === '') continue;
    const fromCatalog = group.tags.find((t) => t.id === raw);
    const label = fromCatalog ? fromCatalog.name : String(raw);
    lines.push(`${group.name}: ${label}`);
  }
  return lines.length ? lines.join('\n') : '(теги ещё не заданы)';
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

/**
 * Эвристика: вытащить groupId→значение из свободного текста игрока.
 * Значения — свободные слова (не обязаны быть id из каталога).
 * Каталог используется только как подсказка смысла группы.
 */
export function inferTagChoicesFromText(config, text, existing = {}) {
  const raw = String(text || '').toLowerCase();
  if (raw.length < 4) return { ...existing };

  const rules = {
    climate: [
      { label: 'морозный, снежный', re: /снег|снежн|мороз|зим|холод|ледян|аркти/ },
      { label: 'тропический, джунгли', re: /джунгл|тропик|влажн.*жар|экватор/ },
      { label: 'сухой, пустынный', re: /пустын|засух|сухой\s+край|арид/ },
      { label: 'бурный, ветреный', re: /бурный|ветрен|шторм|ураган/ },
      { label: 'туманный', re: /туман/ },
      { label: 'влажный', re: /влажн/ },
      { label: 'дождливый', re: /дождл|ливн/ },
      { label: 'сезон муссонов / ливней', re: /муссон/ },
      { label: 'пепельный / вулканическая пыль', re: /пепельн|вулканическ.*пыл|пеплопад/ },
      { label: 'разреженный воздух высот', re: /разрежен|высокогорн.*воздух/ },
      { label: 'вечные сумерки под облаками', re: /сумерк|вечная\s+тень/ },
      { label: 'ослепительно ясный', re: /ослепительн|ясн.*неб/ },
      { label: 'солёные ветры', re: /солен.*ветр|солён.*ветр/ },
      { label: 'мягкий, вечно-весенний', re: /вечно.?весен|мягк.*климат/ },
    ],
    terrain: [
      { label: 'скалистые пики', re: /скал|пик|горн|ущель/ },
      { label: 'пещеры', re: /пещер/ },
      { label: 'террасы и уступы', re: /террас|уступ/ },
      { label: 'кальдера / кратер', re: /кальдер|кратер|вулкан/ },
      { label: 'рой малых островков', re: /рой\s+остров|осколк/ },
      { label: 'плоскогорье', re: /плоскогор|плато/ },
      { label: 'ущелья и трещины', re: /ущель|трещин.*скал/ },
      { label: 'столовая гора / меса', re: /\bмеса\b|столов.*гор/ },
      { label: 'болота и топи', re: /болот|топ[иь]/ },
      { label: 'песчаные дюны', re: /дюн|песчан/ },
      { label: 'кристаллические хребты', re: /кристалл/ },
      { label: 'лесистые склоны', re: /лесист|лесн.*склон/ },
      { label: 'висячие озёра', re: /висяч.*озёр|озёр.*обрыв/ },
      { label: 'базальтовые ступени', re: /базальт/ },
      { label: 'полый / пронизанный пустотами', re: /полый\s+остров|пустот.*недр/ },
      { label: 'узкий хребет-лезвие', re: /хребет.?лезв|нож.?хребет/ },
    ],
    economy: [
      { label: 'добыча руд и камня', re: /руд|шахт|добыч|каменолом|металл/ },
      { label: 'торговля', re: /торгов|перевалк|рынок|караван/ },
      { label: 'ремёсла и мануфактуры', re: /рем[её]сл|мануфакт|мастерск/ },
      { label: 'земледелие и сады', re: /земледел|сад[ыа]|пашн|ферм/ },
      { label: 'скотоводство', re: /скот|пастбищ/ },
      { label: 'храмовые сборы на острове', re: /паломнич|храмов.*сбор/ },
      { label: 'охота и промысел в облаках', re: /охот.*облак|промысел.*неб/ },
      { label: 'вино / брага / дистиллят', re: /винодел|браг|дистиллят|винокур/ },
      { label: 'ткани и красильни', re: /ткан|красильн|пряж/ },
      { label: 'постройка небесных судов', re: /судостро|верф.*стро/ },
      { label: 'лекарства и травы', re: /лекарств|травник|аптек/ },
      { label: 'книги, чернила, перепись', re: /книгопечат|чернил|скриптор|перепис/ },
      { label: 'огранка камней', re: /огранк|ювелир/ },
      { label: 'сбор обломков с неба', re: /обломк.*неб|salvage|сбор.*облом/ },
      { label: 'найм стражи / сопровождение', re: /найм.*страж|сопровожден/ },
      { label: 'сборы с праздников и ярмарок', re: /ярмарочн|сбор.*праздник/ },
      { label: 'продажа / развоз воды', re: /развоз.*вод|торгов.*вод/ },
      { label: 'алхимия и реактивы', re: /алхим|реактив/ },
    ],
    paradigm: [
      { label: 'технократия, смесь магии и механизмов', re: /технократ|маги.*техн|техн.*маг|смесь\s+магии|магия\s+и\s+техн/ },
      { label: 'технологии и механизмы', re: /технолог|механизм|машин|паро|инженер/ },
      { label: 'магия', re: /маги|колдов|чародей|волшеб/ },
      { label: 'традиционный уклад', re: /традиц|древн.*уклад/ },
      { label: 'устные предания сильнее книг', re: /устн.*предан|сказител/ },
      { label: 'канцелярия и реестры', re: /канцеляр|реестр|бюрократ/ },
      { label: 'цеховые тайны', re: /цехов.*тайн|гильд.*секрет/ },
      { label: 'знания через знамения', re: /знамен.*знан|пророческ.*учен/ },
      { label: 'опыты и риск', re: /эксперимент|опытн.*школ/ },
      { label: 'запретные архивы', re: /запретн.*архив/ },
      { label: 'мастера-наставники', re: /мастер.?настав|ученичеств/ },
      { label: 'навигация по ветрам и звёздам', re: /навигац|зв[её]здн.*карт/ },
    ],
    temper: [
      { label: 'учёные', re: /учёны|научн|академи/ },
      { label: 'воинственный', re: /воинств|ратный|боевой/ },
      { label: 'набожный', re: /набожн|благочест|жрец/ },
      { label: 'торговый, расчётливый', re: /торговый\s+нрав|расчётлив/ },
      { label: 'гостеприимный', re: /гостеприим/ },
      { label: 'беспокойный', re: /бескокойн|неспокойн/ },
      { label: 'стойкий, немногословный', re: /стойк.*нрав|немногослов/ },
      { label: 'праздничный, шумный', re: /праздничн.*нрав|шумный\s+город/ },
      { label: 'подозрительный к чужакам', re: /подозрительн.*чуж|недоверчив/ },
      { label: 'гордый честью', re: /горд.*чест|честь\s+рода/ },
      { label: 'бережливый до скупости', re: /бережлив|скуп/ },
      { label: 'любопытный', re: /любопытн/ },
      { label: 'суеверно-фаталистичный', re: /фаталист|суеверн/ },
      { label: 'равный, не любит титулов', re: /не\s+любит\s+титул|эгалитар/ },
      { label: 'чтит ранги и дома', re: /чтит\s+ранг|иерархич/ },
      { label: 'меланхоличный', re: /меланхол/ },
    ],
    architecture: [
      { label: 'вросший в скалу', re: /вросш.*скал|в\s+скал|высечен/ },
      { label: 'башни и шпили', re: /башн|шпил/ },
      { label: 'крепостные кольца', re: /крепост|стены|кольц.*стен/ },
      { label: 'верфи небесных судов', re: /верф|небесн.*суд/ },
      { label: 'сады и висячие дворы', re: /висяч.*сад|сады\s+и/ },
      { label: 'лабиринты рынков', re: /базар|лабиринт.*рынк/ },
      { label: 'мосты и галереи над пропастью', re: /галере.*пропаст|мост.*обрыв/ },
      { label: 'амфитеатры и площади', re: /амфитеатр/ },
      { label: 'каналы и цистерны', re: /цистерн|канал.*вод/ },
      { label: 'деревянные подъёмники', re: /подъ[её]мник/ },
      { label: 'мозаики и росписи', re: /мозаик|роспис/ },
      { label: 'низкие крыши от ветра', re: /низк.*крыш/ },
      { label: 'лестницы по обрыву', re: /лестниц.*обрыв/ },
      { label: 'стеклянные оранжереи', re: /оранжерей|стеклянн.*дом/ },
      { label: 'кость и камень в фасадах', re: /кость.*камен|костяной\s+фасад/ },
      { label: 'шатровые кварталы', re: /шатров|палаточн.*квартал/ },
    ],
    society: [
      { label: 'власть гильдий', re: /власть\s+гильд|гильдии\s+правят/ },
      { label: 'сильная роль храма', re: /храм.*власть|жрецы\s+сильн/ },
      { label: 'дома знати', re: /дома\s+знати|аристократ/ },
      { label: 'совет старейшин', re: /совет\s+старейшин/ },
      { label: 'купеческие князья', re: /купеческ.*княз|олигарх/ },
      { label: 'касты ремёсел', re: /касты?\s+рем[её]сл/ },
      { label: 'гражданское ополчение', re: /гражданск.*ополчен/ },
      { label: 'учёная элита', re: /учёная\s+элита/ },
      { label: 'кланы и родство', re: /кланы|родов.*строй/ },
      { label: 'свободные кварталы', re: /свободн.*квартал/ },
      { label: 'долговая кабала', re: /долговая\s+кабал|кабала/ },
      { label: 'патронаж сильных домов', re: /патронаж/ },
    ],
    faith_shape: [
      { label: 'единый покровитель', re: /единый\s+покровител|монотеи/ },
      { label: 'старый пантеон рядом с новым', re: /старый\s+пантеон|многобож/ },
      { label: 'культ предков', re: /культ\s+предков/ },
      { label: 'жизнь по знамениям', re: /жизнь\s+по\s+знамен/ },
      { label: 'тихая повседневная набожность', re: /тихая\s+набожн/ },
      { label: 'громкие публичные обряды', re: /громк.*обряд|публичн.*ритуал/ },
      { label: 'тайные ордена', re: /тайные?\s+ордена?/ },
      { label: 'тлеющие ереси', re: /тлеющ.*ерес|ерес.*тле/ },
      { label: 'почитание реликвий', re: /реликви/ },
      { label: 'почитание неба и ветра', re: /почитан.*неб|культ\s+ветра/ },
      { label: 'вера как договор о милости', re: /договор.*милост|прагматичн.*вер/ },
      { label: 'вера через ужас и благоговение', re: /ужас.*благоговен|страхопочитан/ },
    ],
    pressure: [
      { label: 'нехватка воды', re: /нехватк.*вод|жажд/ },
      { label: 'раскол культов', re: /раскол\s+культ/ },
      { label: 'угроза небесных тварей', re: /небесн.*твар|звер.*неб/ },
      { label: 'старое проклятие', re: /проклят|табу/ },
      { label: 'наплыв беженцев', re: /бежен/ },
      { label: 'тревога из-за силуэтов в небе', re: /тревог.*силуэт|сосед.*остров/ },
      { label: 'тонкие запасы зерна', re: /тонк.*запас|нехватк.*зерн/ },
      { label: 'осыпающийся край', re: /осыпа.*край|эрози.*обрыв/ },
      { label: 'безумие от ветра', re: /безумие.*ветр|ветер.*сводит/ },
      { label: 'память о чуме', re: /память.*чум|после\s+чумы/ },
      { label: 'риск обвалов в недрах', re: /обвал.*шахт|обвал.*недр/ },
      { label: 'вражда домов', re: /вражда\s+домов|междоусобиц/ },
      { label: 'теневая контрабанда', re: /контрабанд/ },
      { label: 'паника от знамений', re: /паника.*знамен/ },
      { label: 'нехватка мастеров', re: /нехватк.*мастер/ },
      { label: 'долговая спираль', re: /долговая\s+спирал/ },
      { label: 'тихий ропот улиц', re: /тихий\s+ропот|ропот\s+улиц/ },
    ],
  };

  const out = { ...existing };
  for (const group of config.genesis.tagGroups || []) {
    if (out[group.id]) continue;
    const groupRules = rules[group.id] || [];
    for (const rule of groupRules) {
      if (!rule.re.test(raw)) continue;
      out[group.id] = rule.label;
      break;
    }
  }
  return out;
}

/** Собрать текст brief + последних реплик игрока для эвристики тегов. */
export function collectOnboardingPreferenceText(draft) {
  const parts = [];
  const brief = draft?.playerBrief || {};
  for (const key of ['city', 'ruler', 'freeform']) {
    if (brief[key]) parts.push(String(brief[key]));
  }
  for (const m of draft?.messages || []) {
    if (m.role === 'user' && m.content) parts.push(String(m.content));
  }
  return parts.join('\n');
}
