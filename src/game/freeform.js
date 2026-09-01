/**
 * Freeform-история: карточка без трёх тактов.
 * Архитектор (без города) → судья болванок → конструктор в городе.
 * В живой месяц пока не сеется — лаборатория /freeform.
 */

import { newId } from './ids.js';
import {
  createPlotline,
  isFreeformPlot,
  normalizeCloseWhenList,
  formatCloseWhen,
  clipPlotText,
  PLOT_SUMMARY_MAX,
  plotConfig,
  parseFreeformGravity,
  FREEFORM_GRAVITY,
} from './plotlines.js';
import { createLoreFact, chronicleEntries } from './models.js';
import { gameDateFromTickIndex, worldDateLabel } from './tickClock.js';
import { formatCityForAgents } from './cityContext.js';
import { formatOfficersCastHint } from './officers.js';
import { normalizeHiddenPremises } from './suspenseGraph.js';

export const FREEFORM_FINISH = ['fail', 'ok', 'crit'];

const FINISH_LABEL = {
  fail: 'ПРОВАЛ',
  ok: 'УСПЕХ',
  crit: 'КРИТИЧЕСКИЙ УСПЕХ',
};

export { parseFreeformGravity, FREEFORM_GRAVITY };

const DEFAULT_CONTINUATION_AUTHORS = [
  { id: 'poe', name: 'Эдгар Аллан По' },
  { id: 'lovecraft', name: 'Говард Лавкрафт' },
  { id: 'le_guin', name: 'Урсула Ле Гуин' },
  { id: 'dick', name: 'Филип К. Дик' },
  { id: 'lem', name: 'Станислав Лем' },
  { id: 'bradbury', name: 'Рэй Брэдбери' },
  { id: 'jackson', name: 'Шерли Джексон' },
  { id: 'borges', name: 'Хорхе Луис Борхес' },
  { id: 'mieville', name: 'Чайна Мьевиль' },
  { id: 'butler', name: 'Октавия Батлер' },
  { id: 'ballard', name: 'Дж. Г. Баллард' },
  { id: 'kafka', name: 'Франц Кафка' },
  { id: 'shelley', name: 'Мэри Шелли' },
  { id: 'vandermeer', name: 'Джефф Вандермеер' },
  { id: 'wolfe', name: 'Джин Вулф' },
];

function normalizeContinuationAuthors(raw) {
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_CONTINUATION_AUTHORS;
  return list
    .map((item, i) => {
      if (typeof item === 'string') {
        const name = item.trim();
        return { id: name.toLowerCase().replace(/[\s.]+/g, '_') || `author_${i}`, name };
      }
      const name = String(item?.name || '').trim();
      const id = String(item?.id || name)
        .trim()
        .toLowerCase()
        .replace(/[\s.]+/g, '_');
      return { id: id || `author_${i}`, name: name || id };
    })
    .filter((a) => a.name);
}

function exampleLine(x) {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    return Object.entries(x)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' ');
  }
  return String(x || '').trim();
}

function normalizeGravityLevel(raw) {
  if (!raw || typeof raw !== 'object') return { about: '', examples: [] };
  const examples = Array.isArray(raw.examples) ? raw.examples.map(exampleLine).filter(Boolean) : [];
  return {
    about: String(raw.about || '').trim(),
    examples,
  };
}

function normalizeGravityCatalog(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const levelsRaw = src.levels && typeof src.levels === 'object' ? src.levels : src;
  const levels = {};
  for (const id of FREEFORM_GRAVITY) {
    levels[id] = normalizeGravityLevel(levelsRaw[id]);
  }
  return {
    intro: String(src.intro || '').trim(),
    examplesLead: String(src.examplesLead || 'Примеры масштаба — якоря, не сюжеты для копирования:').trim(),
    levels,
  };
}

function formatGravityLevel(id, catalog) {
  const entry = catalog?.levels?.[id];
  if (!entry) return `GRAVITY: ${id}`;
  return [
    `GRAVITY: ${id}`,
    entry.about,
    entry.examples.length ? catalog.examplesLead : null,
    ...entry.examples.map((x) => `- ${x}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Расшифровка выбранного freeform-gravity: только этот уровень, не вся шкала. */
export function formatFreeformGravityForPrompt(gravity, config) {
  return formatGravityLevel(parseFreeformGravity(gravity), freeformConfig(config).gravity);
}

/** Затравка брейншторма: одна запись или несколько, от старых к новым. */
export function formatFreeformChronicleSeed(entries) {
  const list = Array.isArray(entries) ? entries : entries == null || entries === '' ? [] : [entries];
  return list
    .map((e) => {
      if (e == null) return '';
      if (typeof e === 'string') return e.trim();
      const text = String(e.text || e.chronicle || '').trim();
      if (!text) return '';
      const when = String(e.gameDateLabel || '').trim();
      return when ? `${when} — ${text}` : text;
    })
    .filter(Boolean)
    .join('\n');
}

export function formatBrainstormCandidateForPrompt(candidate, index, { includeAuthor = false } = {}) {
  if (!candidate) return '';
  const axes = [candidate.arena, candidate.worldRelation, candidate.conflictSource, candidate.temporalShape]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' · ');
  const n = Number.isInteger(Number(index)) ? Number(index) : candidate.index;
  const chronicle = String(candidate.chronicle || candidate.text || candidate.hook || '').trim();
  return [
    `=== Кандидат ${n || '?'} ===`,
    axes ? `оси: ${axes}` : null,
    includeAuthor && candidate.authorName ? `автор: ${candidate.authorName}` : null,
    chronicle ? `хроника: ${chronicle}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Четыре поля болванки завязки для промпта. */
export function formatFreeformSeedBlank(blank) {
  if (!blank) return '';
  const hook = String(blank.hook || blank.text || blank.premise || '').trim();
  const lines = [];
  if (hook) lines.push(`затравка: ${hook}`);
  if (blank.conflict) lines.push(`конфликт: ${blank.conflict}`);
  if (blank.dynamics) lines.push(`динамика: ${blank.dynamics}`);
  if (blank.consequences) lines.push(`последствия: ${blank.consequences}`);
  return lines.join('\n');
}

export function freeformConfig(config) {
  const raw = config?.tick?.plot?.freeform || {};
  const board = plotConfig(config).board;
  return {
    variantsMin: Math.max(2, Math.round(Number(raw.variantsMin) || 3)),
    variantsMax: Math.max(3, Math.round(Number(raw.variantsMax) || 3)),
    chronicleMaxChars: Math.max(180, Math.round(Number(raw.chronicleMaxChars) || 700)),
    seedChance: {
      critical: Number(raw.seedChance?.critical ?? 0.85),
      major: Number(raw.seedChance?.major ?? 0.45),
      minor: Number(raw.seedChance?.minor ?? 0.18),
    },
    boardMaxOpen: board.maxOpen,
    targetImportance: board.targetImportance,
    seedAxes: (Array.isArray(raw.seedAxes) ? raw.seedAxes : ['truthArena', 'worldRelation'])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
    continuationAuthors: normalizeContinuationAuthors(raw.continuationAuthors),
    gravity: normalizeGravityCatalog(raw.gravity),
  };
}

export function finishLabel(finish) {
  return FINISH_LABEL[String(finish)] || FINISH_LABEL.ok;
}

export function clampUrgency(n, fallback = 40) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, v));
}

/** Только названия живых нитей — для судьи, не бриф города. */
export function openStoryTitlesLine(domain, exceptId = null) {
  const skip = exceptId ? String(exceptId) : null;
  const titles = (domain?.plotlines || [])
    .filter((p) => p.kind === 'story' && p.status !== 'closed' && (!skip || String(p.id) !== skip))
    .map((p) => String(p.title || '').trim())
    .filter(Boolean);
  if (!titles.length) return '';
  return `Уже открытые истории (не продолжай и не делай близнеца): ${titles.join('; ')}.`;
}

export function normalizeFinish(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'fail' || s === 'провал') return 'fail';
  if (s === 'crit' || s === 'critical' || s === 'крит' || s.includes('критич')) return 'crit';
  return 'ok';
}

export function findFreeformPlot(domain, plotId = null) {
  const id = plotId ? String(plotId) : null;
  if (id) {
    return (domain?.plotlines || []).find((p) => p.id === id && isFreeformPlot(p)) || null;
  }
  return (domain?.plotlines || []).find((p) => isFreeformPlot(p) && p.status !== 'closed') || null;
}

export function freeformChronicles(domain, plot) {
  if (!plot) return [];
  const ids = new Set((plot.chronicleIds || []).map(String));
  return chronicleEntries(domain?.lore || [])
    .filter((e) => ids.has(String(e.id)) || (e.relatedPlotlineIds || []).includes(plot.id))
    .sort((a, b) => (Number(a.tick) || 0) - (Number(b.tick) || 0) || String(a.id).localeCompare(String(b.id)));
}

export function advanceWorldMonths(world, months = 1) {
  const step = Math.max(1, Math.round(Number(months) || 1));
  const start = Number.isInteger(Number(world?.tickIndex)) ? Number(world.tickIndex) : 0;
  const tick = start + step;
  const date = gameDateFromTickIndex(tick);
  world.tickIndex = tick;
  world.gameDate = date;
  return date;
}

export function appendChronicle(domain, world, { text, plotId = null, author, importance = 'major', tags = ['chronicle'] }) {
  const fact = createLoreFact({
    id: newId('lore'),
    text: clipPlotText(text, 1200),
    tags,
    gameDateLabel: worldDateLabel(world),
    tick: world.tickIndex,
    author,
    importance,
    relatedPlotlineIds: plotId ? [plotId] : null,
  });
  domain.lore = Array.isArray(domain.lore) ? domain.lore : [];
  domain.lore.push(fact);
  if (plotId) {
    const plot = (domain.plotlines || []).find((p) => p.id === plotId);
    if (plot) {
      plot.chronicleIds = plot.chronicleIds || [];
      if (!plot.chronicleIds.includes(fact.id)) plot.chronicleIds.push(fact.id);
    }
  }
  return fact;
}

export function createFreeformPlot({ domain, world, variant, config, seedChronicleId = null }) {
  const plot = createPlotline({
    title: variant.title,
    synopsis: variant.synopsis,
    closeWhen: variant.closeWhen,
    kind: 'story',
    storyType: 'freeform',
    hiddenPremises: variant.hiddenPremises,
    urgency: variant.urgency,
    gravity: parseFreeformGravity(variant.gravity),
    tick: world.tickIndex,
    config,
  });
  if (seedChronicleId) plot.chronicleIds.push(seedChronicleId);
  if (variant.arena) plot.arena = String(variant.arena);
  if (variant.worldRelation) plot.worldRelation = String(variant.worldRelation);
  if (variant.whyMoves) plot.whyMoves = clipPlotText(variant.whyMoves, PLOT_SUMMARY_MAX);
  if (variant.hook) plot.hook = clipPlotText(variant.hook, PLOT_SUMMARY_MAX);
  if (variant.conflict) plot.conflict = clipPlotText(variant.conflict, PLOT_SUMMARY_MAX);
  if (variant.dynamics) plot.dynamics = clipPlotText(variant.dynamics, PLOT_SUMMARY_MAX);
  if (variant.consequences) plot.consequences = clipPlotText(variant.consequences, PLOT_SUMMARY_MAX);
  domain.plotlines = domain.plotlines || [];
  domain.plotlines.push(plot);
  return plot;
}

export function applyFreeformState(plot, patch = {}) {
  if (!plot || !patch) return plot;
  if (patch.synopsis) plot.synopsis = clipPlotText(patch.synopsis, PLOT_SUMMARY_MAX);
  if (patch.closeWhen) plot.closeWhen = normalizeCloseWhenList(patch.closeWhen);
  if (patch.hiddenPremises) plot.hiddenPremises = normalizeHiddenPremises(patch.hiddenPremises);
  if (Number.isFinite(Number(patch.urgency))) {
    plot.urgency = Math.max(0, Math.min(100, Math.round(Number(patch.urgency))));
  }
  if (patch.closed) {
    plot.ending = patch.closedBy || 'resolved';
  }
  return plot;
}

export function cityStateForPrompt(domain, world) {
  const stats = domain?.stats || {};
  const statLine = Object.entries(stats)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const open = (domain?.plotlines || [])
    .filter((p) => p.kind === 'story')
    .map((p) => `- ${p.title} [${p.storyType || 'default'}]: ${clipPlotText(p.synopsis, 180)}`)
    .join('\n');
  return [
    `Дата: ${worldDateLabel(world)} (тик ${world.tickIndex}).`,
    `Город «${domain?.name}».`,
    formatCityForAgents(domain),
    formatOfficersCastHint(domain),
    statLine ? `Статы: ${statLine}` : '',
    open ? `Открытые истории:\n${open}` : 'Открытых историй нет.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function plotCardForPrompt(plot, { revealHidden = true } = {}) {
  if (!plot) return '';
  const lines = [
    `История «${plot.title}».`,
    `Синопсис: ${plot.synopsis || '—'}`,
    `Исходы, которыми история может закрыться:\n${formatCloseWhen(plot)}`,
    plot.whyMoves
      ? `whyMoves: ${plot.whyMoves}`
      : 'whyMoves: не задан.',
    `urgency: ${plot.urgency ?? '—'} (0 — сама не тикает, 100 — каждый месяц без RELATED-дела).`,
    `gravity: ${plot.gravity || '—'}`,
  ];
  if (revealHidden) {
    const hidden = plot.hiddenPremises || [];
    lines.push(
      hidden.length
        ? `hiddenPremises (только тебе, в хронику не писать):\n${hidden.map((h) => `- ${h}`).join('\n')}`
        : 'hiddenPremises: нет. Тайны может не быть.',
    );
  }
  return lines.join('\n');
}

export function plotChronicleForPrompt(domain, plot) {
  const prior = freeformChronicles(domain, plot).map(
    (e) => `- ${e.gameDateLabel || '?'}: ${e.text}`,
  );
  if (prior.length) return `Хроника этой истории:\n${prior.join('\n')}`;
  return 'Хроники этой истории пока нет.';
}

export { formatCloseWhen, normalizeCloseWhenList };
