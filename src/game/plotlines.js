import { newId } from './ids.js';
import { textsLookSame } from './processes.js';
import { normalizeTruthGraph, judgeTruthGraph, parseMysteryShapes } from './mysteryGraph.js';

/**
 * Сюжетные нити — ядро мира: событий вне нитей не бывает.
 * Здесь только модель и формат; отбор битов, окраска и часы — в движке тика.
 *
 * Механика (см. docs/PIVOT_PLOTLINES.md):
 *   gravity     — масштаб последствий; у трёхтактных ставит plotStakes
 *   urgency     — шанс, что история сама сдвинется в месяц без дела
 *   temperature — интерес (старые нити, указы, сопряжение; греет внимание игрока)
 *   importance  — внутренний масштаб дельт; у трёхтактных зеркало gravity, агенты не ставят
 *   maxAgeMonths / ageMonths — сколько месяцев история живёт без внимания;
 *     срок сам по себе не развязка: выдохшаяся нить гаснет, только если нет дел и упоминаний
 *   closeWhen — что должно случиться, чтобы историю закрыть по существу, не «что писать в последний месяц»
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
 * Default — старые рельсы (поручение, указ, сопряжение, наследие без типа).
 */
export function storyTypeOf(plot) {
  if (!plot || plot.kind !== 'story' || plot.isMainConflux || plot.shared || plot.confluxId) {
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
  return Math.max(0, Math.min(200, v));
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
      truth: '',
      truthGraph: null,
      ending: null,
      asksSequel: false,
    };
  }
  const urgency = clampStakes(p.urgency, 40);
  const gravity = clampStakes(p.gravity, 40);
  const graph = type === 'mystery' ? normalizeTruthGraph(p.truthGraph) : null;
  return {
    storyType: type,
    act: Number(p.act) === 2 ? 2 : 1,
    urgency,
    gravity,
    urgency0: clampStakes(p.urgency0 ?? urgency, urgency),
    gravity0: clampStakes(p.gravity0 ?? gravity, gravity),
    truth: type === 'mystery' && !graph ? String(p.truth || '') : '',
    truthGraph: graph,
    ending: ['crit', 'ok', 'fail'].includes(p.ending) ? p.ending : null,
    asksSequel: Boolean(p.asksSequel),
  };
}

export function isOrderPlot(plot) {
  return plot?.kind === 'order';
}

function clampChance(n, fallback = 0.2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function orderCadence(p, config = null) {
  const fallback = Number(config?.tick?.plot?.orders?.defaultChance ?? 0.2);
  const every = Math.round(Number(p?.scheduleEveryMonths));
  const scheduled = Number.isInteger(every) && every >= 1 && every <= 12;
  const due = Number(p?.nextDueTick);
  return {
    modifierId: p?.modifierId ? String(p.modifierId) : null,
    // Регулярность и вероятность взаимоисключающи: расписание = гарантия, шанс = лотерея.
    fireChance: scheduled ? 0 : clampChance(p?.fireChance, Number.isFinite(fallback) ? fallback : 0.2),
    scheduleEveryMonths: scheduled ? every : null,
    nextDueTick: Number.isInteger(due) ? due : null,
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
      // Сжатая шкала: слабость чувствуется, но не приговаривает.
      minChance: Number(roll.minChance ?? 0.25),
      maxChance: Number(roll.maxChance ?? 0.75),
      primaryWeight: Number(roll.primaryWeight ?? 2),
      dualBand: Number(roll.dualBand ?? 0.2),
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
      failMultiplier: Math.max(1, Number(p.acts?.failMultiplier ?? 2)),
      worsenMin: Number(p.acts?.worsenMin ?? 1),
      worsenMax: Number(p.acts?.worsenMax ?? 1.5),
      dampMin: Number(p.acts?.dampMin ?? 0.8),
      dampMax: Number(p.acts?.dampMax ?? 1),
    },
  };
}

function normalizeStatIds(raw, config = null) {
  const allowed = new Set((config?.stats || []).map((s) => s.id));
  const ids = Array.isArray(raw) ? raw.map(String) : [];
  const uniq = [...new Set(ids)];
  return allowed.size ? uniq.filter((id) => allowed.has(id)) : uniq;
}

export function normalizePlotlines(domain, config = null) {
  if (!domain || typeof domain !== 'object') return domain;
  if (!Array.isArray(domain.plotlines)) domain.plotlines = [];
  domain.plotlines = domain.plotlines
    .filter((p) => p && typeof p === 'object' && p.status !== 'closed')
    .map((p) => ({
      id: p.id || newId('plot'),
      title: clipText(p.title || 'Сюжет', PLOT_TITLE_MAX),
      synopsis: clipText(p.synopsis ?? p.summary ?? '', PLOT_SUMMARY_MAX),
      closeWhen: clipText(p.closeWhen, PLOT_HOOK_MAX),
      kind: PLOT_KINDS.includes(p.kind) ? p.kind : 'story',
      tags: Array.isArray(p.tags) ? p.tags : [],
      relatedStats: normalizeStatIds(p.relatedStats, config),
      chronicleIds: Array.isArray(p.chronicleIds) ? p.chronicleIds.map(String) : [],
      relatedProcessIds: Array.isArray(p.relatedProcessIds)
        ? p.relatedProcessIds.map(String)
        : [],
      relatedPlotlineIds: Array.isArray(p.relatedPlotlineIds)
        ? p.relatedPlotlineIds.map(String)
        : [],
      importance: clamp100(p.importance, 40),
      maxAgeMonths: Math.max(1, Math.min(36, Math.round(Number(p.maxAgeMonths) || 6))),
      ageMonths: Math.max(0, Math.round(Number(p.ageMonths) || 0)),
      temperature: clamp100(p.temperature, 30),
      mirrorOf: p.mirrorOf ? String(p.mirrorOf) : null,
      confluxId: p.confluxId ? String(p.confluxId) : null,
      partnerGone: Boolean(p.partnerGone),
      hostDomainId: p.hostDomainId ? String(p.hostDomainId) : null,
      concernsDomainIds: Array.isArray(p.concernsDomainIds)
        ? [...new Set(p.concernsDomainIds.map(String))]
        : [],
      shared: Boolean(p.shared),
      isMainConflux: Boolean(p.isMainConflux),
      sharedReason: p.sharedReason ? String(p.sharedReason) : null,
      status: 'open',
      createdTick: p.createdTick == null ? null : Number(p.createdTick),
      lastBeatTick: p.lastBeatTick == null ? null : Number(p.lastBeatTick),
      beatCount: Math.max(0, Math.round(Number(p.beatCount) || 0)),
      ...storyActState(p),
      ...(p.kind === 'order' ? orderCadence(p, config) : {}),
    }));
  return domain;
}

export function createPlotline({
  title,
  synopsis = '',
  summary = '', // legacy-алиас, уйдёт вместе со старым режиссёром
  closeWhen = '',
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
  fireChance = null,
  scheduleEveryMonths = null,
  nextDueTick = null,
  storyType = null,
  act = 1,
  urgency = null,
  gravity = null,
  urgency0 = null,
  gravity0 = null,
  truth = '',
  truthGraph = null,
  ending = null,
  asksSequel = false,
  config = null,
}) {
  const resolvedKind = PLOT_KINDS.includes(kind) ? kind : 'story';
  return {
    id: newId('plot'),
    title: clipText(title || (resolvedKind === 'order' ? 'Порядок' : 'Сюжет'), PLOT_TITLE_MAX),
    synopsis: clipText(synopsis || summary, PLOT_SUMMARY_MAX),
    closeWhen: clipText(closeWhen, PLOT_HOOK_MAX),
    kind: resolvedKind,
    tags: Array.isArray(tags) ? tags : [],
    relatedStats: normalizeStatIds(relatedStats, config),
    chronicleIds: [],
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
    partnerGone: false,
    status: 'open',
    createdTick: tick,
    lastBeatTick: null,
    beatCount: 0,
    ...(resolvedKind === 'order'
      ? orderCadence(
          { modifierId, fireChance, scheduleEveryMonths, nextDueTick },
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
      truth,
      truthGraph,
      ending,
      asksSequel,
      kind: resolvedKind,
      isMainConflux,
      shared,
      confluxId,
    }),
  };
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

/** Поручение ещё идёт — нить рано убирать с доски, иначе дело получит пустую карточку. */
export function plotHasActiveProcess(domain, plot) {
  const ids = new Set((plot?.relatedProcessIds || []).map(String));
  if (!ids.size) return false;
  return (domain?.state?.pendingActions || []).some(
    (a) => ids.has(String(a.id)) && (!a.status || a.status === 'active'),
  );
}

function archiveClosedPlot(plot, { tick = null, reason = '', sequelHook = '' } = {}) {
  const closeReason = reason || plot.closeReason || '';
  const hook = clipText(sequelHook || plot.sequelHook, PLOT_HOOK_MAX);
  return {
    id: plot.id,
    title: plot.title,
    synopsis: plot.synopsis || '',
    closeWhen: plot.closeWhen || '',
    kind: plot.kind || 'story',
    tags: Array.isArray(plot.tags) ? plot.tags : [],
    relatedStats: Array.isArray(plot.relatedStats) ? [...plot.relatedStats] : [],
    chronicleIds: Array.isArray(plot.chronicleIds) ? [...plot.chronicleIds] : [],
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
    ...storyActState(plot),
    ...(plot.kind === 'order'
      ? {
          modifierId: plot.modifierId || null,
          fireChance: plot.fireChance,
          scheduleEveryMonths: plot.scheduleEveryMonths ?? null,
          nextDueTick: plot.nextDueTick ?? null,
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
    kind: PLOT_KINDS.includes(closed.kind) ? closed.kind : 'story',
    tags: Array.isArray(closed.tags) ? closed.tags : [],
    relatedStats: Array.isArray(closed.relatedStats) ? [...closed.relatedStats] : [],
    chronicleIds: Array.isArray(closed.chronicleIds) ? closed.chronicleIds.map(String) : [],
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
  if (!factId) return;
  for (const id of [...new Set((plotlineIds || []).map(String))]) {
    const p = findPlotline(domain, id);
    if (!p) continue;
    if (!p.chronicleIds.includes(String(factId))) p.chronicleIds.push(String(factId));
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

/**
 * Жребий завязки: по одному тегу из каждой группы, все обязательны.
 * Группы сами по себе узкие и абстрактные — тон, сфера, источник, масштаб.
 * У тега может быть weight: больше — чаще выпадает.
 */
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
  return opening ? pickOpeningPlotTags(cfg, rng) : pickPlotTags(cfg, rng);
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
export function judgePlotSeed(domain, draft, { storyType } = {}) {
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
  }
  if (synopsis.length < SEED_HOOK_MIN) return 'thin_hook';
  const twin = (domain.plotlines || []).find((p) =>
    textsLookSame(`${p.title} ${p.synopsis}`, `${title} ${synopsis}`, { minShared: 7 }),
  );
  if (twin) return 'twin';
  return null;
}

/** Разгадка тайны не для доски, речи и инспектора. */
export function stripPlotSecrets(plot) {
  if (!plot || typeof plot !== 'object') return plot;
  const { truth: _truth, truthGraph: _graph, ...rest } = plot;
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
 * Продолжение сразу после развязки: только если живых историй не осталось
 * и закрытие оставило крючок. Шанс — sequelChance; иначе обычный посев.
 */
export function pickSequelSeed(domain, offers, cfg, rng = Math.random) {
  const { stories, total } = countOpen(domain);
  if (stories > 0 || total >= cfg.board.maxOpen) return null;
  const viable = (offers || []).filter((o) => o && String(o.hook || '').trim());
  if (!viable.length) return null;
  if (rng() >= Number(cfg.board.sequelChance ?? 0)) return null;
  return viable[viable.length - 1];
}

/** Тайна даёт сиквел только если стартер пометил, что разгадка вскрывает новую проблему. */
export function allowSequelAfter(plot) {
  if (!plot || plot.kind === 'errand') return false;
  if (plot.storyType === 'mystery') return Boolean(plot.asksSequel);
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
      const three = isThreeActPlot(p);
      const meters = three
        ? `urgency=${p.urgency} gravity=${p.gravity} такт=${p.act} тип=${p.storyType}`
        : `T=${p.temperature} тип=${p.storyType || 'default'}`;
      return (
        `- [${p.id}] «${p.title}» ${kindLabel} ${meters} возраст=${p.ageMonths}/${p.maxAgeMonths}` +
        stats +
        proc +
        (p.synopsis ? `\n  ${p.synopsis}` : '')
      );
    })
    .join('\n');
}

/**
 * Компактная доска для речи: без id, температур и прочей механики.
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
      const foreign =
        (p.concernsDomainIds || []).length > 0 &&
        !(p.concernsDomainIds || []).includes(viewer) &&
        !p.isMainConflux;
      const kind = p.kind === 'errand'
        ? 'поручение'
        : p.kind === 'order'
          ? 'порядок'
          : p.isMainConflux
            ? 'сопряжение'
            : p.shared
              ? 'общая история'
              : foreign
                ? 'история соседа'
                : 'история';
      const duty = (p.relatedProcessIds || []).length
        ? 'дело уже идёт'
        : p.kind === 'order'
          ? 'действует'
          : p.kind === 'errand'
            ? 'дела нет'
            : 'поручения ещё нет';
      const syn = clipText(p.synopsis || 'только началось', 180);
      return `«${p.title}» [${p.id}] (${kind}, ${duty}): ${syn}${feel}`;
    })
    .join('\n');
}
