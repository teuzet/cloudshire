import { newId } from './ids.js';

/**
 * Сюжетные нити — ядро мира: событий вне нитей не бывает.
 * Здесь только модель и формат; отбор битов, окраска и часы — в движке тика.
 *
 * Механика (см. docs/PIVOT_PLOTLINES.md):
 *   temperature — интерес к нити (растёт от внимания игрока, падает со временем)
 *   importance  — судьбоносность для города, задаёт масштаб последствий
 *   maxAgeMonths / ageMonths — сколько месяцев ждём интереса и сколько уже прошло
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

export const PLOT_SUMMARY_MAX = 400;
export const PLOT_HOOK_MAX = 120;
export const PLOT_TITLE_MAX = 120;
export { clipText as clipPlotText };

export const PLOT_KINDS = ['story', 'errand'];

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
    tagGroups: Array.isArray(p.tagGroups) ? p.tagGroups : [],
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
      status: 'open',
      createdTick: p.createdTick == null ? null : Number(p.createdTick),
      lastBeatTick: p.lastBeatTick == null ? null : Number(p.lastBeatTick),
      beatCount: Math.max(0, Math.round(Number(p.beatCount) || 0)),
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
  config = null,
}) {
  return {
    id: newId('plot'),
    title: clipText(title || 'Сюжет', PLOT_TITLE_MAX),
    synopsis: clipText(synopsis || summary, PLOT_SUMMARY_MAX),
    closeWhen: clipText(closeWhen, PLOT_HOOK_MAX),
    kind: PLOT_KINDS.includes(kind) ? kind : 'story',
    tags: Array.isArray(tags) ? tags : [],
    relatedStats: normalizeStatIds(relatedStats, config),
    chronicleIds: [],
    relatedProcessIds: (relatedProcessIds || []).map(String),
    relatedPlotlineIds: (relatedPlotlineIds || []).map(String),
    importance: clamp100(importance, 40),
    maxAgeMonths: Math.max(1, Math.min(36, Math.round(Number(maxAgeMonths) || 6))),
    ageMonths: 0,
    temperature: clamp100(temperature, 30),
    mirrorOf: mirrorOf ? String(mirrorOf) : null,
    confluxId: confluxId ? String(confluxId) : null,
    partnerGone: false,
    status: 'open',
    createdTick: tick,
    lastBeatTick: null,
    beatCount: 0,
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

export function countOpen(domain) {
  const list = domain?.plotlines || [];
  return {
    total: list.length,
    stories: list.filter((p) => p.kind !== 'errand').length,
    errands: list.filter((p) => p.kind === 'errand').length,
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
    p.ageMonths += 1;
    p.temperature = clamp100(p.temperature - decay);
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

export function closePlotline(domain, plotlineId, { tick = null, reason = '' } = {}) {
  const list = domain?.plotlines || [];
  const idx = list.findIndex((p) => p.id === plotlineId);
  if (idx < 0) return null;
  const [plot] = list.splice(idx, 1);
  plot.status = 'closed';
  plot.closedTick = tick;
  plot.closeReason = reason || '';
  domain.closedPlotlines = Array.isArray(domain.closedPlotlines) ? domain.closedPlotlines : [];
  domain.closedPlotlines.push({
    id: plot.id,
    title: plot.title,
    closedTick: tick,
    reason: plot.closeReason,
    beatCount: plot.beatCount,
  });
  if (domain.closedPlotlines.length > 40) {
    domain.closedPlotlines = domain.closedPlotlines.slice(-40);
  }
  return plot;
}

/** Жребий тегов новой нити — движок, не агент. */
export function pickPlotTags(cfg, rng = Math.random) {
  const groups = cfg?.tagGroups || [];
  const core = ['tone', 'start_event', 'spark_source', 'stake'];
  const extra = ['phenomenon', 'stakeholders', 'scale', 'urgency'];
  const picked = [];
  for (const gid of [...core, ...extra]) {
    const g = groups.find((x) => x.id === gid);
    if (!g?.tags?.length) continue;
    if (extra.includes(gid) && rng() > 0.6) continue;
    const tag = g.tags[Math.floor(rng() * g.tags.length)];
    if (!tag) continue;
    picked.push({
      groupId: g.id,
      groupName: g.name || g.id,
      tagId: tag.id,
      tagName: tag.name,
    });
  }
  return picked;
}

export function formatPlotTagsForPrompt(tags) {
  if (!tags?.length) return '(без посева)';
  return tags.map((t) => `${t.groupName}: «${t.tagName}»`).join(' · ');
}

/** Служебный вид доски — для движка и логов, не для речи. */
export function formatBoardForPrompt(domain) {
  normalizePlotlines(domain);
  if (!domain.plotlines.length) return '(нитей нет)';
  return domain.plotlines
    .map((p) => {
      const stats = p.relatedStats.length ? ` | в игре: ${p.relatedStats.join('+')}` : '';
      const proc = p.relatedProcessIds.length ? ` | дела: ${p.relatedProcessIds.join(', ')}` : '';
      return (
        `- [${p.id}] «${p.title}» ${p.kind === 'errand' ? '(дело)' : ''} ` +
        `T=${p.temperature} важность=${p.importance} возраст=${p.ageMonths}/${p.maxAgeMonths}` +
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
export function formatBoardForSpeech(domain, { statsFeel = null, max = 5 } = {}) {
  normalizePlotlines(domain);
  const list = (domain.plotlines || []).slice(0, max);
  if (!list.length) return '';
  return list
    .map((p) => {
      const feel =
        statsFeel && p.relatedStats.length ? ` Упирается в: ${statsFeel(p.relatedStats)}.` : '';
      const proc = p.relatedProcessIds.length ? ' По ней идёт дело.' : '';
      return `«${p.title}» [${p.id}]: ${p.synopsis || 'только началось'}${feel}${proc}`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * ВРЕМЕННЫЙ СЛОЙ СОВМЕСТИМОСТИ (фазы 0–2).
 * Старые резолвер и режиссёр ещё зовут этот API; удаляется в фазе 3
 * вместе с ними. Новый код пользуется функциями выше.
 * ------------------------------------------------------------------ */

export function plotlinesConfig(config) {
  const cfg = plotConfig(config);
  return {
    ...cfg,
    enabled: cfg.enabled,
    heatPerTick: 0,
    maxOpen: cfg.board.maxOpen,
    softMax: Math.max(1, cfg.board.maxOpen - 1),
    hooksMaxLen: PLOT_HOOK_MAX,
    attention: { bumpFactor: 1, chronicleLink: cfg.temperature.perTouch },
    survival: { minAgeTicks: 1 },
    spawn: { baseChance: cfg.beats.baseChance },
    seedTagGroups: cfg.tagGroups,
  };
}

export function heatPlotlines(domain, _heat, cfg) {
  return advancePlotClocks(domain, cfg?.temperature ? cfg : plotConfig({}));
}

/** Прорывов больше нет: их место занял бит нити (движок тика). */
export function rollBreakthroughs() {
  return [];
}

export function clearBreakthroughFlags() {}

export function formatBreakthroughMandate() {
  return '';
}

export function grantAttention(plotline, amount) {
  if (!plotline) return 0;
  const before = plotline.temperature ?? 0;
  plotline.temperature = clamp100(before + Number(amount || 0));
  return plotline.temperature - before;
}

export function grantAttentionToIds(domain, plotlineIds, amount) {
  normalizePlotlines(domain);
  const granted = [];
  for (const id of [...new Set((plotlineIds || []).map(String))]) {
    const p = findPlotline(domain, id);
    if (!p) continue;
    const delta = grantAttention(p, amount);
    if (delta) granted.push({ id, delta, temperature: p.temperature });
  }
  return granted;
}

export function listClosureCandidates(domain) {
  normalizePlotlines(domain);
  return domain.plotlines
    .filter((p) => isOverdue(p))
    .map((p) => ({
      id: p.id,
      title: p.title,
      ageTicks: p.ageMonths,
      closeWhen: p.closeWhen || '',
      reason: `возраст ${p.ageMonths} ≥ предела ${p.maxAgeMonths}`,
    }));
}

export function rollPlotSpawn(domain, cfg = null, rng = Math.random, config = null) {
  const conf = cfg?.board ? cfg : plotConfig(config || {});
  const room = boardHasRoom(domain, conf);
  const chance = room.story ? conf.beats.baseChance : 0;
  const roll = rng();
  const hit = roll < chance;
  const tags = hit ? pickPlotTags(conf, rng) : [];
  return {
    hit,
    chance,
    roll,
    openCount: countOpen(domain).total,
    softMax: conf.board.maxOpen - 1,
    maxOpen: conf.board.maxOpen,
    seeds: tags,
    seedText: formatPlotTagsForPrompt(tags),
  };
}

export function formatPlotlinesForPrompt(domain) {
  return formatBoardForPrompt(domain);
}

export function formatPlotBriefForSpeech(domain, opts = {}) {
  return formatBoardForSpeech(domain, opts);
}

export function formatDirectorMetaForPrompt({ closureCandidates, spawn, openCount, maxOpen }) {
  const lines = [`ДОСКА: открытых ${openCount ?? '?'}/${maxOpen ?? '?'}.`];
  if (closureCandidates?.length) {
    lines.push('ПЕРЕЖИВШИЕ СВОЙ СРОК (закрыть или явно оживить):');
    for (const c of closureCandidates) lines.push(`- [${c.id}] «${c.title}»: ${c.reason}`);
  }
  if (spawn?.hit) {
    lines.push(`МАНДАТ НОВОЙ НИТИ. Посев: ${spawn.seedText}.`);
  }
  return lines.join('\n');
}
