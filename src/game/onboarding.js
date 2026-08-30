import { emptyPlayerDirectives, normalizePlayerDirectives, hasUnresolvedConflicts } from './playerDirectives.js';
import {
  emptyAxesState,
  normalizeAxesState,
  normalizeQuestionnaire,
  emptyQuestionnaire,
  emptyAxisInterview,
  normalizeAxisInterview,
  missingAxisIds,
  nextAxisOffer,
} from './genesisAxes.js';

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
    /** quick | brief | questions | null (dossier = brief) */
    mode: null,
    /** intro | collecting | pitched | named | generating */
    phase: 'intro',
    playerBrief: {
      city: '',
      ruler: '',
      freeform: '',
    },
    pitched: false,
    pitchedName: null,
    patronName: null,
    patronNameApproved: false,
    axes: emptyAxesState(),
    playerDirectives: emptyPlayerDirectives(),
    concept: null,
    questionnaire: emptyQuestionnaire(),
    axisInterview: emptyAxisInterview(),
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
  d.axes = normalizeAxesState(d.axes);
  d.playerDirectives = normalizePlayerDirectives(d.playerDirectives);
  d.questionnaire = normalizeQuestionnaire(d.questionnaire);
  d.axisInterview = normalizeAxisInterview(d.axisInterview);
  if (d.mode === 'dossier') d.mode = 'brief';
  if (d.concept && typeof d.concept !== 'object') d.concept = null;
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

export function hasReadyConcept(draft) {
  return draft?.concept?.status === 'READY' && Boolean(draft?.concept?.name);
}

export function canStartOnboarding(draft) {
  return Boolean(
    draft?.cityNameApproved &&
      draft?.cityName &&
      hasPatronName(draft) &&
      hasReadyConcept(draft) &&
      !hasUnresolvedConflicts(draft?.playerDirectives),
  );
}

export function formatOnboardingStatusCard(draft, config, { generating = false, occupiedByKey = null } = {}) {
  const d = draft || emptyOnboardingDraft();
  const phase = deriveOnboardingPhase(d, { generating });
  const dirs = normalizePlayerDirectives(d.playerDirectives);
  const axes = normalizeAxesState(d.axes);
  const axisCount = Object.keys(axes).length;
  const pitched = hasPitchedCity(d) || hasReadyConcept(d);
  const brief = d.playerBrief || {};
  const cityPreview = String(brief.city || '').trim().slice(0, BRIEF_PROMPT_CITY_MAX);
  const rulerPreview = String(brief.ruler || '').trim().slice(0, BRIEF_PROMPT_RULER_MAX);
  const freeformPreview = String(brief.freeform || '').trim().slice(0, 4000);
  const conceptLine = hasReadyConcept(d)
    ? `концепт=READY «${d.concept.name}»`
    : d.concept?.status === 'NEEDS_PLAYER_REVISION'
      ? 'концепт=нужна правка космологии'
      : 'концепт=нет';
  const lines = [
    `фаза=${phase}; режим=${d.mode || 'не выбран'};`,
    `питч=${d.pitchedName || d.concept?.name || '—'}; имя=${d.cityName || '—'} approved=${Boolean(d.cityNameApproved)};`,
    `покровитель=${d.patronName || '—'} approved=${Boolean(d.patronNameApproved)};`,
    `${conceptLine}; оси=${axisCount}; required=${dirs.required.length}; конфликты=${dirs.unresolvedConflicts.length};`,
    `ждатьСтарта=${canStartOnboarding(d) ? 'да, после явного согласия' : 'нет'}.`,
  ];
  if (dirs.unresolvedConflicts.length) {
    lines.push('Неразрешённые конфликты космологии (назови игроку, предложи адаптации, не чини молча):');
    for (const c of dirs.unresolvedConflicts) {
      lines.push(`- «${c.requested}»: ${c.reason}`);
      for (const a of c.adaptations || []) lines.push(`    можно: ${a}`);
    }
  }
  if (hasReadyConcept(d) && d.concept.preview) {
    lines.push(`PREVIEW КОНЦЕПТА (это и есть питч, не выдумывай другой город):\n${d.concept.preview}`);
  }
  if (cityPreview) lines.push(`бриф города для генезиса:\n${cityPreview}`);
  if (rulerPreview) lines.push(`правитель:\n${rulerPreview}`);
  if (freeformPreview) lines.push(`ещё к брифу:\n${freeformPreview}`);
  if (phase === 'intro' || !pitched) {
    lines.push('Город ещё не предложен. Не пиши «город уже предложен» и не вызывай start_new_game.');
  } else {
    lines.push(
      'Концепт уже есть. НЕ вызывай sample_genesis_axes заново и не выдумывай новый город. ' +
        (hasUnresolvedConflicts(d.playerDirectives)
          ? 'Сначала разреши конфликты космологии.'
          : hasPatronName(d)
            ? 'Согласие («да/начинаем/создавай/готов») → set_city_name + start_new_game.'
            : 'Спроси, как к игроку-богу обращаться. Имя бога придумывает игрок, не ты. Без set_patron_name генезис не стартует.') +
        ' Новый набор — только если игрок просит другой город.',
    );
  }
  if (d.mode === 'quick' && !hasReadyConcept(d)) {
    lines.push(
      'Режим quick: оси уже семплируются в set_onboarding_mode. Покажи preview, когда он вернётся. Не задавай анкету.',
    );
  }
  if (d.mode === 'brief' && !hasReadyConcept(d)) {
    const missing = missingAxisIds(config, d.axes);
    const offer = nextAxisOffer(config, d.axes);
    lines.push(
      'Режим brief: описание любой длины. Сохрани текст в set_player_brief. Выведи из него set_axis, что можешь.',
    );
    if (missing.length && offer) {
      lines.push(
        `Не хватает осей (${missing.length}). Следующая: «${offer.prompt}».`,
        `Варианты: ${offer.options.map((o) => `${o.id} «${o.label}»`).join('; ')}.`,
        'Плюс random (система) или agent (ты выбираешь value из каталога). Один вопрос за ход — resolve_axis.',
        'Не request_city_concept, пока все оси не закрыты.',
      );
    } else {
      lines.push('Оси закрыты. request_city_concept. Не описывай город до preview.');
    }
  }
  if (d.mode === 'questions' && !hasReadyConcept(d)) {
    const interview = normalizeAxisInterview(d.axisInterview);
    const offer = nextAxisOffer(config, d.axes);
    if (offer) {
      lines.push(
        `АНКЕТА. Задай ОДИН вопрос: «${offer.prompt}».`,
        `Варианты: ${offer.options.map((o) => `${o.id} «${o.label}»`).join('; ')}.`,
        'Ещё: random — система; agent — ты сам выбираешь value. resolve_axis. Не выдумывай дерево.',
        'Не sample_genesis_axes и не request_city_concept, пока оси не закрыты.',
      );
    } else if (!interview.uniqueFeatureAsked) {
      lines.push(
        'Оси закрыты. Спроси, хочет ли игрок добавить уникальную изюминку (set_unique_feature с text или skip=true). Потом request_city_concept.',
      );
    } else {
      lines.push('Анкета собрана. request_city_concept. Не описывай город до preview.');
    }
  }
  if (d.pitchedName && isCityNameOccupied(d.pitchedName, occupiedByKey)) {
    lines.push(`Питч «${d.pitchedName}» уже занят — не подтверждай его, предложи другое имя.`);
  }
  if (d.cityName && isCityNameOccupied(d.cityName, occupiedByKey)) {
    lines.push(`Имя «${d.cityName}» уже занято — сбрось и выбери другое.`);
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

/** Ключ уникальности имени города: trim, схлопнутые пробелы, нижний регистр. */
export function cityNameKey(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function occupiedCityNameError(name) {
  const n = String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
  return n
    ? `Имя «${n}» уже занято. Выберите другое.`
    : 'Это имя уже занято. Выберите другое.';
}

export function isCityNameOccupied(name, occupiedByKey) {
  if (!occupiedByKey) return false;
  const key = cityNameKey(name);
  if (!key) return false;
  return occupiedByKey.has(key);
}

/**
 * Занятые имена: живые и генерирующиеся домены + имена, уже закреплённые
 * в онбординге других игроков.
 */
export function collectOccupiedCityNames({
  domains = [],
  bindings = [],
  excludeUserId = null,
} = {}) {
  const byKey = new Map();
  const add = (raw) => {
    const name = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  };
  for (const domain of domains) add(domain?.name);
  for (const binding of bindings) {
    if (excludeUserId && String(binding.userId) === String(excludeUserId)) continue;
    const draft = binding.onboarding || {};
    add(draft.cityName);
    if (draft.cityNameApproved) add(draft.pitchedName);
  }
  return byKey;
}

/** Имена из Map/массива занятых — для промпта концепта. */
export function occupiedNameList(occupiedByKey, limit = 40) {
  if (!occupiedByKey) return [];
  let names = [];
  if (Array.isArray(occupiedByKey)) names = occupiedByKey.map(String);
  else if (occupiedByKey instanceof Map) names = [...occupiedByKey.values()];
  else if (typeof occupiedByKey.values === 'function') names = [...occupiedByKey.values()];
  else if (typeof occupiedByKey === 'object') names = Object.values(occupiedByKey).map(String);
  return names
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function validateCityNameAvailable(raw, occupiedByKey) {
  const v = validateCityName(raw);
  if (!v.ok) return v;
  if (isCityNameOccupied(v.name, occupiedByKey)) {
    return { ok: false, reason: occupiedCityNameError(v.name) };
  }
  return v;
}

export function appendNameTakenNote(reply, name) {
  const note = occupiedCityNameError(name);
  const text = String(reply || '').trim();
  if (!text) return note;
  if (text.includes('уже занято')) return text;
  return `${text}\n\n${note}`;
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

function looksLikeToponym(raw, occupiedByKey = null) {
  const name = String(raw || '')
    .replace(/\*+/g, '')
    .replace(/[«»""]/g, '')
    .replace(/[:.,!?…]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  if (!/^\p{Lu}/u.test(words[0])) return null;
  const v = validateCityNameAvailable(name, occupiedByKey);
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
export function extractPitchedCityName(text, occupiedByKey = null) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  for (const re of PITCHED_NAME_RES) {
    re.lastIndex = 0;
    const m = re.exec(raw);
    if (!m) continue;
    const name = looksLikeToponym(m[1], occupiedByKey);
    if (name) return name;
  }
  return null;
}

/** Имя, которое игрок сам назвал («город называется X»). */
export function extractUserCityName(text, occupiedByKey = null) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  for (const re of USER_NAME_RES) {
    re.lastIndex = 0;
    const m = re.exec(raw);
    if (!m) continue;
    const name = looksLikeToponym(m[1], occupiedByKey);
    if (name) return name;
  }
  return null;
}

export function applyUserNamedCity(draft, text, occupiedByKey = null) {
  if (!draft || draft.cityNameApproved) return null;
  const name = extractUserCityName(text, occupiedByKey);
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

export function lastPitchedCityName(draft, occupiedByKey = null) {
  if (draft?.cityName) {
    const v = validateCityNameAvailable(draft.cityName, occupiedByKey);
    if (v.ok) return v.name;
  }
  if (draft?.pitchedName) {
    const v = validateCityNameAvailable(draft.pitchedName, occupiedByKey);
    if (v.ok) return v.name;
  }
  const messages = draft?.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m?.content) continue;
    if (m.role === 'assistant') {
      const name = extractPitchedCityName(m.content, occupiedByKey);
      if (name) return name;
    } else if (m.role === 'user') {
      const name = extractUserCityName(m.content, occupiedByKey);
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
    return {
      start: false,
      name: null,
      stripFalseStart: true,
      appendNeedName: false,
      appendNeedPatron: false,
      appendNameTaken: false,
      takenName: null,
      reason,
    };
  }
  return {
    start: false,
    name: null,
    stripFalseStart: false,
    appendNeedName: true,
    appendNeedPatron: false,
    appendNameTaken: false,
    takenName: null,
    reason,
  };
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
  occupiedByKey = null,
} = {}) {
  if (usedStart || generating) {
    return {
      start: false,
      name: null,
      stripFalseStart: false,
      appendNeedName: false,
      appendNeedPatron: false,
      appendNameTaken: false,
      takenName: null,
      reason: null,
    };
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
    if (isCityNameOccupied(v.name, occupiedByKey)) {
      return {
        start: false,
        name: null,
        stripFalseStart: false,
        appendNeedName: false,
        appendNeedPatron: false,
        appendNameTaken: true,
        takenName: v.name,
        reason: 'consent_name_taken',
      };
    }
    if (!hasPatronName(draft)) {
      return {
        start: false,
        name: v.name,
        stripFalseStart: false,
        appendNeedName: false,
        appendNeedPatron: true,
        appendNameTaken: false,
        takenName: null,
        reason: 'consent_without_patron',
      };
    }
    if (hasUnresolvedConflicts(draft?.playerDirectives)) {
      return {
        start: false,
        name: v.name,
        stripFalseStart: false,
        appendNeedName: false,
        appendNeedPatron: false,
        appendNameTaken: false,
        takenName: null,
        reason: 'unresolved_cosmology',
      };
    }
    if (!hasReadyConcept(draft)) {
      return {
        start: false,
        name: v.name,
        stripFalseStart: false,
        appendNeedName: false,
        appendNeedPatron: false,
        appendNameTaken: false,
        takenName: null,
        reason: 'concept_not_ready',
      };
    }
    return {
      start: true,
      name: v.name,
      stripFalseStart: false,
      appendNeedName: false,
      appendNeedPatron: false,
      appendNameTaken: false,
      takenName: null,
      reason: 'player_consent',
    };
  }
  if (claimed) {
    return withNeedNameFlags(reply, 'false_start_claim');
  }
  return {
    start: false,
    name: null,
    stripFalseStart: false,
    appendNeedName: false,
    appendNeedPatron: false,
    appendNameTaken: false,
    takenName: null,
    reason: null,
  };
}

export function maybeSwitchToBrief(draft, userText) {
  const raw = String(userText || '').trim();
  if (!draft || raw.length < DOSSIER_SWITCH_MIN) return false;
  if (draft.mode === 'quick' || draft.cityNameApproved) return false;
  if (draft.mode === 'brief') return false;
  draft.mode = 'brief';
  draft.phase = deriveOnboardingPhase(draft);
  return true;
}

/** @deprecated dossier свёрнут в brief */
export function maybeSwitchToDossier(draft, userText) {
  return maybeSwitchToBrief(draft, userText);
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
