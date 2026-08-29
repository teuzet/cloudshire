import { newId } from './ids.js';
import { textsLookSame } from './processes.js';
import { normalizeTruthGraph, judgeTruthGraph, parseMysteryShapes, normalizeFactList, RESOLUTION_FACT_MAX } from './mysteryGraph.js';
import { normalizeDiscoveryLadder, normalizeHiddenPremises, judgeSuspenseCore } from './suspenseGraph.js';

/**
 * Сюжетные нити — ядро мира: событий вне нитей не бывает.
 * Здесь только модель и формат; отбор битов, окраска и часы — в движке тика.
 *
 * Механика (см. docs/PIVOT_PLOTLINES.md):
 *   gravity     — масштаб последствий; у саспенса сеет движок, у тайны ставит plotStakes
 *   urgency     — шанс, что история сама сдвинется в месяц без дела
 *   temperature — интерес (старые нити, указы, сопряжение; греет внимание игрока)
 *   importance  — внутренний масштаб дельт; у трёхтактных зеркало gravity, агенты не ставят
 *   maxAgeMonths / ageMonths — сколько месяцев история живёт без внимания;
 *     срок сам по себе не развязка: выдохшаяся нить гаснет, только если нет дел и упоминаний
 *   closeWhen — успешный исход; mootWhen — когда задача потеряла смысл
 *   relatedStats — какие стороны города сейчас в игре (по ним кидается окраска бита)
 */

function clamp100(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Обрезка по границе слова: обрубки в середине слова копятся из тика в тик. */
function clipText(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:—-]+$/, '')}…`;
}

export const PLOT_SUMMARY_MAX = 900;
export const PLOT_HOOK_MAX = 160;
export const PLOT_TITLE_MAX = 120;
export { clipText as clipPlotText };

export const PLOT_KINDS = ['story', 'errand', 'order'];
export const THREE_ACT_TYPES = ['suspense', 'mystery'];
export const STORY_TYPES = ['suspense', 'mystery', 'default'];

export function isStoryPlot(plot) {
  return plot?.kind === 'story';
}

/** Только для посева городской истории. Поручения, указы и сопряжение движок ставит в default. */
export function pickStoryType(rng = Math.random) {
  return rng() < 0.5 ? 'mystery' : 'suspense';
}

/**
 * Тип, который выставил движок: suspense | mystery | default.
 * Default — поручение, указ, главная нить стыка, наследие без типа.
 * Нативная городская история остаётся трёхтактной и на доске сопряжения,
 * пока не станет главной нитью встречи. Contested меняет рассказчика, не тип.
 */
export function storyTypeOf(plot) {
  if (!plot || plot.kind !== 'story' || plot.isMainConflux) {
    return 'default';
  }
  if (THREE_ACT_TYPES.includes(plot.storyType)) return plot.storyType;
  return 'default';
}

export function isThreeActPlot(plot) {
  const t = storyTypeOf(plot);
  return t === 'suspense' || t === 'mystery';
}

/** Масштаб истории для механики: у трёхтактных gravity, иначе внутренний importance. */
export function plotScale(plot) {
  if (isThreeActPlot(plot)) return clamp100(plot?.gravity, 40);
  return clamp100(plot?.importance, 40);
}

export function plotBeatAgentId(plot) {
  const t = storyTypeOf(plot);
  if (t === 'mystery') return 'mysteryBeat';
  if (t === 'suspense') return 'suspenseBeat';
  return 'storyBeat';
}

function clampStakes(n, fallback = 40) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, v));
}

function storyActState(p = {}) {
  const type = storyTypeOf(p);
  if (type === 'default') {
    return {
      storyType: 'default',
      act: null,
      urgency: null,
      gravity: null,
      urgency0: null,
      gravity0: null,
      escalationLevel: null,
      maxEscalations: null,
      truth: '',
      truthGraph: null,
      observedFacts: [],
      resolutionFacts: [],
      ending: null,
      asksSequel: false,
      annotationId: null,
      ifSolved: '',
      ifUnsolved: '',
      ifPrevented: '',
      ifNotPrevented: '',
      depth: null,
      hiddenPremises: [],
      discoveryLadder: null,
      closureGate: '',
      closureUnlocked: null,
      tonePrimary: null,
      toneSecondary: null,
      source: null,
      situation: null,
      dynamic: null,
      legacyAxes: [],
      unattendedBeats: null,
    };
  }
  const urgency = clampStakes(p.urgency, 40);
  const gravity = clampStakes(p.gravity, 40);
  const graph = type === 'mystery' ? normalizeTruthGraph(p.truthGraph) : null;
  const maxEsc = Math.max(1, Math.round(Number(p.maxEscalations ?? 3)));
  const depth =
    type === 'suspense' ? Math.max(1, Math.min(4, Math.round(Number(p.depth) || 1))) : null;
  const ladder =
    type === 'suspense' ? normalizeDiscoveryLadder(p.discoveryLadder, depth) : null;
  return {
    storyType: type,
    act: Number(p.act) === 2 ? 2 : 1,
    urgency,
    gravity,
    urgency0: clampStakes(p.urgency0 ?? urgency, urgency),
    gravity0: clampStakes(p.gravity0 ?? gravity, gravity),
    escalationLevel: Math.max(0, Math.min(maxEsc, Math.round(Number(p.escalationLevel) || 0))),
    maxEscalations: maxEsc,
    truth: type === 'mystery' && !graph ? String(p.truth || '') : '',
    truthGraph: graph,
    observedFacts: type === 'mystery' ? normalizeFactList(p.observedFacts).facts : [],
    resolutionFacts:
      type === 'mystery' ? normalizeFactList(p.resolutionFacts, { maxLen: RESOLUTION_FACT_MAX }).facts : [],
    ending: ['crit', 'ok', 'fail'].includes(p.ending) ? p.ending : null,
    asksSequel: Boolean(p.asksSequel),
    annotationId:
      (type === 'mystery' || type === 'suspense') && p.annotationId ? String(p.annotationId) : null,
    ifSolved: type === 'mystery' ? clipText(String(p.ifSolved || ''), 900) : '',
    ifUnsolved: type === 'mystery' ? clipText(String(p.ifUnsolved || ''), 900) : '',
    ifPrevented: type === 'suspense' ? clipText(String(p.ifPrevented || ''), 900) : '',
    ifNotPrevented: type === 'suspense' ? clipText(String(p.ifNotPrevented || ''), 900) : '',
    depth,
    hiddenPremises: type === 'suspense' ? normalizeHiddenPremises(p.hiddenPremises, depth) : [],
    discoveryLadder: ladder,
    closureGate: type === 'suspense' ? clipText(p.closureGate, PLOT_HOOK_MAX * 2) : '',
    closureUnlocked: type === 'suspense' ? (depth <= 1 ? true : Boolean(p.closureUnlocked)) : null,
    tonePrimary: type === 'suspense' ? String(p.tonePrimary || '').trim() || null : null,
    toneSecondary: type === 'suspense' ? String(p.toneSecondary || '').trim() || null : null,
    source: type === 'suspense' ? String(p.source || '').trim() || null : null,
    situation: type === 'suspense' ? String(p.situation || '').trim() || null : null,
    dynamic: type === 'suspense' ? String(p.dynamic || '').trim() || null : null,
    legacyAxes: type === 'suspense' && Array.isArray(p.legacyAxes) ? p.legacyAxes.map(String).filter(Boolean) : [],
    unattendedBeats: type === 'suspense' ? Math.max(0, Math.round(Number(p.unattendedBeats) || 0)) : null,
  };
}

export function isOrderPlot(plot) {
  return plot?.kind === 'order';
}

/** Бинарная осведомлённость города о нити как о полной линии. */
export function refreshPlotAwareness(plot) {
  if (!plot || typeof plot !== 'object') return plot;
  plot.plotAwareness = normalizePlotAwarenessMap(plot);
  return plot;
}

function normalizePlotAwarenessMap(plot) {
  const raw = plot?.plotAwareness;
  const hadField = raw && typeof raw === 'object' && !Array.isArray(raw);
  const next = {};
  if (hadField) {
    for (const [k, v] of Object.entries(raw)) {
      if (v) next[String(k)] = true;
    }
  }
  const host = plot?.hostDomainId ? String(plot.hostDomainId) : null;
  if (host) next[host] = true;
  if (plot?.isMainConflux) {
    for (const id of Array.isArray(plot.concernsDomainIds) ? plot.concernsDomainIds : []) {
      if (id) next[String(id)] = true;
    }
  }
  // Старые сохранения и карточки без поля: участники concerns уже знали линию.
  if (!hadField || !Object.keys(next).length) {
    if (Array.isArray(plot?.concernsDomainIds)) {
      for (const id of plot.concernsDomainIds) {
        if (id) next[String(id)] = true;
      }
    }
  }
  return next;
}

function clampChance(n, fallback = 0.2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function orderCadence(p, config = null) {
  const fallback = Number(config?.tick?.plot?.orders?.defaultChance ?? 0.2);
  const fireOn = p?.fireOn === 'conflux_dock' ? 'conflux_dock' : null;
  const every = Math.round(Number(p?.scheduleEveryMonths));
  const scheduled = !fireOn && Number.isInteger(every) && every >= 1 && every <= 12;
  const due = Number(p?.nextDueTick);
  const lastFired = p?.lastFiredConfluxId ? String(p.lastFiredConfluxId) : null;
  return {
    modifierId: p?.modifierId ? String(p.modifierId) : null,
    orderText: String(p?.orderText || '').trim(),
    fireOn,
    lastFiredConfluxId: fireOn ? lastFired : null,
    // Регулярность, вероятность и сопряжение взаимоисключающи.
    fireChance: fireOn || scheduled ? 0 : clampChance(p?.fireChance, Number.isFinite(fallback) ? fallback : 0.2),
    scheduleEveryMonths: scheduled ? every : null,
    nextDueTick: fireOn ? null : Number.isInteger(due) ? due : null,
    durationMonths: (() => {
      const n = Math.round(Number(p?.durationMonths));
      return Number.isInteger(n) && n >= 1 ? Math.min(36, n) : null;
    })(),
    expiresTick: (() => {
      const n = Math.round(Number(p?.durationMonths));
      if (!(Number.isInteger(n) && n >= 1) || p?.expiresTick == null || p.expiresTick === '') return null;
      const exp = Number(p.expiresTick);
      return Number.isInteger(exp) ? exp : null;
    })(),
  };
}

export function plotConfig(config) {
  const p = config?.tick?.plot || {};
  const board = p.board || {};
  const beats = p.beats || {};
  const roll = p.roll || {};
  const stats = p.stats || {};
  const log = p.log || {};
  return {
    enabled: p.enabled !== false,
    board: {
      maxOpen: Math.max(2, Math.min(10, Number(board.maxOpen) || 5)),
      maxErrands: Math.max(0, Math.min(6, Number(board.maxErrands) ?? 2)),
      targetImportance: Math.max(0, Math.min(400, Number(board.targetImportance ?? 100))),
      seedMaxChance: Number(board.seedMaxChance ?? 0.5),
      seedCooldownMonths: Math.max(0, Math.min(12, Number(board.seedCooldownMonths) ?? 2)),
      sequelChance: Math.max(0, Math.min(1, Number(board.sequelChance ?? 0.55))),
    },
    beats: {
      maxPerTick: Math.max(1, Math.min(6, Number(beats.maxPerTick) || 3)),
      baseChance: Number(beats.baseChance ?? 0.15),
      temperatureWeight: Number(beats.temperatureWeight ?? 0.5),
      importanceWeight: Number(beats.importanceWeight ?? 0.2),
      agePressure: Number(beats.agePressure ?? 0.15),
      minChance: Number(beats.minChance ?? 0.05),
      maxChance: Number(beats.maxChance ?? 0.8),
    },
    temperature: {
      initial: clamp100(p.temperature?.initial ?? 30),
      decayPerTick: Math.max(0, Number(p.temperature?.decayPerTick ?? 8)),
      perTouch: Math.max(0, Number(p.temperature?.perTouch ?? 12)),
      afterBeat: clamp100(p.temperature?.afterBeat ?? 20),
      // Ниже этого порога просроченную нить без дел считаем забытой.
      fadeBelow: clamp100(p.temperature?.fadeBelow ?? 18, 18),
    },
    roll: {
      // Сжатая шкала окраски бита: слабость чувствуется, но не приговаривает.
      minChance: Number(roll.minChance ?? 0.25),
      maxChance: Number(roll.maxChance ?? 0.75),
      primaryWeight: Number(roll.primaryWeight ?? 2),
      dualBand: Number(roll.dualBand ?? 0.2),
      finishCritShare: Number(roll.finishCritShare ?? 0.25),
      finishFailCurve: Array.isArray(roll.finishFailCurve) ? roll.finishFailCurve : [],
    },
    stats: {
      playerBudget: Math.max(1, Number(stats.playerBudget ?? 6)),
      worldBudget: Math.max(1, Number(stats.worldBudget ?? 8)),
      importanceScale: Number(stats.importanceScale ?? 0.08),
      finaleFactor: Number(stats.finaleFactor ?? 2),
      catastropheCooldown: Math.max(0, Number(stats.catastropheCooldown ?? 6)),
    },
    log: {
      influenceChance: Number(log.influenceChance ?? 0.35),
    },
    quiet: {
      driftChance: Number(p.quiet?.driftChance ?? 0.65),
      notableChance: Number(p.quiet?.notableChance ?? 0.25),
      meanReversion: Number(p.quiet?.meanReversion ?? 0.7),
      extremeBias: Number(p.quiet?.extremeBias ?? 1),
      avoidRepeat: Math.max(0, Math.min(10, Number(p.quiet?.avoidRepeat ?? 4))),
    },
    tagGroups: Array.isArray(p.tagGroups) ? p.tagGroups : [],
    mysteryTagGroups: Array.isArray(p.mystery?.tagGroups) ? p.mystery.tagGroups : [],
    mysteryArchitect: (() => {
      const a = p.mystery?.architect || {};
      const gmin = Math.round(Number(a.gravityMin ?? 15));
      const gmax = Math.round(Number(a.gravityMax ?? 90));
      return {
        judgeAttempts: Math.max(1, Math.min(8, Math.round(Number(a.judgeAttempts ?? 3)))),
        gravityMin: Math.max(0, Math.min(100, Number.isFinite(gmin) ? gmin : 15)),
        gravityMax: Math.max(0, Math.min(100, Number.isFinite(gmax) ? gmax : 90)),
        tagGroups: Array.isArray(a.tagGroups) ? a.tagGroups : [],
        sourceByType:
          a.sourceByType && typeof a.sourceByType === 'object' && !Array.isArray(a.sourceByType)
            ? a.sourceByType
            : {},
      };
    })(),
    mysteryAnnotation: (() => {
      const a = p.mystery?.annotation || {};
      const gmin = Math.round(Number(a.gravityMin ?? 0));
      const gmax = Math.round(Number(a.gravityMax ?? 100));
      return {
        gravityMin: Math.max(0, Math.min(100, Number.isFinite(gmin) ? gmin : 0)),
        gravityMax: Math.max(0, Math.min(100, Number.isFinite(gmax) ? gmax : 100)),
        secondaryToneChance: Math.max(0, Math.min(1, Number(a.secondaryToneChance ?? 0))),
        judgeAttempts: Math.max(1, Math.min(2, Math.round(Number(a.judgeAttempts ?? 2)))),
        recentWindow: Math.max(1, Math.min(8, Math.round(Number(a.recentWindow ?? 5)))),
        cooldown: {
          previousMultiplier: Math.max(0.01, Number(a.cooldown?.previousMultiplier ?? 0.2)),
          frequentWindow: Math.max(1, Math.min(12, Math.round(Number(a.cooldown?.frequentWindow ?? 4)))),
          frequentMinCount: Math.max(2, Math.round(Number(a.cooldown?.frequentMinCount ?? 2))),
          frequentMultiplier: Math.max(0.01, Number(a.cooldown?.frequentMultiplier ?? 0.4)),
          absentWindow: Math.max(1, Math.min(12, Math.round(Number(a.cooldown?.absentWindow ?? 5)))),
          absentMultiplier: Math.max(1, Number(a.cooldown?.absentMultiplier ?? 1.3)),
        },
        incompatible:
          a.incompatible && typeof a.incompatible === 'object' && !Array.isArray(a.incompatible)
            ? a.incompatible
            : {},
        tagGroups: Array.isArray(a.tagGroups) ? a.tagGroups : [],
        poolMin: Math.max(10, Math.round(Number(a.poolMin ?? 60))),
        refillBatch: Math.max(1, Math.min(6, Math.round(Number(a.refillBatch ?? 3)))),
        shortlistSize: Math.max(4, Math.min(20, Math.round(Number(a.shortlistSize ?? 10)))),
        modifierGravityMin: Math.max(0, Math.min(100, Math.round(Number(a.modifierGravityMin ?? 40)))),
      };
    })(),
    suspenseAnnotation: (() => {
      const a = p.suspense?.annotation || {};
      const m = p.mystery?.annotation || {};
      const gmin = Math.round(Number(a.gravityMin ?? m.gravityMin ?? 0));
      const gmax = Math.round(Number(a.gravityMax ?? m.gravityMax ?? 100));
      return {
        gravityMin: Math.max(0, Math.min(100, Number.isFinite(gmin) ? gmin : 0)),
        gravityMax: Math.max(0, Math.min(100, Number.isFinite(gmax) ? gmax : 100)),
        secondaryToneChance: Math.max(0, Math.min(1, Number(a.secondaryToneChance ?? 0))),
        judgeAttempts: Math.max(1, Math.min(2, Math.round(Number(a.judgeAttempts ?? 2)))),
        recentWindow: Math.max(1, Math.min(8, Math.round(Number(a.recentWindow ?? 5)))),
        cooldown: {
          previousMultiplier: Math.max(0.01, Number(a.cooldown?.previousMultiplier ?? m.cooldown?.previousMultiplier ?? 0.2)),
          frequentWindow: Math.max(1, Math.min(12, Math.round(Number(a.cooldown?.frequentWindow ?? m.cooldown?.frequentWindow ?? 4)))),
          frequentMinCount: Math.max(2, Math.round(Number(a.cooldown?.frequentMinCount ?? m.cooldown?.frequentMinCount ?? 2))),
          frequentMultiplier: Math.max(0.01, Number(a.cooldown?.frequentMultiplier ?? m.cooldown?.frequentMultiplier ?? 0.4)),
          absentWindow: Math.max(1, Math.min(12, Math.round(Number(a.cooldown?.absentWindow ?? m.cooldown?.absentWindow ?? 5)))),
          absentMultiplier: Math.max(1, Number(a.cooldown?.absentMultiplier ?? m.cooldown?.absentMultiplier ?? 1.3)),
        },
        incompatible:
          a.incompatible && typeof a.incompatible === 'object' && !Array.isArray(a.incompatible)
            ? a.incompatible
            : m.incompatible && typeof m.incompatible === 'object' && !Array.isArray(m.incompatible)
              ? m.incompatible
              : {},
        tagGroups: Array.isArray(a.tagGroups) && a.tagGroups.length ? a.tagGroups : Array.isArray(m.tagGroups) ? m.tagGroups : [],
        poolMin: Math.max(10, Math.round(Number(a.poolMin ?? 60))),
        refillBatch: Math.max(1, Math.min(6, Math.round(Number(a.refillBatch ?? 3)))),
        shortlistSize: Math.max(4, Math.min(20, Math.round(Number(a.shortlistSize ?? 10)))),
        modifierGravityMin: Math.max(0, Math.min(100, Math.round(Number(a.modifierGravityMin ?? m.modifierGravityMin ?? 40)))),
      };
    })(),
    mysteryGraph: {
      minNodes: Math.max(3, Math.round(Number(p.mystery?.graph?.minNodes ?? 4))),
      maxNodes: Math.max(
        Math.max(3, Math.round(Number(p.mystery?.graph?.minNodes ?? 4))),
        Math.round(Number(p.mystery?.graph?.maxNodes ?? 5)),
      ),
      sideRevealChance: Math.max(0, Math.min(1, Number(p.mystery?.graph?.sideRevealChance ?? 0.5))),
      shapes: parseMysteryShapes(p.mystery?.graph?.shapes),
      judgeAttempts: Math.max(1, Math.min(8, Math.round(Number(p.mystery?.graph?.judgeAttempts ?? 3)))),
      generateTries: Math.max(1, Math.min(12, Math.round(Number(p.mystery?.graph?.generateTries ?? 6)))),
      presentationTries: Math.max(1, Math.min(6, Math.round(Number(p.mystery?.graph?.presentationTries ?? 3)))),
    },
    mysteryEntities: (() => {
      const minCatalog = Math.max(4, Math.round(Number(p.mystery?.entities?.minCatalog ?? 32)));
      const pickMin = Math.max(1, Math.min(2, Math.round(Number(p.mystery?.entities?.pickMin ?? 1))));
      return {
        minCatalog,
        maxCatalog: Math.max(minCatalog, Math.round(Number(p.mystery?.entities?.maxCatalog ?? 48))),
        pickMin,
        pickMax: Math.max(pickMin, Math.min(2, Math.round(Number(p.mystery?.entities?.pickMax ?? 2)))),
        twoChance: Math.max(0, Math.min(1, Number(p.mystery?.entities?.twoChance ?? 0.12))),
        inventChance: Math.max(0, Math.min(1, Number(p.mystery?.entities?.inventChance ?? 0.15))),
      };
    })(),
    seedRoles: Array.isArray(p.seedRoles)
      ? p.seedRoles
          .map((r) => ({
            role: String(r?.role || '').trim(),
            about: String(r?.about || '').trim(),
          }))
          .filter((r) => r.role)
      : [],
    orders: {
      defaultChance: Math.max(0, Math.min(1, Number(p.orders?.defaultChance ?? 0.2))),
    },
    acts: {
      maxEscalations: Math.max(1, Math.round(Number(p.acts?.maxEscalations ?? 3))),
      worsenMin: Number(p.acts?.worsenMin ?? 1.1),
      worsenMax: Number(p.acts?.worsenMax ?? 1.1),
      dampMin: Number(p.acts?.dampMin ?? 0.9),
      dampMax: Number(p.acts?.dampMax ?? 0.9),
    },
    suspense: {
      gravityFloor: Math.max(5, Math.min(40, Math.round(Number(p.suspense?.gravityFloor ?? 20)))),
      openingGravityMin: Math.max(5, Math.min(40, Math.round(Number(p.suspense?.openingGravityMin ?? 20)))),
      openingGravityMax: Math.max(20, Math.min(60, Math.round(Number(p.suspense?.openingGravityMax ?? 40)))),
      depth4Chance: Math.max(0, Math.min(0.2, Number(p.suspense?.depth4Chance ?? 0.03))),
      depth4MinGravity: Math.max(50, Math.min(100, Math.round(Number(p.suspense?.depth4MinGravity ?? 75)))),
      legacyMinGravity: Math.max(0, Math.min(100, Math.round(Number(p.suspense?.legacyMinGravity ?? 25)))),
      judgeAttempts: Math.max(1, Math.min(6, Math.round(Number(p.suspense?.judgeAttempts ?? 3)))),
    },
  };
}

function normalizeStatIds(raw, config = null) {
  const allowed = new Set((config?.stats || []).map((s) => s.id));
  const ids = Array.isArray(raw) ? raw.map(String) : [];
  const uniq = [...new Set(ids)];
  return allowed.size ? uniq.filter((id) => allowed.has(id)) : uniq;
}

function closedPlotIds(domain) {
  return new Set((domain?.closedPlotlines || []).map((p) => p?.id).filter(Boolean));
}

/** Форма карточки на месте: тот же объект, без второй копии. */
function applyPlotShape(p, config = null) {
  p.id = p.id || newId('plot');
  p.title = clipText(p.title || 'Сюжет', PLOT_TITLE_MAX);
  p.synopsis = clipText(p.synopsis ?? p.summary ?? '', PLOT_SUMMARY_MAX);
  p.closeWhen = clipText(p.closeWhen, PLOT_HOOK_MAX);
  p.mootWhen = clipText(p.mootWhen, PLOT_HOOK_MAX);
  p.kind = PLOT_KINDS.includes(p.kind) ? p.kind : 'story';
  p.tags = Array.isArray(p.tags) ? p.tags : [];
  p.relatedStats = normalizeStatIds(p.relatedStats, config);
  p.chronicleIds = Array.isArray(p.chronicleIds) ? p.chronicleIds.map(String) : [];
  p.factIds = Array.isArray(p.factIds) ? p.factIds.map(String) : [];
  p.relatedProcessIds = Array.isArray(p.relatedProcessIds) ? p.relatedProcessIds.map(String) : [];
  p.relatedPlotlineIds = Array.isArray(p.relatedPlotlineIds) ? p.relatedPlotlineIds.map(String) : [];
  p.importance = clamp100(p.importance, 40);
  p.maxAgeMonths = Math.max(1, Math.min(36, Math.round(Number(p.maxAgeMonths) || 6)));
  p.ageMonths = Math.max(0, Math.round(Number(p.ageMonths) || 0));
  p.temperature = clamp100(p.temperature, 30);
  p.mirrorOf = p.mirrorOf ? String(p.mirrorOf) : null;
  p.confluxId = p.confluxId ? String(p.confluxId) : null;
  p.partnerGone = Boolean(p.partnerGone);
  p.hostDomainId = p.hostDomainId ? String(p.hostDomainId) : null;
  p.concernsDomainIds = Array.isArray(p.concernsDomainIds)
    ? [...new Set(p.concernsDomainIds.map(String))]
    : [];
  p.shared = Boolean(p.shared);
  p.isMainConflux = Boolean(p.isMainConflux);
  p.sharedReason = p.sharedReason ? String(p.sharedReason) : null;
  p.plotAwareness = normalizePlotAwarenessMap(p);
  p.status = 'open';
  p.createdTick = p.createdTick == null ? null : Number(p.createdTick);
  p.lastBeatTick = p.lastBeatTick == null ? null : Number(p.lastBeatTick);
  p.beatCount = Math.max(0, Math.round(Number(p.beatCount) || 0));
  Object.assign(p, storyActState(p));
  if (p.kind === 'order') Object.assign(p, orderCadence(p, config));
  return p;
}

export function normalizePlotlines(domain, config = null) {
  if (!domain || typeof domain !== 'object') return domain;
  if (!Array.isArray(domain.plotlines)) domain.plotlines = [];
  const closedIds = closedPlotIds(domain);
  const seen = new Set();
  const next = [];
  for (const p of domain.plotlines) {
    if (!p || typeof p !== 'object' || p.status === 'closed') continue;
    if (p.id && closedIds.has(p.id)) continue;
    if (p.id && seen.has(p.id)) continue;
    applyPlotShape(p, config);
    if (p.id) seen.add(p.id);
    next.push(p);
  }
  domain.plotlines = next;
  return domain;
}

export function createPlotline({
  title,
  synopsis = '',
  summary = '', // legacy-алиас, уйдёт вместе со старым режиссёром
  closeWhen = '',
  mootWhen = '',
  kind = 'story',
  tags = [],
  relatedStats = [],
  importance = 40,
  maxAgeMonths = 6,
  temperature = 30,
  tick = null,
  relatedProcessIds = [],
  relatedPlotlineIds = [],
  mirrorOf = null,
  confluxId = null,
  hostDomainId = null,
  concernsDomainIds = [],
  shared = false,
  isMainConflux = false,
  modifierId = null,
  orderText = '',
  fireChance = null,
  scheduleEveryMonths = null,
  nextDueTick = null,
  fireOn = null,
  lastFiredConfluxId = null,
  durationMonths = null,
  expiresTick = null,
  storyType = null,
  act = 1,
  urgency = null,
  gravity = null,
  urgency0 = null,
  gravity0 = null,
  escalationLevel = 0,
  maxEscalations = 3,
  truth = '',
  truthGraph = null,
  observedFacts = [],
  resolutionFacts = [],
  ending = null,
  asksSequel = false,
  annotationId = null,
  ifSolved = '',
  ifUnsolved = '',
  ifPrevented = '',
  ifNotPrevented = '',
  depth = null,
  hiddenPremises = [],
  discoveryLadder = null,
  closureGate = '',
  closureUnlocked = null,
  tonePrimary = null,
  toneSecondary = null,
  source = null,
  situation = null,
  dynamic = null,
  legacyAxes = [],
  unattendedBeats = 0,
  config = null,
}) {
  const resolvedKind = PLOT_KINDS.includes(kind) ? kind : 'story';
  const plot = {
    id: newId('plot'),
    title: clipText(title || (resolvedKind === 'order' ? 'Порядок' : 'Сюжет'), PLOT_TITLE_MAX),
    synopsis: clipText(synopsis || summary, PLOT_SUMMARY_MAX),
    closeWhen: clipText(closeWhen, PLOT_HOOK_MAX),
    mootWhen: clipText(mootWhen, PLOT_HOOK_MAX),
    kind: resolvedKind,
    tags: Array.isArray(tags) ? tags : [],
    relatedStats: normalizeStatIds(relatedStats, config),
    chronicleIds: [],
    factIds: [],
    relatedProcessIds: (relatedProcessIds || []).map(String),
    relatedPlotlineIds: (relatedPlotlineIds || []).map(String),
    importance: clamp100(importance, resolvedKind === 'order' ? 20 : 40),
    maxAgeMonths: Math.max(1, Math.min(36, Math.round(Number(maxAgeMonths) || 6))),
    ageMonths: 0,
    temperature: clamp100(temperature, 30),
    mirrorOf: mirrorOf ? String(mirrorOf) : null,
    confluxId: confluxId ? String(confluxId) : null,
    hostDomainId: hostDomainId ? String(hostDomainId) : null,
    concernsDomainIds: Array.isArray(concernsDomainIds)
      ? [...new Set(concernsDomainIds.map(String))]
      : [],
    shared: Boolean(shared),
    isMainConflux: Boolean(isMainConflux),
    sharedReason: null,
    plotAwareness: {},
    partnerGone: false,
    status: 'open',
    createdTick: tick,
    lastBeatTick: null,
    beatCount: 0,
    ...(resolvedKind === 'order'
      ? orderCadence(
          { modifierId, orderText, fireChance, scheduleEveryMonths, nextDueTick, fireOn, lastFiredConfluxId, durationMonths, expiresTick },
          config,
        )
      : {}),
    ...storyActState({
      storyType,
      act,
      urgency,
      gravity,
      urgency0,
      gravity0,
      escalationLevel,
      maxEscalations,
      truth,
      truthGraph,
      observedFacts,
      resolutionFacts,
      ending,
      asksSequel,
      annotationId,
      ifSolved,
      ifUnsolved,
      ifPrevented,
      ifNotPrevented,
      depth,
      hiddenPremises,
      discoveryLadder,
      closureGate,
      closureUnlocked,
      tonePrimary,
      toneSecondary,
      source,
      situation,
      dynamic,
      legacyAxes,
      unattendedBeats,
      kind: resolvedKind,
      isMainConflux,
      shared,
      confluxId,
    }),
  };
  return refreshPlotAwareness(plot);
}

/** Нить-заглушка для дела: у каждого процесса есть своя нить. */
export function createErrandPlotline(process, { tick = null, config = null } = {}) {
  const months = Math.max(1, Math.round(Number(process?.expectedMonths) || 1));
  return createPlotline({
    title: clipText(process?.summary || 'Городское дело', PLOT_TITLE_MAX),
    synopsis: clipText(process?.detail || process?.summary || '', PLOT_SUMMARY_MAX),
    closeWhen: 'Дело доведено до конца или свёрнуто.',
    kind: 'errand',
    relatedStats: process?.linkedStats || [],
    importance: 25,
    maxAgeMonths: months + 2,
    temperature: 25,
    tick,
    relatedProcessIds: process?.id ? [process.id] : [],
    config,
  });
}

export function plotlineAge(plotline) {
  return Math.max(0, Math.round(Number(plotline?.ageMonths) || 0));
}

export function isOverdue(plotline) {
  return plotlineAge(plotline) >= Math.max(1, Number(plotline?.maxAgeMonths) || 6);
}

/**
 * Принудительно гаснет только забытая нить: срок вышел, связанных дел нет,
 * упоминаний нет (температура остыла). Иначе срок просто ждёт.
 */
export function plotCanFade(domain, plot, cfg) {
  if (isOrderPlot(plot)) return false;
  if (isThreeActPlot(plot)) return false;
  if (!isOverdue(plot)) return false;
  if (plotHasActiveProcess(domain, plot)) return false;
  const floor = Number(cfg?.temperature?.fadeBelow ?? 18);
  return Number(plot.temperature || 0) <= floor;
}

export function countOpen(domain) {
  const list = domain?.plotlines || [];
  const stories = list.filter((p) => p.kind === 'story').length;
  const errands = list.filter((p) => p.kind === 'errand').length;
  const orders = list.filter((p) => p.kind === 'order').length;
  return {
    // Доска историй: указы слот не занимают.
    total: stories + errands,
    stories,
    errands,
    orders,
    all: list.length,
  };
}

export function boardHasRoom(domain, cfg) {
  const { total, errands } = countOpen(domain);
  return {
    story: total < cfg.board.maxOpen,
    errand: total < cfg.board.maxOpen && errands < cfg.board.maxErrands,
  };
}

export function findPlotline(domain, plotlineId) {
  return (domain?.plotlines || []).find((p) => p.id === plotlineId) || null;
}

export function findClosedPlotline(domain, plotlineId) {
  const id = String(plotlineId || '');
  if (!id) return null;
  return (domain?.closedPlotlines || []).find((p) => p.id === id) || null;
}

export function plotsForProcess(domain, processId) {
  const id = String(processId || '');
  if (!id) return [];
  return (domain?.plotlines || []).filter((p) => (p.relatedProcessIds || []).includes(id));
}

/** Поручение ещё идёт — нить рано убирать с доски, иначе дело получит пустую карточку. */
export function plotHasActiveProcess(domain, plot) {
  const ids = new Set((plot?.relatedProcessIds || []).map(String));
  if (!ids.size) return false;
  return (domain?.state?.pendingActions || []).some(
    (a) => ids.has(String(a.id)) && (!a.status || a.status === 'active'),
  );
}

function processEngagement(action) {
  const raw = String(action?.plotEngagement || '').toUpperCase();
  if (raw === 'DIRECT' || raw === 'RELEVANT' || raw === 'UNRELATED') return raw;
  if (action?.plotAligned === true) return 'DIRECT';
  if (action?.plotAligned === false) return 'RELEVANT';
  return 'UNRELATED';
}

/** DIRECT/RELEVANT дело глушит автотик; UNRELATED — нет. */
export function plotHasAttendingProcess(domain, plot) {
  const ids = new Set((plot?.relatedProcessIds || []).map(String));
  if (!ids.size) return false;
  return (domain?.state?.pendingActions || []).some((a) => {
    if (!ids.has(String(a.id)) || (a.status && a.status !== 'active')) return false;
    const eng = processEngagement(a);
    return eng === 'DIRECT' || eng === 'RELEVANT';
  });
}

function archiveClosedPlot(plot, { tick = null, reason = '', sequelHook = '' } = {}) {
  const closeReason = reason || plot.closeReason || '';
  const hook = clipText(sequelHook || plot.sequelHook, PLOT_HOOK_MAX);
  return {
    id: plot.id,
    title: plot.title,
    synopsis: plot.synopsis || '',
    closeWhen: plot.closeWhen || '',
    mootWhen: plot.mootWhen || '',
    kind: plot.kind || 'story',
    tags: Array.isArray(plot.tags) ? plot.tags : [],
    relatedStats: Array.isArray(plot.relatedStats) ? [...plot.relatedStats] : [],
    chronicleIds: Array.isArray(plot.chronicleIds) ? [...plot.chronicleIds] : [],
    factIds: Array.isArray(plot.factIds) ? [...plot.factIds] : [],
    relatedProcessIds: Array.isArray(plot.relatedProcessIds) ? [...plot.relatedProcessIds] : [],
    relatedPlotlineIds: Array.isArray(plot.relatedPlotlineIds) ? [...plot.relatedPlotlineIds] : [],
    importance: plot.importance,
    maxAgeMonths: plot.maxAgeMonths,
    ageMonths: plot.ageMonths,
    temperature: plot.temperature,
    mirrorOf: plot.mirrorOf || null,
    confluxId: plot.confluxId || null,
    partnerGone: Boolean(plot.partnerGone),
    hostDomainId: plot.hostDomainId || null,
    concernsDomainIds: Array.isArray(plot.concernsDomainIds) ? [...plot.concernsDomainIds] : [],
    shared: Boolean(plot.shared),
    isMainConflux: Boolean(plot.isMainConflux),
    sharedReason: plot.sharedReason || null,
    plotAwareness: normalizePlotAwarenessMap(plot),
    ...storyActState(plot),
    ...(plot.kind === 'order'
      ? {
          modifierId: plot.modifierId || null,
          fireChance: plot.fireChance,
          scheduleEveryMonths: plot.scheduleEveryMonths ?? null,
          nextDueTick: plot.nextDueTick ?? null,
          fireOn: plot.fireOn || null,
          lastFiredConfluxId: plot.lastFiredConfluxId || null,
          durationMonths: plot.durationMonths ?? null,
          expiresTick: plot.expiresTick ?? null,
          orderText: plot.orderText || '',
        }
      : {}),
    status: 'closed',
    createdTick: plot.createdTick ?? null,
    lastBeatTick: plot.lastBeatTick ?? null,
    beatCount: plot.beatCount || 0,
    closedTick: tick,
    reason: closeReason,
    closeReason,
    sequelHook: hook,
  };
}

/** Вернуть закрытую нить на доску: поручение ещё живо, развязку забывать нельзя. */
export function reopenClosedPlotline(domain, closedOrId) {
  const closed =
    typeof closedOrId === 'string' ? findClosedPlotline(domain, closedOrId) : closedOrId;
  if (!closed?.id) return null;
  if (findPlotline(domain, closed.id)) {
    domain.closedPlotlines = (domain.closedPlotlines || []).filter((p) => p.id !== closed.id);
    return findPlotline(domain, closed.id);
  }
  const plot = {
    id: closed.id,
    title: clipText(closed.title || 'Сюжет', PLOT_TITLE_MAX),
    synopsis: clipText(
      closed.synopsis || (closed.reason ? `Уже установлено: ${closed.reason}` : ''),
      PLOT_SUMMARY_MAX,
    ),
    closeWhen: clipText(closed.closeWhen, PLOT_HOOK_MAX),
    mootWhen: clipText(closed.mootWhen, PLOT_HOOK_MAX),
    kind: PLOT_KINDS.includes(closed.kind) ? closed.kind : 'story',
    tags: Array.isArray(closed.tags) ? closed.tags : [],
    relatedStats: Array.isArray(closed.relatedStats) ? [...closed.relatedStats] : [],
    chronicleIds: Array.isArray(closed.chronicleIds) ? closed.chronicleIds.map(String) : [],
    factIds: Array.isArray(closed.factIds) ? closed.factIds.map(String) : [],
    relatedProcessIds: Array.isArray(closed.relatedProcessIds)
      ? closed.relatedProcessIds.map(String)
      : [],
    relatedPlotlineIds: Array.isArray(closed.relatedPlotlineIds)
      ? closed.relatedPlotlineIds.map(String)
      : [],
    importance: clamp100(closed.importance, 40),
    maxAgeMonths: Math.max(1, Math.min(36, Math.round(Number(closed.maxAgeMonths) || 6))),
    ageMonths: Math.max(0, Math.round(Number(closed.ageMonths) || 0)),
    temperature: clamp100(closed.temperature, 30),
    mirrorOf: closed.mirrorOf ? String(closed.mirrorOf) : null,
    confluxId: closed.confluxId ? String(closed.confluxId) : null,
    partnerGone: Boolean(closed.partnerGone),
    hostDomainId: closed.hostDomainId ? String(closed.hostDomainId) : null,
    concernsDomainIds: Array.isArray(closed.concernsDomainIds)
      ? closed.concernsDomainIds.map(String)
      : [],
    shared: Boolean(closed.shared),
    isMainConflux: Boolean(closed.isMainConflux),
    sharedReason: closed.sharedReason || null,
    plotAwareness: normalizePlotAwarenessMap(closed),
    status: 'open',
    createdTick: closed.createdTick == null ? null : Number(closed.createdTick),
    lastBeatTick: closed.lastBeatTick == null ? null : Number(closed.lastBeatTick),
    beatCount: Math.max(0, Math.round(Number(closed.beatCount) || 0)),
    ...storyActState(closed),
    ...(closed.kind === 'order' ? orderCadence(closed) : {}),
  };
  domain.plotlines = domain.plotlines || [];
  domain.plotlines.push(plot);
  domain.closedPlotlines = (domain.closedPlotlines || []).filter((p) => p.id !== closed.id);
  return plot;
}

/** Внимание игрока → температура. Числом, не формулировкой. */
export function warmPlotlines(domain, plotlineIds, cfg) {
  normalizePlotlines(domain);
  const amount = cfg?.temperature?.perTouch ?? 12;
  const touched = [];
  for (const id of [...new Set((plotlineIds || []).map(String))]) {
    const p = findPlotline(domain, id);
    if (!p) continue;
    const before = p.temperature;
    p.temperature = clamp100(before + amount);
    touched.push({ id, from: before, to: p.temperature });
  }
  return touched;
}

/** Месячные часы: возраст растёт, интерес остывает. */
export function advancePlotClocks(domain, cfg) {
  normalizePlotlines(domain);
  const decay = cfg?.temperature?.decayPerTick ?? 8;
  for (const p of domain.plotlines) {
    if (p.kind === 'order') continue;
    p.ageMonths += 1;
    if (!isThreeActPlot(p)) p.temperature = clamp100(p.temperature - decay);
  }
  return domain.plotlines;
}

export function attachChronicleToPlotlines(domain, factId, plotlineIds) {
  attachIdsToPlotlines(domain, 'chronicleIds', factId, plotlineIds);
}

export function attachFactToPlotlines(domain, factId, plotlineIds) {
  attachIdsToPlotlines(domain, 'factIds', factId, plotlineIds);
}

function attachIdsToPlotlines(domain, field, factId, plotlineIds) {
  if (!factId) return;
  for (const id of [...new Set((plotlineIds || []).map(String))]) {
    const p = findPlotline(domain, id);
    if (!p) continue;
    if (!Array.isArray(p[field])) p[field] = [];
    const sid = String(factId);
    if (!p[field].includes(sid)) p[field].push(sid);
  }
}

export function closePlotline(domain, plotlineId, { tick = null, reason = '', sequelHook = '' } = {}) {
  const list = domain?.plotlines || [];
  const idx = list.findIndex((p) => p.id === plotlineId);
  if (idx < 0) return null;
  const [plot] = list.splice(idx, 1);
  plot.status = 'closed';
  plot.closedTick = tick;
  plot.closeReason = reason || '';
  plot.sequelHook = clipText(sequelHook, PLOT_HOOK_MAX);
  domain.closedPlotlines = Array.isArray(domain.closedPlotlines) ? domain.closedPlotlines : [];
  domain.closedPlotlines.push(
    archiveClosedPlot(plot, { tick, reason: plot.closeReason, sequelHook: plot.sequelHook }),
  );
  if (domain.closedPlotlines.length > 40) {
    domain.closedPlotlines = domain.closedPlotlines.slice(-40);
  }
  return plot;
}

function pickWeightedTag(tags, rng) {
  const weights = tags.map((t) => {
    const w = Number(t?.weight);
    return Number.isFinite(w) && w > 0 ? w : 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < tags.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return tags[i];
  }
  return tags[tags.length - 1];
}

/** Веса source по типу тайны: 0 исключает тег, иначе подменяет weight. */
export function weightedArchitectSourceGroup(group, typeId, sourceByType = {}) {
  if (!group?.tags?.length) return group;
  const weights = sourceByType?.[typeId];
  if (!weights || typeof weights !== 'object') return group;
  const tags = (group.tags || [])
    .map((t) => {
      const raw = weights[t.id] ?? weights[t.name];
      if (raw == null) return t;
      const w = Number(raw);
      if (!Number.isFinite(w) || w <= 0) return null;
      return { ...t, weight: w };
    })
    .filter(Boolean);
  return tags.length ? { ...group, tags } : group;
}

function tagFromGroup(group, rng) {
  if (!group?.tags?.length) return null;
  const tag = pickWeightedTag(group.tags, rng);
  if (!tag) return null;
  const people = Math.round(Number(tag.people));
  const inventKind = String(tag.kind || '').trim();
  const about = String(tag.about || '').trim();
  return {
    groupId: group.id,
    groupName: group.name || group.id,
    tagId: tag.id,
    tagName: tag.name,
    ...(inventKind ? { kind: inventKind } : {}),
    ...(about ? { about } : {}),
    ...(people === 1 || people === 2 ? { people } : {}),
  };
}

/** Жребий завязки: по одному тегу из каждой группы. */
export function pickPlotTags(cfg, rng = Math.random) {
  const groups = cfg?.tagGroups || [];
  return groups.map((g) => tagFromGroup(g, rng)).filter(Boolean);
}

const MYSTERY_GROUP_IDS = ['association', 'type'];

/** Жребий тайны: окраска (ассоциация) и жёсткий тип произошедшего. */
export function pickMysteryPlotTags(cfg, rng = Math.random) {
  const mystery = cfg?.mysteryTagGroups || [];
  const byId = (id) => (mystery || []).find((g) => g.id === id);
  return MYSTERY_GROUP_IDS.map((id) => tagFromGroup(byId(id), rng)).filter(Boolean);
}

export function mysteryTypeTag(tags = []) {
  return (tags || []).find((t) => t.groupId === 'type') || null;
}

export function mysteryAssociationTag(tags = []) {
  return (tags || []).find((t) => t.groupId === 'association') || null;
}

function pickTwoTones(group, rng) {
  const first = tagFromGroup(group, rng);
  if (!first) return [];
  const rest = (group.tags || []).filter((t) => t.id !== first.tagId);
  const secondSrc = rest.length ? { ...group, tags: rest } : group;
  const second = tagFromGroup(secondSrc, rng);
  return [
    { ...first, groupId: 'tonePrimary', groupName: 'Тон (основной)' },
    second ? { ...second, groupId: 'toneSecondary', groupName: 'Тон (второй)' } : null,
  ].filter(Boolean);
}

export function gravityBand(gravity) {
  const n = Number(gravity);
  if (!Number.isFinite(n)) return 'локальные';
  if (n <= 25) return 'локальные';
  if (n <= 50) return 'заметные городские';
  if (n <= 75) return 'крупные системные';
  return 'судьбоносные';
}

/** Исторический вес mystery-брифа. Три якоря: 0 / 50 / 100, между ними интерполяция. */
export function annotationGravityBand(gravity) {
  const n = Number(gravity);
  if (!Number.isFinite(n)) return 'эпизод';
  if (n <= 20) return 'эпизод';
  if (n < 45) return 'между эпизодом и вехой';
  if (n <= 55) return 'городская веха';
  if (n < 90) return 'между вехой и судьбоносным';
  return 'судьбоносное';
}

/**
 * Жребий Phase 1: тип+ассоциация тайны, все оси architect, gravity числом.
 */
export function pickMysteryArchitectSeed(cfg, rng = Math.random) {
  const tags = [...pickMysteryPlotTags(cfg, rng)];
  const typeId = mysteryTypeTag(tags)?.tagId;
  const groups = cfg?.mysteryArchitect?.tagGroups || [];
  const toneGroup = groups.find((g) => g.id === 'tone');
  const sourceGroup = groups.find((g) => g.id === 'source');
  if (sourceGroup) {
    const weighted = weightedArchitectSourceGroup(
      sourceGroup,
      typeId,
      cfg?.mysteryArchitect?.sourceByType,
    );
    const tag = tagFromGroup(weighted, rng);
    if (tag) tags.push(tag);
  }
  for (const group of groups) {
    if (group.id === 'tone' || group.id === 'source') continue;
    const tag = tagFromGroup(group, rng);
    if (tag) tags.push(tag);
  }
  if (toneGroup) tags.push(...pickTwoTones(toneGroup, rng));
  const gmin = Number(cfg?.mysteryArchitect?.gravityMin ?? 15);
  const gmax = Number(cfg?.mysteryArchitect?.gravityMax ?? 90);
  const lo = Math.min(gmin, gmax);
  const hi = Math.max(gmin, gmax);
  const gravity = Math.max(0, Math.min(100, Math.round(lo + rng() * (hi - lo))));
  return { tags, gravity };
}

const ANNOTATION_AXIS_ORDER = [
  'truthArena',
  'truthNature',
  'worldRelation',
  'manifestation',
];

const ANNOTATION_HARD_AXES = new Set([
  'truthArena',
  'truthNature',
  'worldRelation',
  'manifestation',
]);

const ANNOTATION_SKIP_GROUPS = new Set(['mysteryQuestion', 'truthDomain', 'epistemicMask', 'situation']);
const ANNOTATION_FILTER_SKIP = new Set(['tone', 'tonePrimary', 'toneSecondary', 'association']);

function annotationAxisId(groupId) {
  if (groupId === 'tonePrimary' || groupId === 'toneSecondary') return 'tone';
  return groupId;
}

function annotationBanList(incompatible, axis, tagId, otherAxis) {
  const raw = incompatible?.[axis]?.[tagId]?.[otherAxis];
  return Array.isArray(raw) ? raw.map(String) : [];
}

export function annotationPairCompatible(incompatible, axisA, tagA, axisB, tagB) {
  if (!axisA || !axisB || !tagA || !tagB || axisA === axisB) return true;
  if (annotationBanList(incompatible, axisA, tagA, axisB).includes(String(tagB))) return false;
  if (annotationBanList(incompatible, axisB, tagB, axisA).includes(String(tagA))) return false;
  return true;
}

export function annotationTagCompatibleWithChosen(incompatible, chosen, groupId, tagId) {
  for (const c of chosen || []) {
    const axis = annotationAxisId(c.groupId);
    if (!axis || ANNOTATION_FILTER_SKIP.has(c.groupId) || ANNOTATION_SKIP_GROUPS.has(axis)) continue;
    if (!annotationPairCompatible(incompatible, axis, c.tagId, groupId, tagId)) return false;
  }
  return true;
}

export function annotationSeedCompatible(tags, incompatible) {
  const list = (tags || []).filter(
    (t) => t?.tagId && !ANNOTATION_FILTER_SKIP.has(t.groupId) && !ANNOTATION_SKIP_GROUPS.has(t.groupId),
  );
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (
        !annotationPairCompatible(
          incompatible,
          annotationAxisId(a.groupId),
          a.tagId,
          annotationAxisId(b.groupId),
          b.tagId,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

export function annotationRecentArenaId(entry) {
  if (!entry) return null;
  const tagged = (entry.seed?.tags || entry.tags || []).find(
    (x) => x.groupId === 'truthArena' || x.groupId === 'threatArena' || x.groupId === 'arena',
  );
  const raw = entry.arena || entry.truthArena || entry.threatArena || tagged?.tagName || tagged?.tagId;
  return raw ? String(raw).trim().toLowerCase() : null;
}

export function annotationArenaWeights(cfg, recent = []) {
  const ann = cfg?.mysteryAnnotation || cfg || {};
  const group = (ann.tagGroups || []).find((g) => g.id === 'truthArena');
  const cooldown = ann.cooldown || {};
  const ids = (recent || []).map(annotationRecentArenaId).filter(Boolean);
  const prev = ids[ids.length - 1];
  const freqWin = ids.slice(-(cooldown.frequentWindow || 4));
  const absWin = ids.slice(-(cooldown.absentWindow || 5));
  const frequentMin = cooldown.frequentMinCount || 2;
  const out = {};
  for (const t of group?.tags || []) {
    let w = Number(t.weight);
    if (!Number.isFinite(w) || w <= 0) w = 1;
    if (ids.length) {
      if (t.id === prev) w *= cooldown.previousMultiplier ?? 0.2;
      else if (freqWin.filter((id) => id === t.id).length >= frequentMin) {
        w *= cooldown.frequentMultiplier ?? 0.4;
      }
      if (!absWin.includes(t.id)) w *= cooldown.absentMultiplier ?? 1.3;
    }
    out[t.id] = w;
  }
  return out;
}

function applyArenaCooldown(group, cfg, recent) {
  if (!group?.tags?.length) return group;
  const map = annotationArenaWeights(cfg, recent);
  return {
    ...group,
    tags: group.tags.map((t) => ({ ...t, weight: map[t.id] ?? t.weight })),
  };
}

function tagFromCompatibleGroup(group, rng, chosen, incompatible) {
  if (!group?.tags?.length) return null;
  const ok = group.tags.filter((t) =>
    annotationTagCompatibleWithChosen(incompatible, chosen, group.id, t.id),
  );
  if (!ok.length) return null;
  return tagFromGroup({ ...group, tags: ok }, rng);
}

/**
 * Жребий V5.1: causal arena + gravity-scaled outcomes.
 * situation, scale, association и второй тон не бросаем.
 * OLD_EVENT / EXTERNAL_INTRUSION нет в посеве (это LEGACY / CONTACT).
 * omitTruthNature — ветка B эксперимента V5.2: форму причины модель выбирает сама.
 * recent/cooldown — доска города, не лабораторный семпл.
 */
export function pickMysteryAnnotationSeed(
  cfg,
  rng = Math.random,
  { recent = [], omitTruthNature = false } = {},
) {
  const ann = cfg?.mysteryAnnotation || {};
  const groups = ann.tagGroups || [];
  const byId = (id) => groups.find((g) => g.id === id);
  const incompatible = ann.incompatible || {};
  const tags = [];

  const arenaGroup = byId('truthArena');
  if (arenaGroup) {
    const weighted = applyArenaCooldown(arenaGroup, ann, recent);
    const arena = tagFromGroup(weighted, rng);
    if (arena) tags.push(arena);
  }

  for (const id of ANNOTATION_AXIS_ORDER) {
    if (id === 'truthArena') continue;
    if (omitTruthNature && id === 'truthNature') continue;
    const tag = tagFromCompatibleGroup(byId(id), rng, tags, incompatible);
    if (tag) tags.push(tag);
  }

  const toneGroup = byId('tone');
  if (toneGroup) {
    const first = tagFromGroup(toneGroup, rng);
    if (first) {
      tags.push({ ...first, groupId: 'tonePrimary', groupName: 'Тон' });
      const chance = Number(ann.secondaryToneChance ?? 0);
      if (chance > 0 && rng() < chance) {
        const rest = (toneGroup.tags || []).filter((t) => t.id !== first.tagId);
        const second = tagFromGroup(rest.length ? { ...toneGroup, tags: rest } : toneGroup, rng);
        if (second) {
          tags.push({ ...second, groupId: 'toneSecondary', groupName: 'Тон (второй)' });
        }
      }
    }
  }

  const gmin = Number(ann.gravityMin ?? 0);
  const gmax = Number(ann.gravityMax ?? 100);
  const lo = Math.min(gmin, gmax);
  const hi = Math.max(gmin, gmax);
  const gravity = Math.max(0, Math.min(100, Math.round(lo + rng() * (hi - lo))));
  return { tags, gravity, omitTruthNature: Boolean(omitTruthNature) };
}

export function pickSuspenseAnnotationSeed(cfg, rng = Math.random, { recent = [] } = {}) {
  return pickMysteryAnnotationSeed(
    { mysteryAnnotation: cfg?.suspenseAnnotation || cfg?.mysteryAnnotation },
    rng,
    { recent, omitTruthNature: true },
  );
}

const HUMAN_WRONGDOING_TYPES = new Set([
  'crime',
  'conspiracy',
  'betrayal',
  'sabotage',
  'kidnapping',
  'blackmail',
  'impostor',
]);

export function formatMysteryArchitectAxesForPrompt(seed = {}) {
  const tags = seed.tags || [];
  const type = mysteryTypeTag(tags);
  const assoc = mysteryAssociationTag(tags);
  const lines = [];
  if (type) {
    const about = type.about ? ` — ${type.about}` : '';
    lines.push(`ТИП ТАЙНЫ (обязателен): ${type.tagName}${about}`);
    lines.push('Это форма произошедшего. Следуй type.about, не растягивай тип метафорой.');
  }
  lines.push(
    'ПРИОРИТЕТ ТЕГОВ: тип > источник > ситуация > gravity/scale > canonRelation > dynamic > тон > association.',
  );
  lines.push('Нижний тег ослабь, если он ломает тип или причинность. Тон и association — мягкие.');
  if (type?.tagId === 'poisoning') {
    lines.push(
      'POISONING: вред носителя простой и правдоподобный. Оригинальность — provenance, путь, кто задет, зачем скрыли; не токсикология.',
    );
  }
  if (type?.tagId && HUMAN_WRONGDOING_TYPES.has(type.tagId)) {
    lines.push(
      'Тип требует сознательного запрещённого или скрытого человеческого действия. Не подменяй его чистой природной аномалией.',
    );
  }
  if (type?.tagId === 'impostor') {
    lines.push(
      'САМОЗВАНЕЦ: X и mysteryQuestion про ложную роль. Нельзя: самозванец только открыл доступ, а наблюдаемое — вред носителя. Вред из неумения делать чужую работу, не из «продлю ритуал чтобы удержаться».',
    );
  }
  lines.push(
    'БАЗОВЫЙ НАБОР ОСТРОВА: край и ветер, очаг/лампа, общий расходник, власть, жители, отбой непогоды, старый предмет или путь. Не строй сюжет вокруг редкой службы или обряда, без которых Phase 2 не наденет скелет.',
  );
  lines.push(
    'Жители пользуются дешёвым бытовым опытом. Не делай X из того, что они забыли открыть, понюхать или отойти от края. Ошибочная народная причина — только если простая проверка смешана с внешней угрозой или табуирована.',
  );
  if (Number.isFinite(Number(seed.gravity))) {
    lines.push(`GRAVITY: ${seed.gravity} (${gravityBand(seed.gravity)} последствия). Не сложность mystery.`);
  }
  for (const t of tags) {
    if (t.groupId === 'type' || t.groupId === 'association') continue;
    const about = t.about ? ` — ${t.about}` : '';
    lines.push(`${(t.groupName || t.groupId || '').toUpperCase()}: ${t.tagName}${about}`);
  }
  if (assoc) {
    lines.push(`ASSOCIATION (слабое вдохновение): «${assoc.tagName}».`);
    lines.push('Максимум 1–2 элемента как образ или ритм. Не ломай причинность ради буквального воплощения.');
  }
  const rel = tags.find((t) => t.groupId === 'canonRelation');
  if (rel?.tagId === 'native') {
    lines.push(
      'CANON_RELATION NATIVE: воплощай через базовый набор острова, не через новую гражданскую службу или уникальный обряд тревоги.',
    );
  } else if (rel?.tagId === 'contact') {
    lines.push('CANON_RELATION CONTACT: в основе новое явление, вошедшее в жизнь извне status quo города.');
  } else if (rel?.tagId === 'legacy') {
    lines.push('CANON_RELATION LEGACY: скрытая причина связана с прошлым, старым объектом или давним событием.');
  }
  lines.push('Теги должны сформировать историю, не приклеиваться декоративно.');
  return lines.filter(Boolean).join('\n');
}

const ANNOTATION_PROMPT_ORDER = [
  'truthArena',
  'truthNature',
  'worldRelation',
  'manifestation',
  'tonePrimary',
];

const ANNOTATION_RECENT_CLIP = 500;

function clipAnnotationRecent(s, max = ANNOTATION_RECENT_CLIP) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

export function annotationOmitsTruthNature(seed = {}) {
  if (seed?.omitTruthNature) return true;
  const tags = seed?.tags || [];
  if (!tags.length) return false;
  return !tags.some((t) => t.groupId === 'truthNature');
}

export const ANNOTATION_NATURE_OFF_SYSTEM = [
  'В этом посеве оси truthNature нет.',
  'Игнорируй раздел «# 2. truthNature» целиком и пункт self-check про truthNature.',
  'В примере жребия в инструкциях поле truthNature не действует — его нет в текущем seed.',
  'Не выбирай, не называй и не обслуживай тег формы причины.',
  'Сам выбери конкретную причинную форму внутри выбранной truthArena.',
  'Не классифицируй brief тегами HUMAN_ACTION, NATURAL_PROCESS, MISIDENTIFICATION и т.п.',
].join('\n');

export function formatMysteryAnnotationRecentForPrompt(recent = [], window = 5) {
  const items = (recent || [])
    .filter((r) => String(r?.annotation || r?.text || '').trim())
    .slice(-Math.max(1, window));
  if (!items.length) return '';
  const lines = [
    'НЕДАВНИЕ MYSTERY (не копируй субстрат, место Y и тип следа, если текущий seed прямо этого не требует):',
  ];
  items.forEach((r, i) => {
    const title = String(r.title || r.workingTitle || 'без названия').trim();
    const text = clipAnnotationRecent(r.annotation || r.text);
    lines.push(`${i + 1}. «${title}»`);
    lines.push(text);
  });
  lines.push(
    'Новая mystery должна существенно отличаться не только названием. Не повторяй тот же тип инфраструктуры, тот же материал, то же hidden location, ту же causal premise и тот же природный процесс.',
  );
  return lines.join('\n');
}

export function formatMysteryAnnotationAxesForPrompt(seed = {}, { recent = [], recentWindow = 5 } = {}) {
  const tags = seed.tags || [];
  const lines = [];
  const history = formatMysteryAnnotationRecentForPrompt(recent, recentWindow);
  if (history) lines.push(history, '');
  if (Number.isFinite(Number(seed.gravity))) {
    lines.push(
      `GRAVITY: ${seed.gravity} (${annotationGravityBand(seed.gravity)}). Читай первым. Исторический вес развилки для города, не число жертв и не размер X. Якоря: 0 эпизод; 50 веха; 100 «до/после». Между ними интерполяция, без отдельных категорий 30 и 75.`,
    );
    lines.push(
      'Порядок: gravity → масштаб последствий → Y, способная их породить → затем X. Не приклеивай раздутые исходы к маленькой тайне. Последствия не обязаны быть долговременными.',
    );
  }
  lines.push(
    annotationOmitsTruthNature(seed)
      ? 'ЖЁСТКИЕ ОСИ: truthArena, worldRelation, manifestation. Arena — causal substrate Y, не место X, не транспорт, не время и не происхождение. X может быть в другом месте. truthNature не задана: форму причины выбери сам внутри арены.'
      : 'ЖЁСТКИЕ ОСИ: truthArena, truthNature, worldRelation, manifestation. Arena — causal substrate Y, не место X, не транспорт, не время и не происхождение. X может быть в другом месте.',
  );
  lines.push(
    'МЯГКИЕ: тон. Не ломай историю ради него.',
  );
  lines.push(
    'ONE CENTRAL REVEAL: одна скрытая причина. Не дописывай вторую тайну, скрытый город, заговор или новый закон мира, если это не прямое следствие самой разгадки.',
  );
  lines.push(
    'Разгадка должна быть неочевидной разумным людям по конкретной естественной причине. Укажи эту причину в брифе. Не обслуживай тег маски.',
  );
  lines.push(
    'Mystery не должна работать только потому, что наблюдатели игнорируют очевидное. Дешёвый бытовой опыт (открыть, понюхать, отойти от края) они уже умеют, если проверка не табуирована и не смешана с внешней угрозой.',
  );
  lines.push(
    'Исходы обязательны: конкретное хорошее последствие «если разгадана» и плохое «если не разгадана», масштаб по gravity. Обе ветки из Y, не generic morale, не обязаны быть одинаково тяжёлыми и не обязаны быть legacy.',
    'Не делай «если разгадана» по умолчанию новым правилом, протоколом, инспекцией или учреждением. Сначала смотри: территория, ресурс, земля, расселение, торговля, обычай, техника, экология, статус, путь, понимание острова, конфликт или примирение. Правило — только если оно естественно следует из этой истины.',
  );
  const used = new Set();
  for (const id of ANNOTATION_PROMPT_ORDER) {
    const t = tags.find((x) => x.groupId === id);
    if (!t) continue;
    used.add(id);
    const about = t.about ? ` — ${t.about}` : '';
    const hard = ANNOTATION_HARD_AXES.has(id) ? ' (жёсткая)' : '';
    lines.push(`${(t.groupName || t.groupId || '').toUpperCase()}${hard}: ${t.tagName}${about}`);
  }
  for (const t of tags) {
    if (used.has(t.groupId) || ANNOTATION_SKIP_GROUPS.has(t.groupId)) continue;
    if (t.groupId === 'association' || t.groupId === 'scale' || t.groupId === 'toneSecondary' || t.groupId === 'situation') continue;
    const about = t.about ? ` — ${t.about}` : '';
    lines.push(`${(t.groupName || t.groupId || '').toUpperCase()}: ${t.tagName}${about}`);
  }
  const arena = tags.find((t) => t.groupId === 'truthArena');
  if (arena?.tagId === 'human') {
    lines.push('TRUTH_ARENA HUMAN: Y в человеческом поведении, не в веществе и не в конструкции как таковой.');
  } else if (arena?.tagId === 'creature') {
    lines.push(
      'TRUTH_ARENA CREATURE: Y — конкретное существо. Жуки в шерсти: шерсть транспорт, арена CREATURE. Популяция, гриб, экосдвиг — ECOLOGY.',
    );
  } else if (arena?.tagId === 'ecology') {
    lines.push('TRUTH_ARENA ECOLOGY: Y — процесс видов или среды, не одно животное и не вещество само по себе.');
  } else if (arena?.tagId === 'material') {
    lines.push(
      'TRUTH_ARENA MATERIAL: Y в веществе или свойствах материала. Живое в тюке — не эта арена. Цистерна как конструкция — BUILT.',
    );
  } else if (arena?.tagId === 'built') {
    lines.push(
      'TRUTH_ARENA BUILT: Y в устройстве человеческой системы, включая колодец, цистерну, сток. Если живое ломает постройку — CREATURE или ECOLOGY. Если действует содержимое — MATERIAL.',
    );
  } else if (arena?.tagId === 'earth') {
    lines.push(
      'TRUTH_ARENA EARTH: Y в ландшафте или геологии острова. Колодец и сток — BUILT. Не начинай с полости или нижней стороны по умолчанию.',
    );
  } else if (arena?.tagId === 'sky') {
    lines.push('TRUTH_ARENA SKY: Y в атмосфере, погоде или небе. Птица или существо в полёте — CREATURE.');
  }
  const rel = tags.find((t) => t.groupId === 'worldRelation');
  if (rel?.tagId === 'native') {
    lines.push('WORLD_RELATION NATIVE: причина выросла из уже существующей обычной жизни острова.');
  } else if (rel?.tagId === 'contact') {
    lines.push('WORLD_RELATION CONTACT: в привычную жизнь вошло новое явление, которого здесь раньше не было.');
  } else if (rel?.tagId === 'legacy') {
    lines.push('WORLD_RELATION LEGACY: нынешний X — следствие прошлого, старого объекта или забытой структуры.');
  }
  lines.push('Не классифицируй mystery и не строй граф. Просто придумай хорошую тайну.');
  return lines.filter(Boolean).join('\n');
}

export function formatSuspenseAnnotationAxesForPrompt(seed = {}, { recent = [], recentWindow = 5 } = {}) {
  const tags = seed.tags || [];
  const lines = [];
  const history = formatMysteryAnnotationRecentForPrompt(recent, recentWindow).replace(/MYSTERY/g, 'SUSPENSE');
  if (history) lines.push(history, '');
  if (Number.isFinite(Number(seed.gravity))) {
    lines.push(
      `GRAVITY: ${seed.gravity} (${annotationGravityBand(seed.gravity)}). Читай первым. Исторический вес развилки для города, не число жертв. Якоря: 0 эпизод; 50 веха; 100 «до/после».`,
    );
    lines.push(
      'Порядок: gravity → масштаб последствий → угроза, способная их породить → затем нынешняя ситуация. Не приклеивай раздутые исходы к мелкому давлению.',
    );
  }
  lines.push(
    'ЖЁСТКИЕ ОСИ: threatArena, worldRelation, manifestation. Arena — causal substrate центральной угрозы, не место действия, не транспорт и не происхождение.',
  );
  lines.push('МЯГКИЕ: тон. Не ломай историю ради него.');
  lines.push(
    'Это suspense, не mystery: главный вопрос — что случится и удастся ли изменить исход. Если убрать расследование причины, напряжение должно остаться.',
  );
  lines.push(
    'Исходы обязательны: конкретное хорошее «если предотвратить» и плохое «если не предотвратить», масштаб по gravity. Не generic «опасность устранена / стало хуже».',
  );
  const used = new Set();
  const promptTags = tags.map((t) =>
    t.groupId === 'truthArena' ? { ...t, groupId: 'threatArena', groupName: t.groupName || 'Арена угрозы' } : t,
  );
  for (const id of ['threatArena', 'worldRelation', 'manifestation', 'tonePrimary']) {
    const t = promptTags.find((x) => x.groupId === id);
    if (!t) continue;
    used.add(id);
    const about = t.about ? ` — ${t.about}` : '';
    lines.push(`${(t.groupName || t.groupId || '').toUpperCase()} (жёсткая): ${t.tagName}${about}`);
  }
  for (const t of promptTags) {
    if (used.has(t.groupId) || ANNOTATION_SKIP_GROUPS.has(t.groupId)) continue;
    if (t.groupId === 'association' || t.groupId === 'scale' || t.groupId === 'toneSecondary' || t.groupId === 'situation' || t.groupId === 'truthNature') continue;
    const about = t.about ? ` — ${t.about}` : '';
    lines.push(`${(t.groupName || t.groupId || '').toUpperCase()}: ${t.tagName}${about}`);
  }
  const arena = tags.find((t) => t.groupId === 'truthArena' || t.groupId === 'threatArena' || t.groupId === 'arena');
  const arenaId = String(arena?.tagId || arena?.tagName || '').toLowerCase();
  if (arenaId === 'human') {
    lines.push('THREAT_ARENA HUMAN: давление из человеческого поведения, не из вещества и не из конструкции как таковой.');
  } else if (arenaId === 'creature') {
    lines.push('THREAT_ARENA CREATURE: двигатель — конкретное существо. Популяция/гриб/экосдвиг — ECOLOGY.');
  } else if (arenaId === 'ecology') {
    lines.push('THREAT_ARENA ECOLOGY: двигатель — процесс видов или среды, не одно животное.');
  } else if (arenaId === 'material') {
    lines.push('THREAT_ARENA MATERIAL: двигатель в веществе. Живое в носителе — не эта арена.');
  } else if (arenaId === 'built') {
    lines.push('THREAT_ARENA BUILT: двигатель в устройстве человеческой системы. Если живое ломает постройку — CREATURE/ECOLOGY.');
  } else if (arenaId === 'earth') {
    lines.push('THREAT_ARENA EARTH: двигатель в ландшафте или геологии. Колодец и сток — BUILT.');
  } else if (arenaId === 'sky') {
    lines.push('THREAT_ARENA SKY: двигатель в атмосфере, погоде или небе. Существо в полёте — CREATURE.');
  }
  const rel = tags.find((t) => t.groupId === 'worldRelation');
  if (rel?.tagId === 'native') {
    lines.push('WORLD_RELATION NATIVE: угроза выросла из уже существующей обычной жизни острова.');
  } else if (rel?.tagId === 'contact') {
    lines.push('WORLD_RELATION CONTACT: в привычную жизнь вошло новое явление, которого здесь раньше не было.');
  } else if (rel?.tagId === 'legacy') {
    lines.push('WORLD_RELATION LEGACY: нынешнее давление — следствие прошлого, старого объекта или забытой структуры.');
  }
  lines.push('Не классифицируй suspense и не строй граф. Не ставь depth и лестницу раскрытия. Просто придумай хорошую угрозу.');
  return lines.filter(Boolean).join('\n');
}

/** Тип обязателен; ассоциация должна читаться в графе, не как табличка. */
export function formatMysteryAxesForPrompt(tags, { opening = false } = {}) {
  const type = mysteryTypeTag(tags);
  const assoc = mysteryAssociationTag(tags);
  const lines = [];
  if (type) {
    const about = type.about ? ` — ${type.about}` : '';
    lines.push(`ТИП ТАЙНЫ (обязателен): ${type.tagName}${about}`);
    lines.push('Это форма произошедшего. Не подменяй канцелярией, учётом и историей кладки, если тип про другое.');
  }
  if (assoc) {
    lines.push('');
    lines.push(`АССОЦИАТИВНОЕ ПОЛЕ (очень слабый импульс): «${assoc.tagName}».`);
    lines.push(
      'Не факт мира и не обязательная тема. Может слегка коснуться связи, следа или X. Не создавай ради него сущность, событие или вторую линию. Слабый резонанс — нормально.',
    );
  }
  if (type || assoc) {
    lines.push(
      opening
        ? 'Даже на старте это должно задеть квартал или большую группу, не двор и не описная книга. Не конец острова.'
        : 'Масштаб — весь город или несущая жизнь острова: много людей, общая судьба, не двор и не описная книга.',
    );
  }
  return lines.join('\n');
}

const OPENING_SCALES = new Set(['neighborhood', 'person']);

function applyOpeningScale(cfg, tags, rng) {
  const mystery = (tags || []).some((t) => t.groupId === 'association' || t.groupId === 'type');
  const scaleGroup = mystery
    ? (cfg?.mysteryTagGroups || []).find((g) => g.id === 'scale')
    : (cfg?.tagGroups || []).find((g) => g.id === 'scale');
  const small = (scaleGroup?.tags || []).filter((t) => OPENING_SCALES.has(t.id));
  if (!small.length) return tags;
  const pick = pickWeightedTag(small, rng);
  return (tags || []).map((t) =>
    t.groupId === 'scale' && pick
      ? { ...t, tagId: pick.id, tagName: pick.name }
      : t,
  );
}

/** Стартовый посев: тот же жребий, но масштаб только соседство или несколько человек. */
export function pickOpeningPlotTags(cfg, rng = Math.random) {
  return applyOpeningScale(cfg, pickPlotTags(cfg, rng), rng);
}

export function pickSeedTags(cfg, { storyType = 'suspense', opening = false, rng = Math.random } = {}) {
  if (storyType === 'mystery') {
    const tags = pickMysteryPlotTags(cfg, rng);
    return opening ? applyOpeningScale(cfg, tags, rng) : tags;
  }
  return pickPlotTags(cfg, rng);
}

export function openingPlotCount(config, rng = Math.random) {
  const raw = config?.genesis?.openingPlots || {};
  const min = Math.max(0, Math.min(4, Number(raw.min ?? 1)));
  const max = Math.max(min, Math.min(4, Number(raw.max ?? 2)));
  if (max === 0) return 0;
  return min + Math.floor(rng() * (max - min + 1));
}

const SEED_HOOK_MIN = 220;

/**
 * Отсев пустышки и близнеца. Форму «кто хочет / что мешает» не проверяем.
 */
export function judgePlotSeed(domain, draft, { storyType, depth = 1 } = {}) {
  if (!draft) return 'empty';
  const title = String(draft.title || '').trim();
  const entry = String(draft.entry || '').trim();
  const synopsis = String(draft.synopsis || '').trim();
  if (!title || !entry || !synopsis) return 'empty';
  if (storyType === 'mystery') {
    const reason = judgeTruthGraph(draft.truthGraph || draft, {
      minNodes: 3,
      maxNodes: 8,
    });
    if (reason) return reason;
  } else {
    if (synopsis.length < SEED_HOOK_MIN) return 'thin_hook';
    const reason = judgeSuspenseCore(draft, depth);
    if (reason) return reason;
  }
  const twin = (domain.plotlines || []).find((p) =>
    textsLookSame(`${p.title} ${p.synopsis}`, `${title} ${synopsis}`, { minShared: 7 }),
  );
  if (twin) return 'twin';
  return null;
}

/** Разгадка тайны не для доски, речи и инспектора. */
export function stripPlotSecrets(plot) {
  if (!plot || typeof plot !== 'object') return plot;
  const {
    truth: _truth,
    truthGraph: _graph,
    resolutionFacts: _res,
    hiddenPremises: _hidden,
    discoveryLadder: _ladder,
    closureGate: _gate,
    ...rest
  } = plot;
  return rest;
}

/** Сумма масштаба живых историй. Дела не считаются. */
export function liveStoryImportance(domain) {
  return (domain?.plotlines || [])
    .filter((p) => p && p.kind === 'story')
    .reduce((sum, p) => sum + plotScale(p), 0);
}

/**
 * Шанс завязки: чем меньше суммарная важность живых историй, тем охотнее сеем.
 * Три мелких не глушат доску; одна громкая и одна средняя — уже полная.
 * Пустая доска — завязка обязательна. Дела в вес не входят.
 * Пауза после свежей завязки действует, только если вес уже набран.
 */
export function plotSeedChance(domain, cfg, tick = null) {
  const { total, stories } = countOpen(domain);
  if (total >= cfg.board.maxOpen) return 0;
  if (stories === 0) return 1;

  const target = Math.max(1, Number(cfg.board.targetImportance) || 100);
  const sum = liveStoryImportance(domain);
  if (sum >= target) {
    const cooldown = cfg.board.seedCooldownMonths;
    if (cooldown > 0 && Number.isFinite(Number(tick))) {
      const youngest = (domain.plotlines || [])
        .filter((p) => p.kind === 'story' && Number.isFinite(Number(p.createdTick)))
        .reduce((max, p) => Math.max(max, Number(p.createdTick)), -Infinity);
      if (Number.isFinite(youngest) && Number(tick) - youngest < cooldown) return 0;
    }
    return 0;
  }

  const missing = (target - sum) / target;
  const floor = Number(cfg.beats.baseChance ?? 0);
  const ceil = Number(cfg.board.seedMaxChance ?? 0.5);
  const chance = floor + missing * Math.max(0, ceil - floor);
  return Math.max(0, Math.min(ceil, chance));
}

/**
 * Продолжение в освободившийся слот: крючок есть, доска не полна.
 * Другие живые истории не мешают. Шанс — sequelChance.
 */
export function pickSequelSeed(domain, offers, cfg, rng = Math.random) {
  const { total } = countOpen(domain);
  if (total >= cfg.board.maxOpen) return null;
  const viable = (offers || []).filter((o) => o && String(o.hook || '').trim());
  if (!viable.length) return null;
  if (rng() >= Number(cfg.board.sequelChance ?? 0)) return null;
  return viable[viable.length - 1];
}

/** Тайна даёт сиквел только если её целиком разгадали и стартер пометил новую проблему. */
export function allowSequelAfter(plot) {
  if (!plot || plot.kind === 'errand') return false;
  if (plot.storyType === 'mystery') {
    return Boolean(plot.asksSequel) && (plot.ending === 'ok' || plot.ending === 'crit');
  }
  return true;
}

export function formatPlotTagsForPrompt(tags, { soft = false } = {}) {
  if (!tags?.length) return '(без посева)';
  const hints = tags.filter((t) => t.groupId === 'hint');
  const rest = tags.filter((t) => t.groupId !== 'hint');
  const parts = rest.map((t) => `${t.groupName}: «${t.tagName}»`);
  if (hints.length) {
    parts.push(`Ассоциации (очень мягко): ${hints.map((t) => t.tagName).join(', ')}`);
  }
  const body = parts.join(' · ');
  if (!soft) return body;
  return `всё мягко, ассоциации, не указания — ${body}`;
}

/** Служебный вид доски — для движка и логов, не для речи. */
export function formatBoardForPrompt(domain) {
  normalizePlotlines(domain);
  if (!domain.plotlines.length) return '(нитей нет)';
  return domain.plotlines
    .map((p) => {
      const stats = p.relatedStats.length ? ` | в игре: ${p.relatedStats.join('+')}` : '';
      const proc = p.relatedProcessIds.length ? ` | дела: ${p.relatedProcessIds.join(', ')}` : '';
      const kindLabel = p.kind === 'errand' ? '(дело)' : p.kind === 'order' ? '(порядок)' : '';
      const term =
        p.kind === 'order'
          ? p.durationMonths
            ? `срок=${p.durationMonths}мес.${p.expiresTick != null ? ` до тика ${p.expiresTick}` : ''}`
            : 'бессрочно'
          : `возраст=${p.ageMonths}/${p.maxAgeMonths}`;
      const three = isThreeActPlot(p);
      const meters = three
        ? `urgency=${p.urgency} gravity=${p.gravity} эск=${p.escalationLevel}/${p.maxEscalations} такт=${p.act} тип=${p.storyType}` +
          (p.storyType === 'suspense' && p.depth ? ` depth=${p.depth}` : '')
        : `T=${p.temperature} тип=${p.storyType || 'default'}`;
      return (
        `- [${p.id}] «${p.title}» ${kindLabel} ${meters} ${term}` +
        stats +
        proc +
        (p.synopsis ? `\n  ${p.synopsis}` : '')
      );
    })
    .join('\n');
}

/**
 * Компактная доска для речи правителя: id для инструментов, без заголовка нити.
 * @param {(ids: string[]) => string} statsFeel — качественное описание статов
 */
export function formatBoardForSpeech(domain, { statsFeel = null, max = 8, viewerId = null } = {}) {
  normalizePlotlines(domain);
  const list = (domain.plotlines || []).slice(0, max);
  if (!list.length) return '';
  const viewer = viewerId || domain.id;
  return list
    .map((p) => {
      const feel =
        statsFeel && p.relatedStats.length ? ` Упирается в: ${statsFeel(p.relatedStats)}.` : '';
      const viewerKnows = Boolean(p.plotAwareness?.[viewer]);
      const foreign =
        Boolean(p.confluxId) &&
        !p.isMainConflux &&
        !isOrderPlot(p) &&
        (p.concernsDomainIds || []).length > 0 &&
        !(p.concernsDomainIds || []).includes(viewer);
      const kind = p.kind === 'errand'
        ? 'поручение'
        : p.kind === 'order'
          ? 'порядок'
          : p.isMainConflux
            ? 'сопряжение'
            : p.shared && viewerKnows
              ? 'общая история'
              : foreign && viewerKnows
                ? 'история соседа'
                : 'история';
      const duty = (p.relatedProcessIds || []).length
        ? 'дело уже идёт'
        : p.kind === 'order'
          ? p.durationMonths
            ? `действует ${p.durationMonths} мес.`
            : 'действует бессрочно'
          : p.kind === 'errand'
            ? 'дела нет'
            : 'поручения ещё нет';
      const syn = clipText(p.synopsis || 'только началось', 180);
      return `[${p.id}] (${kind}, ${duty}): ${syn}${feel}`;
    })
    .join('\n');
}
