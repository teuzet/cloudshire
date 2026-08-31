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

const FREEFORM_GRAVITY_CATALOG = {
  SITUATION: {
    about:
      'Посадка — узкий законченный случай. Задеты конкретные люди, двор, лавка, одна договорённость — не город как целое. ' +
      'К исходу мало кто помнит, кроме участников. Порядок улиц, промыслов и обычаев тот же, что вчера.',
    unlike: 'Не EPISODE: это ещё не общая речь города.',
    examples: [
      'Двое соседей спорят, кому чинить общую изгородь после ночной бури.',
      'У пекаря пропала лучшая форма; ученик клянётся, что утром она ещё стояла на полке.',
      'Семья не может решить, кому в этом году нести венок на праздник своей улицы.',
      'Чабан нашёл в стаде чужую метку и должен вернуть одну овцу, пока не смешали окот.',
      'На общей лестнице треснула ступень: жильцы торгуются, кто кладёт доску.',
    ],
  },
  EPISODE: {
    about:
      'Посадка — событие, которое на какое-то время становится общей речью города: рынок, двор, очередь у воды. ' +
      'Пока свежо — все знают и имеют мнение; когда стихнет, жизнь встаёт на прежние круги. ' +
      'Может оставить след у одной группы или переменить привычку одного места, но карта города и его законы те же.',
    unlike: 'Не один двор и не глава города: порядки те же.',
    examples: [
      'На площади при свидетелях расторгли помолвку двух известных домов — шутки держатся до следующего праздника.',
      'Редкая птица неделю кружит над рядами; дети бегают смотреть, торговцы ставят приметы, потом птица уходит.',
      'Ночной ливень затопил нижнюю улицу: сушат добро, спорят о жёлобе; через две недели луж нет.',
      'Приезжий проповедник с соседнего края три базара собирает толпу и уходит — песни ещё поют, уклад тот же.',
      'К ночи пропало праздничное знамя цеха; ищут, корят сторожа, потом шьют новое.',
    ],
  },
  CRISIS: {
    about:
      'Посадка — испытание, которое город запомнит как собственную главу. Меняется какая-то область общей жизни: ' +
      'кто кому должен, чем кормятся, какой обычай считают началом сезона, кому можно жить на этом склоне. ' +
      'Остров узнаваем, но в одном существенном месте — уже другой. Цена высокая, привычный мир ещё держится.',
    unlike: 'Не EPISODE (это глава города) и не RUPTURE (прежний порядок ещё можно считать нормой).',
    examples: [
      'Иссяк основной источник питья целого склона — делят чужой и решают, кому сходить с насиженных дворов.',
      'Два дома рвут общий сезон подряд; без их согласия стоит половина строек.',
      'Запретили обряд у кромки, от которого считали начало полевых работ — календарь труда сбился.',
      'Падёж рабочего скота оставил без тяги несколько артелей сразу.',
      'Суд признал недействительным старый раздел пастбищ: десятки семей теряют привычный выгон.',
    ],
  },
  RUPTURE: {
    about:
      'Посадка, после которой прежний порядок нельзя считать нормой даже из вежливости. ' +
      'На кону слом того, на чём держалась совместная жизнь: массовая потеря, раскол веры или права, ' +
      'угроза району как несущей земле или острову как месту жить по-старому. ' +
      'Если динамика дойдёт до конца — будет внятное «до» и «после».',
    unlike:
      'Не CRISIS: там меняется одна область жизни, привычный мир ещё держится. Квартал как несущая земля — достаточно; спор двух дворов — нет.',
    examples: [
      'Несущая терраса, на которой стоит целый квартал, пошла трещинами: решать, кого снимать и чем жертвовать.',
      'Половина города перестаёт нести повинность храму — вера в покровителя больше не общая.',
      'Основной урожайный склон осыпается в пустоту: зима без запаса уже не для бедных, а для всех.',
      'Новый закон наследования отменяет старые дворы разом: кому жить в чьём доме — больше не ясно.',
      'На курс острова легла буря, какой не помнят живущие; не укрытые районы, скорее всего, не переживут её прежними.',
    ],
  },
};

function formatGravityLevel(id) {
  const entry = FREEFORM_GRAVITY_CATALOG[id];
  if (!entry) return '';
  return [
    `GRAVITY: ${id} — посадка истории (поле «последствия»), не размер затравки.`,
    'Затравка может быть узкой. Динамика делает эту посадку неизбежной, а не дописывает её словами.',
    entry.about,
    entry.unlike,
    'Примеры масштаба — якоря, не сюжеты для копирования:',
    ...entry.examples.map((x) => `- ${x}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Расшифровка выбранного freeform-gravity: только этот уровень, не вся шкала. */
export function formatFreeformGravityForPrompt(gravity) {
  return formatGravityLevel(parseFreeformGravity(gravity));
}

export function formatBrainstormCandidateForPrompt(candidate, index) {
  if (!candidate) return '';
  const axes = [candidate.arena, candidate.worldRelation, candidate.conflictSource, candidate.temporalShape]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' · ');
  const n = Number.isInteger(Number(index)) ? Number(index) : candidate.index;
  return [
    `=== Кандидат ${n || '?'} ===`,
    axes ? `оси: ${axes}` : null,
    formatFreeformSeedBlank(candidate),
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
