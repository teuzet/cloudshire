/**
 * Пулы болванок mystery / suspense: стартовый конфиг + каталог (переживает wipe).
 * В сторе ось называется arena; в промтах — truthArena / threatArena.
 * Климат посевов — раздельно на городе.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newId } from './ids.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MYSTERY_STARTER_PATH = path.join(ROOT, 'config/mystery-annotation-pool.json');
const SUSPENSE_STARTER_PATH = path.join(ROOT, 'config/suspense-annotation-pool.json');

export const ANNOTATION_AXIS_KEYS = ['arena', 'manifestation', 'worldRelation', 'tone'];
export const STORY_FOOTPRINT_KEYS = ['domains', 'actors', 'stakes', 'places', 'motifs'];

const CLIMATE_MAX = 40;

let mysteryStarterCache = null;
let suspenseStarterCache = null;

export function annotationKindOf(value) {
  return value === 'suspense' ? 'suspense' : 'mystery';
}

export function climateKeyOf(kind) {
  return annotationKindOf(kind) === 'suspense' ? 'suspenseClimate' : 'mysteryClimate';
}

export function poolKeyOf(kind) {
  return annotationKindOf(kind) === 'suspense' ? 'suspenseAnnotationPool' : 'mysteryAnnotationPool';
}

function canonAxis(value) {
  const t = String(value || '')
    .trim()
    .replace(/-/g, '_');
  if (!t) return '';
  return t.toUpperCase();
}

function canonTone(value) {
  return String(value || '').trim().toLowerCase();
}

function axisEq(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
}

function readStarter(filePath, cacheRef, setter) {
  if (cacheRef) return cacheRef;
  let raw = { cards: [] };
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    raw = { cards: [] };
  }
  const cards = (raw.cards || []).map((c) => normalizeAnnotationCard(c)).filter(Boolean);
  setter(cards);
  return cards;
}

export function loadStarterMysteryPool() {
  return readStarter(MYSTERY_STARTER_PATH, mysteryStarterCache, (c) => {
    mysteryStarterCache = c;
  });
}

export function loadStarterSuspensePool() {
  return readStarter(SUSPENSE_STARTER_PATH, suspenseStarterCache, (c) => {
    suspenseStarterCache = c;
  });
}

export function loadStarterPool(kind) {
  return annotationKindOf(kind) === 'suspense' ? loadStarterSuspensePool() : loadStarterMysteryPool();
}

function normalizeFootprintList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s) continue;
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function normalizeStoryFootprint(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of STORY_FOOTPRINT_KEYS) {
    out[key] = normalizeFootprintList(src[key]);
  }
  return out;
}

function normalizeAxes(raw) {
  const src = raw && typeof raw === 'object' ? { ...raw } : {};
  const arena = canonAxis(src.arena || src.truthArena || src.threatArena);
  const manifestation = canonAxis(src.manifestation);
  const worldRelation = canonAxis(src.worldRelation);
  const tone = canonTone(src.tone);
  const axes = {};
  if (arena) axes.arena = arena;
  if (manifestation) axes.manifestation = manifestation;
  if (worldRelation) axes.worldRelation = worldRelation;
  if (tone) axes.tone = tone;
  if (src.gravity != null) axes.gravity = Math.max(0, Math.min(100, Math.round(Number(src.gravity) || 0)));
  return axes;
}

function mysteryFields(raw) {
  return {
    observed: String(raw.observed || raw.brief?.observed || '').trim(),
    truth: String(raw.truth || raw.brief?.truth || '').trim(),
    hiddenness: String(raw.hiddenness || raw.brief?.hiddenness || '').trim(),
    ifSolved: String(raw.ifSolved || raw.brief?.ifSolved || '').trim(),
    ifUnsolved: String(raw.ifUnsolved || raw.brief?.ifUnsolved || '').trim(),
  };
}

function suspenseFields(raw) {
  const brief = raw.brief && typeof raw.brief === 'object' ? raw.brief : {};
  return {
    situation: String(raw.situation || raw.currentSituation || brief.currentSituation || brief.situation || '').trim(),
    threat: String(raw.threat || brief.threat || '').trim(),
    whyNotSolvedNow: String(
      raw.whyNotSolvedNow || raw.whyNotSolvedImmediately || brief.whyNotSolvedImmediately || brief.whyNotSolvedNow || '',
    ).trim(),
    escalation: String(raw.escalation || brief.escalation || '').trim(),
    pointOfNoReturn: String(raw.pointOfNoReturn || brief.pointOfNoReturn || '').trim(),
    ifPrevented: String(raw.ifPrevented || brief.ifPrevented || '').trim(),
    ifNotPrevented: String(raw.ifNotPrevented || brief.ifNotPrevented || '').trim(),
  };
}

export function normalizeAnnotationCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = annotationKindOf(raw.kind || raw.plotType);
  const title = String(raw.title || raw.brief?.title || '').trim();
  if (!title) return null;
  const axes = normalizeAxes(raw.axes || raw);
  if (kind === 'mystery') {
    const fields = mysteryFields(raw);
    if (!fields.observed || !fields.truth) return null;
    return {
      id: String(raw.id || newId('ann')),
      kind: 'mystery',
      source: raw.source === 'generated' ? 'generated' : 'starter',
      title,
      axes,
      ...fields,
      storyFootprint: normalizeStoryFootprint(raw.storyFootprint),
      createdAt: raw.createdAt || null,
    };
  }
  const fields = suspenseFields(raw);
  if (!fields.situation || !fields.threat) return null;
  return {
    id: String(raw.id || newId('ann')),
    kind: 'suspense',
    source: raw.source === 'generated' ? 'generated' : 'starter',
    title,
    axes,
    ...fields,
    storyFootprint: normalizeStoryFootprint(raw.storyFootprint),
    createdAt: raw.createdAt || null,
  };
}

export function mergeAnnotationCatalog(starter, extra = []) {
  const out = [];
  const seen = new Set();
  for (const card of [...(starter || []), ...(extra || [])]) {
    const n = normalizeAnnotationCard(card);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function arenaPromptGroup(kind) {
  return annotationKindOf(kind) === 'suspense' ? 'threatArena' : 'truthArena';
}

export function annotationTagsFromCard(card) {
  const axes = card?.axes || {};
  const kind = annotationKindOf(card?.kind);
  const tags = [];
  if (axes.arena) {
    const arena = String(axes.arena);
    tags.push({ groupId: 'arena', tagId: arena, tagName: arena });
    tags.push({ groupId: arenaPromptGroup(kind), tagId: arena.toLowerCase(), tagName: arena });
  }
  for (const groupId of ['manifestation', 'worldRelation', 'tone']) {
    const tagId = axes[groupId];
    if (!tagId) continue;
    tags.push({
      groupId,
      tagId: groupId === 'tone' ? String(tagId) : String(tagId).toLowerCase(),
      tagName: String(tagId),
    });
  }
  if (axes.gravity != null) {
    tags.push({ groupId: 'gravity', tagId: String(axes.gravity), tagName: String(axes.gravity) });
  }
  return tags;
}

export function ensureDomainClimates(domain) {
  if (!domain || typeof domain !== 'object') return domain;
  if (!Array.isArray(domain.mysteryClimate)) domain.mysteryClimate = [];
  if (!Array.isArray(domain.suspenseClimate)) domain.suspenseClimate = [];
  if (Array.isArray(domain.seedClimate) && domain.seedClimate.length) {
    for (const row of domain.seedClimate) {
      const next = normalizeClimateRow(row);
      if (!next) continue;
      const key = climateKeyOf(next.storyType);
      domain[key].push(next);
    }
    domain.seedClimate = [];
  }
  return domain;
}

function normalizeClimateRow(row) {
  if (!row || typeof row !== 'object') return null;
  const axes = normalizeAxes(row.axes || row);
  return {
    tick: Number.isInteger(Number(row.tick)) ? Number(row.tick) : null,
    storyType: annotationKindOf(row.storyType),
    annotationId: row.annotationId || null,
    axes,
  };
}

export function climateOf(domain, kind) {
  ensureDomainClimates(domain);
  const key = climateKeyOf(kind);
  return domain?.[key] || [];
}

export function recordSeedClimate(domain, { tick = null, storyType = 'mystery', axes = {}, annotationId = null } = {}) {
  if (!domain || typeof domain !== 'object') return;
  ensureDomainClimates(domain);
  const kind = annotationKindOf(storyType);
  const key = climateKeyOf(kind);
  domain[key].push({
    tick: Number.isInteger(Number(tick)) ? Number(tick) : null,
    storyType: kind,
    annotationId: annotationId || null,
    axes: normalizeAxes(axes),
  });
  if (domain[key].length > CLIMATE_MAX) domain[key] = domain[key].slice(-CLIMATE_MAX);
}

/** Чем свежее совпадение оси — тем выше штраф. */
export function climatePenalty(card, climate = [], { nowTick = 0 } = {}) {
  const axes = card?.axes || {};
  let score = 0;
  for (const row of climate || []) {
    const rowAxes = normalizeAxes(row.axes || row);
    const age = Math.max(0, (Number(nowTick) || 0) - (Number(row.tick) || 0));
    const recency = 1 / (1 + age);
    for (const key of ANNOTATION_AXIS_KEYS) {
      if (!axes[key] || !rowAxes[key]) continue;
      const same = key === 'tone' ? String(axes[key]) === String(rowAxes[key]) : axisEq(axes[key], rowAxes[key]);
      if (same) score += recency;
    }
  }
  return score;
}

export function noveltyScore(card, climate, opts) {
  return 1 / (1 + climatePenalty(card, climate, opts));
}

/** Равномерная выборка без возвращения: климат не взвешивает десятку. */
export function sampleAnnotationShortlist(pool, { n = 10, rng = Math.random, storyType = 'mystery' } = {}) {
  const kind = annotationKindOf(storyType);
  const cards = (pool || []).filter((c) => annotationKindOf(c.kind) === kind);
  const want = Math.max(0, Math.min(n, cards.length));
  const shuffled = [...cards];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, want);
}

export function sortShortlistByNovelty(cards, climate, opts) {
  return [...(cards || [])].sort((a, b) => noveltyScore(b, climate, opts) - noveltyScore(a, climate, opts));
}

function annotationCfg(config, kind) {
  const plot = config?.tick?.plot || {};
  return annotationKindOf(kind) === 'suspense' ? plot.suspense?.annotation || {} : plot.mystery?.annotation || {};
}

export function poolMinSize(config, kind = 'mystery') {
  const n = Number(annotationCfg(config, kind).poolMin ?? 60);
  return Math.max(10, Math.round(Number.isFinite(n) ? n : 60));
}

export function refillBatchSize(config, kind = 'mystery') {
  const n = Number(annotationCfg(config, kind).refillBatch ?? 3);
  return Math.max(1, Math.min(6, Math.round(Number.isFinite(n) ? n : 3)));
}

export function formatAnnotationCardForPrompt(card, index) {
  const axes = card?.axes || {};
  const head = [
    `--- карточка ${index + 1} id=${card.id} ---`,
    `название: ${card.title}`,
    `оси: arena=${axes.arena || '—'} manifestation=${axes.manifestation || '—'} worldRelation=${axes.worldRelation || '—'} tone=${axes.tone || '—'} gravity=${axes.gravity ?? '—'}`,
  ];
  if (annotationKindOf(card?.kind) === 'suspense') {
    return [
      ...head,
      `Сейчас: ${card.situation}`,
      `Угроза: ${card.threat}`,
      card.whyNotSolvedNow ? `Почему не закрыть сразу: ${card.whyNotSolvedNow}` : null,
      card.escalation ? `Эскалация: ${card.escalation}` : null,
      card.pointOfNoReturn ? `Точка невозврата: ${card.pointOfNoReturn}` : null,
      card.ifPrevented ? `Если предотвратить: ${card.ifPrevented}` : null,
      card.ifNotPrevented ? `Если не предотвратить: ${card.ifNotPrevented}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    ...head,
    `Наблюдаемое: ${card.observed}`,
    `Истина: ${card.truth}`,
    card.hiddenness ? `Почему не очевидно: ${card.hiddenness}` : null,
    card.ifSolved ? `Если разгадана: ${card.ifSolved}` : null,
    card.ifUnsolved ? `Если не разгадана: ${card.ifUnsolved}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function axesFromGeneratedSeed(seed) {
  const axes = {};
  for (const t of seed?.tags || []) {
    const gid = String(t.groupId || '');
    const name = t.tagName || t.tagId;
    if (gid === 'truthArena' || gid === 'threatArena' || gid === 'arena') {
      axes.arena = name;
    }
    if (gid === 'manifestation' || gid === 'worldRelation') {
      axes[gid] = name;
    }
    if (gid === 'tone' || gid === 'tonePrimary') {
      if (!axes.tone) axes.tone = name;
    }
  }
  if (Number.isFinite(Number(seed?.gravity))) axes.gravity = Math.round(Number(seed.gravity));
  return axes;
}

export function annotationCardFromGenerated({ seed, annotation, kind = 'mystery' } = {}) {
  const k = annotationKindOf(kind);
  const axes = axesFromGeneratedSeed(seed);
  if (k === 'suspense') {
    return normalizeAnnotationCard({
      id: newId('ann'),
      kind: 'suspense',
      source: 'generated',
      title: annotation?.workingTitle || annotation?.title,
      axes,
      situation: annotation?.situation || annotation?.currentSituation,
      threat: annotation?.threat,
      whyNotSolvedNow: annotation?.whyNotSolvedNow || annotation?.whyNotSolvedImmediately,
      escalation: annotation?.escalation,
      pointOfNoReturn: annotation?.pointOfNoReturn,
      ifPrevented: annotation?.ifPrevented,
      ifNotPrevented: annotation?.ifNotPrevented,
      storyFootprint: inferStoryFootprint({
        kind: 'suspense',
        title: annotation?.workingTitle,
        axes,
        situation: annotation?.situation,
        threat: annotation?.threat,
      }),
      createdAt: new Date().toISOString(),
    });
  }
  return normalizeAnnotationCard({
    id: newId('ann'),
    kind: 'mystery',
    source: 'generated',
    title: annotation?.workingTitle || annotation?.title,
    axes,
    observed: annotation?.observed,
    truth: annotation?.truth,
    hiddenness: annotation?.hiddenness,
    ifSolved: annotation?.ifSolved,
    ifUnsolved: annotation?.ifUnsolved,
    storyFootprint: inferStoryFootprint({
      kind: 'mystery',
      title: annotation?.workingTitle,
      axes,
      observed: annotation?.observed,
      truth: annotation?.truth,
    }),
    createdAt: new Date().toISOString(),
  });
}

export function unusedAnnotationPool(pool, climate = []) {
  const used = new Set((climate || []).map((r) => r.annotationId).filter(Boolean));
  const fresh = (pool || []).filter((c) => !used.has(c.id));
  return fresh.length >= 4 ? fresh : pool || [];
}

const ARENA_DOMAINS = {
  HUMAN: ['SOCIAL_ORDER'],
  CREATURE: ['AGRICULTURE'],
  ECOLOGY: ['AGRICULTURE'],
  MATERIAL: ['CRAFT'],
  BUILT: ['INFRASTRUCTURE'],
  EARTH: ['LAND'],
  SKY: ['KNOWLEDGE'],
};

function pushUniq(list, value) {
  const s = String(value || '').trim();
  if (!s) return;
  const key = s.toUpperCase();
  if (list.some((x) => String(x).toUpperCase() === key)) return;
  list.push(s);
}

function blobOf(card) {
  return [
    card.title,
    card.observed,
    card.truth,
    card.situation,
    card.threat,
    card.ifSolved,
    card.ifUnsolved,
    card.ifPrevented,
    card.ifNotPrevented,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/**
 * Индексация для фиттера. Не ось генератора: штамп по тексту и аренам.
 */
export function inferStoryFootprint(card = {}) {
  const existing = normalizeStoryFootprint(card.storyFootprint);
  if (STORY_FOOTPRINT_KEYS.some((k) => existing[k].length)) return existing;

  const axes = normalizeAxes(card.axes || card);
  const text = blobOf(card);
  const domains = [...(ARENA_DOMAINS[axes.arena] || [])];
  const actors = [];
  const stakes = [];
  const places = [];
  const motifs = [];

  if (axes.worldRelation === 'CONTACT') pushUniq(domains, 'TRADE');
  if (axes.worldRelation === 'LEGACY') pushUniq(domains, 'KNOWLEDGE');

  const domainHints = [
    [/наслед|семь|сватов|детей|родител/, 'FAMILY'],
    [/мастерск|ремесл|шкур|волокн|ткан|кузн/, 'CRAFT'],
    [/пастбищ|стад|урожа|почв|посев|зерн|паст/, 'AGRICULTURE'],
    [/вод[аыеу]|колод|цистерн|сток|плотин/, 'WATER'],
    [/храм|жрец|обряд|бог[а-я]*-покровител/, 'RELIGION'],
    [/совет|старост|указ|страж|налог/, 'GOVERNANCE'],
    [/торг|рынок|груз|сопряжен/, 'TRADE'],
    [/земл|надел|меж[еа]|границ/, 'LAND'],
    [/дорог|мост|кладк|построй|колодц/, 'INFRASTRUCTURE'],
    [/ран|болезн|ранен|кож|симптом/, 'HEALTH'],
    [/памят|знан|чертёж|документ|свидетел/, 'KNOWLEDGE'],
  ];
  for (const [re, tag] of domainHints) {
    if (re.test(text)) pushUniq(domains, tag);
  }

  const actorHints = [
    [/мастер|ремеслен/, 'ARTISANS'],
    [/подмастер/, 'APPRENTICES'],
    [/пастух|стад/, 'HERDERS'],
    [/крестьян|пахар|полевод/, 'FARMERS'],
    [/торгов|купц/, 'MERCHANTS'],
    [/жрец|храмов/, 'PRIESTS'],
    [/страж|дозор/, 'GUARDS'],
    [/старост|старейшин|советчик/, 'ELDERS'],
    [/работник|носильщик|труд/, 'LABORERS'],
    [/дет|младш|наследник/, 'CHILDREN'],
    [/чужезем|приезж|соседн(его|ого) остров/, 'OUTSIDERS'],
    [/семь/, 'FAMILIES'],
  ];
  for (const [re, tag] of actorHints) {
    if (re.test(text)) pushUniq(actors, tag);
  }

  const g = Number(axes.gravity);
  if (Number.isFinite(g)) {
    if (g >= 80) pushUniq(stakes, 'INDEPENDENCE');
    else if (g >= 55) pushUniq(stakes, 'SOCIAL_COHESION');
    else if (g >= 30) pushUniq(stakes, 'LIVELIHOOD');
    else pushUniq(stakes, 'KNOWLEDGE');
  }
  const stakeHints = [
    [/земл|надел|пастбищ/, 'LAND'],
    [/хлеб|пищ|урожа|стад/, 'FOOD'],
    [/вод[аыеу]|колод/, 'WATER'],
    [/труд|заработ|хозяйств/, 'LIVELIHOOD'],
    [/закон|совет|прав/, 'LEGITIMACY'],
    [/жизн|смерт|ран/, 'LIFE'],
  ];
  for (const [re, tag] of stakeHints) {
    if (re.test(text)) pushUniq(stakes, tag);
  }

  const placeHints = [
    [/мастерск/, 'WORKSHOPS'],
    [/пол[ея]|пашн/, 'FIELDS'],
    [/пастбищ/, 'PASTURES'],
    [/храм/, 'TEMPLE'],
    [/рынок/, 'MARKET'],
    [/дом|квартал|семь/, 'HOMES'],
    [/край|обрыв|кромк/, 'ISLAND_EDGE'],
    [/лес|склон|дич/, 'WILDERNESS'],
    [/подзем|погреб|шахт/, 'UNDERGROUND'],
    [/склад|амбар/, 'STORAGE'],
    [/колод|цистерн/, 'WATERWORKS'],
    [/дорог|мост/, 'ROADS'],
  ];
  for (const [re, tag] of placeHints) {
    if (re.test(text)) pushUniq(places, tag);
  }
  if (axes.manifestation === 'BODY') pushUniq(places, 'HOMES');
  if (axes.manifestation === 'SOCIAL_PATTERN') pushUniq(places, 'HOMES');
  if (axes.manifestation === 'LANDSCAPE' || axes.manifestation === 'PLACE') pushUniq(places, 'WILDERNESS');
  if (axes.manifestation === 'STRUCTURE') pushUniq(places, 'WORKSHOPS');

  const motifHints = [
    [/наслед/, 'inheritance'],
    [/сопряжен|чуж(ая|ой|ое)|заимств/, 'knowledge transfer'],
    [/ночн/, 'night work'],
    [/границ|меж[еа]/, 'boundary dispute'],
    [/чертёж|чертёж/, 'lost plan'],
    [/ран|кож|раствор/, 'occupational harm'],
    [/взаимопомощ|долг/, 'mutual aid'],
    [/памят|верси/, 'competing memory'],
    [/эрози|ополз|склон/, 'soil erosion'],
    [/гриб|паразит|кладк/, 'invasive species'],
    [/карантин/, 'quarantine'],
    [/наследован/, 'succession'],
  ];
  for (const [re, tag] of motifHints) {
    if (re.test(text)) pushUniq(motifs, tag);
  }
  if (axes.arena) pushUniq(motifs, String(axes.arena).toLowerCase());
  if (axes.worldRelation) pushUniq(motifs, String(axes.worldRelation).toLowerCase());

  return normalizeStoryFootprint({ domains, actors, stakes, places, motifs });
}

export function stampStarterFootprint(card) {
  const n = normalizeAnnotationCard(card);
  if (!n) return null;
  const fp = normalizeStoryFootprint(n.storyFootprint);
  const empty = STORY_FOOTPRINT_KEYS.every((k) => !fp[k].length);
  return { ...n, storyFootprint: empty ? inferStoryFootprint(n) : fp };
}
