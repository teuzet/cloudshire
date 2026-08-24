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

export const ONBOARDING_MODES = ['quick', 'brief', 'questions', 'dossier'];
/** Потолок для генезиса: подробное ТЗ влезает, стенограмма чата — нет. */
export const BRIEF_CITY_MAX = 24000;
export const BRIEF_RULER_MAX = 4000;
export const BRIEF_FREEFORM_MAX = 12000;
export const BRIEF_TOTAL_MAX = 32000;
/** Сколько brief видит онбординг-агент в карточке хода (не генезис). */
export const BRIEF_PROMPT_CITY_MAX = 16000;
export const BRIEF_PROMPT_RULER_MAX = 2500;
export const LONG_USER_MESSAGE_MIN = 500;
export const DOSSIER_SWITCH_MIN = 800;
export const ONBOARDING_HISTORY_MESSAGES = 12;
export const FALSE_START_STRIP_MAX = 400;

export function emptyOnboardingDraft() {
  return {
    messages: [],
    cityName: null,
    cityNameApproved: false,
    tagChoices: {}, // groupId -> tagId | freeform label
    /** quick | brief | questions | dossier | null */
    mode: null,
    /** intro | collecting | pitched | named | generating */
    phase: 'intro',
    /** Бриф пожеланий игрока для генезиса — не стенограмма чата, но может быть подробным. */
    playerBrief: {
      city: '',
      ruler: '',
      freeform: '',
    },
    pitched: false,
    /** Последнее имя, которое агент или игрок уже назвал (ещё без set_city_name). */
    pitchedName: null,
    /** Теги на момент этого питча — чтобы не потерять их, если агент рандомит снова. */
    pitchedTagChoices: {},
    /** Как к игроку-богу будут обращаться. Без этого генезис не стартует. */
    patronName: null,
    patronNameApproved: false,
  };
}

export function deriveOnboardingPhase(draft, { generating = false } = {}) {
  if (generating) return 'generating';
  if (draft?.cityNameApproved && draft?.cityName) return 'named';
  if (draft?.pitchedName || draft?.pitched) return 'pitched';
  if (draft?.mode || (draft?.messages || []).length > 0) return 'collecting';
  return 'intro';
}

export function normalizeOnboardingDraft(draft) {
  const d = draft && typeof draft === 'object' ? draft : emptyOnboardingDraft();
  if (!Array.isArray(d.messages)) d.messages = [];
  if (!d.tagChoices || typeof d.tagChoices !== 'object') d.tagChoices = {};
  if (!d.pitchedTagChoices || typeof d.pitchedTagChoices !== 'object') d.pitchedTagChoices = {};
  if (!d.playerBrief || typeof d.playerBrief !== 'object') {
    d.playerBrief = { city: '', ruler: '', freeform: '' };
  } else {
    d.playerBrief.city = d.playerBrief.city || '';
    d.playerBrief.ruler = d.playerBrief.ruler || '';
    d.playerBrief.freeform = d.playerBrief.freeform || '';
  }
  if (!('mode' in d)) d.mode = null;
  if (!('pitchedName' in d)) d.pitchedName = null;
  if (!('pitched' in d)) d.pitched = false;
  if (!('cityName' in d)) d.cityName = null;
  if (!('cityNameApproved' in d)) d.cityNameApproved = false;
  if (!('patronName' in d)) d.patronName = null;
  if (!('patronNameApproved' in d)) d.patronNameApproved = false;
  clipOnboardingBrief(d.playerBrief);
  d.phase = deriveOnboardingPhase(d);
  return d;
}

export function clipOnboardingBrief(brief = {}) {
  if (!brief || typeof brief !== 'object') return brief;
  if (brief.city) brief.city = String(brief.city).slice(0, BRIEF_CITY_MAX);
  if (brief.ruler) brief.ruler = String(brief.ruler).slice(0, BRIEF_RULER_MAX);
  if (brief.freeform) brief.freeform = String(brief.freeform).slice(0, BRIEF_FREEFORM_MAX);
  const total =
    String(brief.city || '').length +
    String(brief.ruler || '').length +
    String(brief.freeform || '').length;
  if (total > BRIEF_TOTAL_MAX && brief.freeform) {
    const keep = Math.max(0, BRIEF_TOTAL_MAX - String(brief.city || '').length - String(brief.ruler || '').length);
    brief.freeform = String(brief.freeform).slice(0, keep);
  }
  return brief;
}

export function hasPitchedCity(draft) {
  return Boolean(draft?.pitchedName || draft?.cityName || draft?.pitched);
}

export function hasPatronName(draft) {
  return Boolean(String(draft?.patronName || '').trim());
}

export function canStartOnboarding(draft) {
  return Boolean(draft?.cityNameApproved && draft?.cityName && hasPatronName(draft));
}

export function formatOnboardingStatusCard(draft, config, { generating = false } = {}) {
  const d = draft || emptyOnboardingDraft();
  const phase = deriveOnboardingPhase(d, { generating });
  const tagCount = Object.keys(d.tagChoices || {}).length;
  const tagTotal = (config?.genesis?.tagGroups || []).length;
  const pitched = hasPitchedCity(d);
  const brief = d.playerBrief || {};
  const cityPreview = String(brief.city || '').trim().slice(0, BRIEF_PROMPT_CITY_MAX);
  const rulerPreview = String(brief.ruler || '').trim().slice(0, BRIEF_PROMPT_RULER_MAX);
  const freeformPreview = String(brief.freeform || '').trim().slice(0, 4000);
  const lines = [
    `фаза=${phase}; режим=${d.mode || 'не выбран'};`,
    `питч=${d.pitchedName || '—'}; имя=${d.cityName || '—'} approved=${Boolean(d.cityNameApproved)};`,
    `покровитель=${d.patronName || '—'} approved=${Boolean(d.patronNameApproved)};`,
    `черты=${tagCount}/${tagTotal}${pitched ? '' : ' (это не питч)'}; ждатьСтарта=${pitched ? 'да, только после имени бога и явного согласия' : 'нет'}.`,
  ];
  if (cityPreview) lines.push(`бриф города для генезиса:\n${cityPreview}`);
  if (rulerPreview) lines.push(`правитель:\n${rulerPreview}`);
  if (freeformPreview) lines.push(`ещё к брифу:\n${freeformPreview}`);
  if (phase === 'intro' || !pitched) {
    lines.push('Город ещё не предложен. Не пиши «город уже предложен» и не вызывай start_new_game.');
  } else {
    lines.push(
      'Имя города уже названо. НЕ вызывай randomize_all_tags и не выдумывай новый город. ' +
        (hasPatronName(d)
          ? 'Согласие («да/начинаем/создавай/готов») → set_city_name + start_new_game.'
          : 'Спроси, как к игроку-богу обращаться. Имя бога придумывает игрок, не ты. Без set_patron_name генезис не стартует.') +
        ' Новый набор — только если игрок просит другой город.',
    );
  }
  if (d.mode === 'quick' && !pitched) {
    lines.push('Режим quick: один раз randomize_all_tags, опиши город с именем и спроси согласия.');
  }
  if (d.mode === 'dossier') {
    lines.push(
      'Режим dossier: игрок несёт своё ТЗ. Перескажи, лови дыры, не финализируй. ' +
        'Длинный текст → set_player_brief: подробный бриф для генезиса (формулировки игрока сохрани). ' +
        'Сжимай только болтовню и повторы, не выкидывай канон в абзац. ' +
        'Старт только после имени и явного «создавай/готов».',
    );
  }
  if (d.mode === 'questions') {
    lines.push('Режим questions: 1–2 живых вопроса за ход. Имя предложи сам, когда картина сложилась.');
  }
  return lines.join('\n');
}

/** Отбивка, которая сама не выглядит как «остров создаётся». */
export const ONBOARDING_NEED_NAME_NOTE =
  'Имя города ещё не зафиксировано. Назови его или подтверди последнее предложенное — и скажи «создавай», когда будешь готов.';

export const ONBOARDING_NEED_PATRON_NOTE =
  'Как к тебе будут обращаться в городе? Назови имя — без него остров не поднять.';

export const ONBOARDING_FALSE_START_REPLY = ONBOARDING_NEED_NAME_NOTE;

export const ONBOARDING_BUSY_REPLY =
  'Ещё обдумываю предыдущее сообщение — напиши следом, когда отвечу.';

export function formatOnboardingStartReply(cityName) {
  return `Отлично. Поднимаю остров «${cityName}» — обычно минута-две. Правитель напишет сам.`;
}

export function formatPlayerBrief(brief = {}) {
  const parts = [];
  if (brief.city) parts.push(`Город/остров: ${brief.city}`);
  if (brief.ruler) parts.push(`Правитель (связной): ${brief.ruler}`);
  if (brief.freeform) parts.push(`Ещё: ${brief.freeform}`);
  return parts.length ? parts.join('\n') : '(пожеланий нет — полная свобода генезиса)';
}

export function validatePatronName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) return { ok: false, reason: 'Слишком коротко.' };
  if (name.length > 40) return { ok: false, reason: 'Слишком длинно (до 40 символов).' };
  if (!/^[\p{L}\p{M}\d\s\-']+$/u.test(name)) {
    return { ok: false, reason: 'Только буквы, цифры, пробел, дефис.' };
  }
  const lower = name.toLowerCase();
  if (BANNED_EXACT.has(lower) || ['бог', 'богиня', 'покровитель', 'покровительница'].includes(lower)) {
    return { ok: false, reason: 'Нужно собственное имя, не титул.' };
  }
  for (const bad of BANNED_SUBSTR) {
    if (lower.includes(bad)) {
      return { ok: false, reason: 'Имя неприемлемо. Давай без мата и пошлостей.' };
    }
  }
  if (/^\d+$/.test(name)) return { ok: false, reason: 'Одни цифры — не имя.' };
  return { ok: true, name };
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
      { label: 'промысел у края / лов с обрыва', re: /охот.*облак|промысел.*неб|лов.*обрыв|промысел.*кра/ },
      { label: 'вино / брага / дистиллят', re: /винодел|браг|дистиллят|винокур/ },
      { label: 'ткани и красильни', re: /ткан|красильн|пряж/ },
      { label: 'канаты, леса и подъёмники', re: /судостро|верф.*стро|канат|такелаж|лес.*подъём/ },
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
      { label: 'чтение ветров и звёзд', re: /навигац|зв[её]здн.*карт|чтени.*ветр/ },
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
      { label: 'сторожевые выступы у края', re: /верф|небесн.*суд|сторож.*выступ|караул.*кра/ },
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
  const userMsgs = (draft?.messages || []).filter((m) => m.role === 'user' && m.content);
  for (const m of userMsgs.slice(-4)) {
    parts.push(String(m.content).slice(0, 2000));
  }
  return parts.join('\n');
}

function hasNegatedGenerationClaim(text) {
  return /(?:ещё|еще|пока|не)\s+(?:не\s+)?(?:начал[аи]?\s+)?созда|не\s+создаю|не\s+финализ|не\s+начинаю\s+(?:созда|финализ|остров)/i.test(
    String(text || ''),
  );
}

/** Претензия, что ЭТОТ игровой остров уже создаётся — не лор «Нокс создаёт тварей». */
export function claimsOnboardingGenerating(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (
    /поднимаю\s+остров/i.test(raw) ||
    /начинается\s+процесс\s+создан/i.test(raw) ||
    /остров\s+начинает\s+создаваться/i.test(raw) ||
    /правитель\s+напишет\s+сам/i.test(raw)
  ) {
    return !hasNegatedGenerationClaim(raw) || /поднимаю\s+остров/i.test(raw);
  }
  if (/остров\s+(?:сейчас\s+|уже\s+)?созда(?:ёт|ет|ё)ся/i.test(raw)) {
    return !hasNegatedGenerationClaim(raw);
  }
  if (/жди(?:те)?\s+(?:чуть\s+)?(?:минуту|минут[уы]?|письма)/i.test(raw) && /остров|созда/i.test(raw)) {
    return !hasNegatedGenerationClaim(raw);
  }
  return false;
}

export function claimsOnboardingAlreadyCreated(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (/ещё\s+не|еще\s+не|не\s+создан|не\s+готов/i.test(raw) && !/успешно\s+создан/i.test(raw)) {
    return false;
  }
  return /успешно\s+создан|уже\s+создан|остров\s+(?:уже\s+)?готов(?!\p{L})|был\s+создан/i.test(raw);
}

function looksLikeToponym(raw) {
  const name = String(raw || '')
    .replace(/\*+/g, '')
    .replace(/[«»""]/g, '')
    .replace(/[:.,!?…]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  if (!/^\p{Lu}/u.test(words[0])) return null;
  const v = validateCityName(name);
  return v.ok ? v.name : null;
}

const PITCHED_NAME_RES = [
  /(?:твой\s+)?город\s+[—–-]\s+\*{0,2}([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
  /город\s+будет\s+называться\s+\*{0,2}([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
  /город\s+называется\s+\*{0,2}([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
  /называться\s+\*{0,2}([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
  /будет\s+город\s+\*{0,2}([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
  /город\s+[«"*]{1,2}([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
  /остров\s+[«"]([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
  /поднимаю\s+остров\s+[«"]([\p{L}][\p{L}\p{M}\s'-]{1,39})/iu,
];

const USER_NAME_RES = [
  /(?:столица|город|остров)(?:\s+\([^)]+\))?(?:\s+(?:как\s+и\s+сам\s+остров))?\s+называется\s+[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /город\s+называется\s+[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /называется\s+[«"]?([\p{Lu}][\p{L}\p{M}']*(?:\s+[\p{Lu}][\p{L}\p{M}']*){0,2})/u,
  /назов[её]м\s+(?:город\s+|его\s+|остров\s+)?[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /имя\s+(?:города|острова)\s*[—–:-]\s*[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
];

/** Имя города из речи агента, не имя правителя. */
export function extractPitchedCityName(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  for (const re of PITCHED_NAME_RES) {
    re.lastIndex = 0;
    const m = re.exec(raw);
    if (!m) continue;
    const name = looksLikeToponym(m[1]);
    if (name) return name;
  }
  return null;
}

/** Имя, которое игрок сам назвал («город называется X»). */
export function extractUserCityName(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  for (const re of USER_NAME_RES) {
    re.lastIndex = 0;
    const m = re.exec(raw);
    if (!m) continue;
    const name = looksLikeToponym(m[1]);
    if (name) return name;
  }
  return null;
}

export function applyUserNamedCity(draft, text) {
  if (!draft || draft.cityNameApproved) return null;
  const name = extractUserCityName(text);
  if (!name) return null;
  draft.pitchedName = name;
  draft.pitched = true;
  draft.phase = deriveOnboardingPhase(draft);
  return name;
}

const USER_PATRON_RES = [
  /зови(?:те)?\s+меня\s+[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /называй(?:те)?\s+меня\s+[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /меня\s+зовут\s+[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /обраща(?:йся|йтесь)\s+(?:ко?\s+мне\s+)?(?:как\s+)?[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /(?:я|мое\s+имя|моё\s+имя)\s*[—–:-]\s*[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
  /имя\s+(?:бога|покровителя)\s*[—–:-]?\s*[«"]?([\p{Lu}][\p{L}\p{M}\s'-]{0,39})/u,
];

export function extractUserPatronName(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  for (const re of USER_PATRON_RES) {
    re.lastIndex = 0;
    const m = re.exec(raw);
    if (!m) continue;
    const v = validatePatronName(String(m[1] || '').replace(/[«»""]/g, '').trim());
    if (v.ok) return v.name;
  }
  return null;
}

export function applyUserNamedPatron(draft, text) {
  if (!draft || draft.patronNameApproved) return null;
  const named = extractUserPatronName(text);
  if (named) {
    draft.patronName = named;
    draft.patronNameApproved = true;
    return named;
  }
  if (!hasPitchedCity(draft)) return null;
  const raw = String(text || '').trim();
  if (playerConsentsToStart(raw, { pitched: true })) return null;
  if (extractUserCityName(raw)) return null;
  const city = lastPitchedCityName(draft);
  if (city && raw.toLowerCase() === city.toLowerCase()) return null;
  if (!/^[\p{Lu}][\p{L}\p{M}'-]{1,39}$/u.test(raw)) return null;
  const v = validatePatronName(raw);
  if (!v.ok) return null;
  draft.patronName = v.name;
  draft.patronNameApproved = true;
  return v.name;
}

export function lastPitchedCityName(draft) {
  if (draft?.cityName) {
    const v = validateCityName(draft.cityName);
    if (v.ok) return v.name;
  }
  if (draft?.pitchedName) {
    const v = validateCityName(draft.pitchedName);
    if (v.ok) return v.name;
  }
  const messages = draft?.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m?.content) continue;
    if (m.role === 'assistant') {
      const name = extractPitchedCityName(m.content);
      if (name) return name;
    } else if (m.role === 'user') {
      const name = extractUserCityName(m.content);
      if (name) return name;
    }
  }
  return null;
}

/**
 * Игрок явно соглашается на уже предложенный город.
 * Не путать с выбором режима («давай быстрый старт») и вопросом «создаётся?».
 */
export function playerConsentsToStart(text, { pitched = false } = {}) {
  const raw = String(text || '').trim();
  if (!pitched || raw.length < 2 || raw.length > 80) return false;
  if (/[?]/.test(raw)) return false;
  if (/созда(е|ё)тся|уже\s+созда|готов\s+ли/i.test(raw)) return false;
  if (/быстр(ый|о).{0,12}старт|с\s+вопрос|опишу|хочу\s+примерно|через\s+вопрос/i.test(raw)) {
    return false;
  }
  if (/полное\s+описание|представь|покажи\s+концеп/i.test(raw)) return false;
  if (/,\s*но(?!\p{L})|(?<!\p{L})но\s+(измени|другой|другое|имя|не\s+)/iu.test(raw)) {
    return false;
  }
  if (
    /^(да|ок|окей|хорошо|ладно|этот|выбираю|начинаем|начинай|создавай|создаём|создаем|поехали|старт|вперёд|вперед|берём|берем|согласен|подходит|идёт|идет|давай|готов)(?!\p{L})/iu.test(
      raw,
    )
  ) {
    return true;
  }
  if (/^(я\s+)?готов(?!\s+ли)/iu.test(raw)) return true;
  if (/(?<!\p{L})(начинаем|создавай|поехали|поднимай\s+остров)(?!\p{L})/iu.test(raw)) return true;
  return false;
}

/** Игрок явно просит другой город, а не правку одной черты и не старт. */
export function playerAsksReroll(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (playerConsentsToStart(raw, { pitched: true })) return false;
  return /друг(ой|ая|ое|ие)|не\s+тот|не\s+такой|не\s+нравит|заново|ещё\s+вариант|еще\s+вариант|передел|переброс|новый\s+город|другую\s+атмосфер/i.test(
    raw,
  );
}

function withNeedNameFlags(reply, reason) {
  const len = String(reply || '').trim().length;
  if (len > 0 && len <= FALSE_START_STRIP_MAX) {
    return { start: false, name: null, stripFalseStart: true, appendNeedName: false, appendNeedPatron: false, reason };
  }
  return { start: false, name: null, stripFalseStart: false, appendNeedName: true, appendNeedPatron: false, reason };
}

/**
 * Нужно ли самим запустить генезис, если агент не вызвал start_new_game.
 * Старт только при явном согласии и имени уже в драфте (не из новой выдумки в этом ходе).
 */
export function planOnboardingAutoStart({
  userText,
  reply,
  draft,
  usedStart = false,
  generating = false,
} = {}) {
  if (usedStart || generating) {
    return { start: false, name: null, stripFalseStart: false, appendNeedName: false, appendNeedPatron: false, reason: null };
  }
  const historyName = lastPitchedCityName(draft);
  const replyName = extractPitchedCityName(reply);
  const pitched = Boolean(historyName || draft?.pitched || draft?.pitchedName);
  const consented = playerConsentsToStart(userText, { pitched });
  const claimed =
    claimsOnboardingGenerating(reply) || claimsOnboardingAlreadyCreated(reply);

  if (consented) {
    const name = historyName || replyName;
    const v = name ? validateCityName(name) : { ok: false };
    if (!v.ok) return withNeedNameFlags(reply, 'consent_without_name');
    if (!hasPatronName(draft)) {
      return {
        start: false,
        name: v.name,
        stripFalseStart: false,
        appendNeedName: false,
        appendNeedPatron: true,
        reason: 'consent_without_patron',
      };
    }
    return {
      start: true,
      name: v.name,
      stripFalseStart: false,
      appendNeedName: false,
      appendNeedPatron: false,
      reason: 'player_consent',
    };
  }
  if (claimed) {
    return withNeedNameFlags(reply, 'false_start_claim');
  }
  return { start: false, name: null, stripFalseStart: false, appendNeedName: false, appendNeedPatron: false, reason: null };
}

export function maybeSwitchToDossier(draft, userText) {
  const raw = String(userText || '').trim();
  if (!draft || raw.length < DOSSIER_SWITCH_MIN) return false;
  if (draft.mode === 'quick' || draft.cityNameApproved) return false;
  if (draft.mode === 'dossier') return false;
  draft.mode = 'dossier';
  draft.phase = deriveOnboardingPhase(draft);
  return true;
}

export function rememberLongUserBrief(draft, userText, { usedBriefTool = false } = {}) {
  if (!draft) return;
  if (usedBriefTool) return;
  const chunk = String(userText || '').trim();
  if (chunk.length < LONG_USER_MESSAGE_MIN) return;
  if (!draft.playerBrief) draft.playerBrief = { city: '', ruler: '', freeform: '' };
  const city = String(draft.playerBrief.city || '');
  if (!city) {
    draft.playerBrief.city = chunk.slice(0, BRIEF_CITY_MAX);
  } else if (!city.includes(chunk.slice(0, 80))) {
    draft.playerBrief.city = `${city}\n\n${chunk}`.slice(0, BRIEF_CITY_MAX);
  }
  clipOnboardingBrief(draft.playerBrief);
}

export function appendNeedNameNote(reply) {
  const text = String(reply || '').trim();
  if (!text) return ONBOARDING_NEED_NAME_NOTE;
  if (text.includes(ONBOARDING_NEED_NAME_NOTE)) return text;
  return `${text}\n\n${ONBOARDING_NEED_NAME_NOTE}`;
}

export function appendNeedPatronNote(reply) {
  const text = String(reply || '').trim();
  if (!text) return ONBOARDING_NEED_PATRON_NOTE;
  if (text.includes(ONBOARDING_NEED_PATRON_NOTE)) return text;
  return `${text}\n\n${ONBOARDING_NEED_PATRON_NOTE}`;
}
