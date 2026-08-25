/**
 * Доска нитей и дел на конфлюксе: перевод с городов, видимость, просачивание, возврат.
 * Указы (kind: order) остаются на домене.
 */

import { createPlotline, isOrderPlot, clipPlotText, PLOT_SUMMARY_MAX, PLOT_TITLE_MAX } from './plotlines.js';
import { newId } from './ids.js';
import { createLoreFact } from './models.js';

function clamp100(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function asIdList(raw) {
  return [...new Set((Array.isArray(raw) ? raw : []).map(String).filter(Boolean))];
}

export function isSharedPlot(plot) {
  if (!plot || isOrderPlot(plot)) return false;
  if (plot.isMainConflux) return true;
  return asIdList(plot.concernsDomainIds).length >= 2 || Boolean(plot.shared);
}

export function plotConcerns(plot, domainId) {
  return asIdList(plot?.concernsDomainIds).includes(String(domainId));
}

export function plotHostId(plot) {
  return plot?.hostDomainId ? String(plot.hostDomainId) : asIdList(plot?.concernsDomainIds)[0] || null;
}

/**
 * Кому из городов писать хронику этого бита.
 * До стыковки чужой берег не виден: запись только хозяину дела или нити.
 */
export function chronicleReceiversForBeat(conflux, plot, beat, domains) {
  const list = domains || [];
  const concerned = list.filter((d) => plot?.isMainConflux || plotConcerns(plot, d.id));
  if (conflux?.status === 'docked') return concerned;

  const processId = beat?.processOutcome?.processId;
  const ownerId =
    beat?.processOutcome?.ownerDomainId ||
    (processId
      ? (conflux?.processes || []).find((pr) => String(pr.id) === String(processId))?.ownerDomainId
      : null);
  if (ownerId) return list.filter((d) => String(d.id) === String(ownerId));
  const host = plot?.hostDomainId ? String(plot.hostDomainId) : null;
  if (host) return list.filter((d) => String(d.id) === String(host));
  const concerns = asIdList(plot?.concernsDomainIds);
  if (concerns.length === 1) return list.filter((d) => String(d.id) === concerns[0]);
  return [];
}

export function leakChanceFromImportance(importance, avgAwareness) {
  const imp = Number(importance) || 0;
  const base = Math.max(0, Math.min(1, ((imp - 30) / 70) * 0.6));
  const info = clamp100(avgAwareness, 0) / 100;
  return base * info;
}

export function averageAwareness(conflux) {
  const ids = asIdList(conflux?.domainIds);
  if (!ids.length) return 0;
  const sum = ids.reduce((s, id) => s + Number(conflux?.awareness?.[id] || 0), 0);
  return sum / ids.length;
}

export function sharePlotWithDomain(plot, domainId, { reason = 'leak' } = {}) {
  if (!plot || isOrderPlot(plot)) return plot;
  const id = String(domainId);
  plot.concernsDomainIds = asIdList(plot.concernsDomainIds);
  if (!plot.concernsDomainIds.includes(id)) plot.concernsDomainIds.push(id);
  if (plot.concernsDomainIds.length >= 2 || plot.isMainConflux) {
    plot.shared = true;
    plot.sharedReason = reason;
  }
  return plot;
}

export function maybeLeakPlot(plot, conflux, otherDomainId, rng = Math.random) {
  if (!plot || isSharedPlot(plot) || isOrderPlot(plot)) return false;
  if (conflux?.status !== 'docked') return false;
  const chance = leakChanceFromImportance(plot.importance, averageAwareness(conflux));
  if (chance <= 0 || rng() >= chance) return false;
  sharePlotWithDomain(plot, otherDomainId, { reason: 'leak' });
  return true;
}

export function stampPlotOnConflux(plot, conflux, domainId) {
  if (!plot || isOrderPlot(plot)) return plot;
  plot.confluxId = conflux.id;
  plot.hostDomainId = plot.hostDomainId || String(domainId);
  plot.concernsDomainIds = asIdList(plot.concernsDomainIds);
  if (!plot.concernsDomainIds.length) plot.concernsDomainIds = [String(domainId)];
  plot.shared = isSharedPlot(plot);
  plot.isMainConflux = Boolean(plot.isMainConflux);
  return plot;
}

export function stampProcessOnConflux(process, conflux, domainId) {
  if (!process) return process;
  process.confluxId = conflux.id;
  process.ownerDomainId = process.ownerDomainId || String(domainId);
  return process;
}

export function normalizeConfluxBoard(conflux) {
  if (!conflux || typeof conflux !== 'object') return conflux;
  if (!conflux.awareness || typeof conflux.awareness !== 'object') conflux.awareness = {};
  if (!conflux.knownLoreIds || typeof conflux.knownLoreIds !== 'object') conflux.knownLoreIds = {};
  if (!Array.isArray(conflux.plotlines)) conflux.plotlines = [];
  if (!Array.isArray(conflux.closedPlotlines)) conflux.closedPlotlines = [];
  if (!Array.isArray(conflux.processes)) conflux.processes = [];
  if (!Array.isArray(conflux.lore)) conflux.lore = [];
  for (const id of asIdList(conflux.domainIds)) {
    if (!Number.isFinite(Number(conflux.awareness[id]))) conflux.awareness[id] = 0;
    if (!Array.isArray(conflux.knownLoreIds[id])) conflux.knownLoreIds[id] = [];
  }
  if (conflux.mainPlotId == null) conflux.mainPlotId = null;
  return conflux;
}

export function knownSetFor(conflux, domainId) {
  return new Set(asIdList(conflux?.knownLoreIds?.[domainId]));
}

export function markLoreKnown(conflux, domainId, factId) {
  normalizeConfluxBoard(conflux);
  const id = String(domainId);
  const fact = String(factId);
  const list = conflux.knownLoreIds[id] || [];
  if (!list.includes(fact)) list.push(fact);
  conflux.knownLoreIds[id] = list;
}

/** Известное не забывается. Бросок только по ещё неизвестным публичным записям соседа. */
export function revealKnownLore({ conflux, viewerId, partner, rng = Math.random }) {
  normalizeConfluxBoard(conflux);
  if (conflux.status !== 'docked') return { revealed: 0 };
  const awareness = clamp100(conflux.awareness?.[viewerId], 0);
  if (awareness <= 0) return { revealed: 0 };
  const p = awareness / 100;
  const known = knownSetFor(conflux, viewerId);
  let revealed = 0;
  for (const fact of partner?.lore || []) {
    if (!fact?.id) continue;
    if (fact.secret) continue;
    if (known.has(String(fact.id))) continue;
    if (rng() >= p) continue;
    markLoreKnown(conflux, viewerId, fact.id);
    revealed += 1;
  }
  return { revealed };
}

export function plotVisibleToRuler(plot, domainId, conflux) {
  if (!plot || isOrderPlot(plot)) return false;
  if (plot.isMainConflux) return true;
  if (plotConcerns(plot, domainId)) return true;
  const known = knownSetFor(conflux, domainId);
  return asIdList(plot.chronicleIds).some((id) => known.has(id));
}

export function localPlotsForMonth(conflux, domainId) {
  return (conflux?.plotlines || []).filter(
    (p) => !isOrderPlot(p) && !isSharedPlot(p) && plotConcerns(p, domainId),
  );
}

export function sharedPlots(conflux) {
  return (conflux?.plotlines || []).filter((p) => isSharedPlot(p));
}

export function processesForPlots(conflux, plots) {
  const ids = new Set();
  for (const p of plots || []) {
    for (const id of asIdList(p.relatedProcessIds)) ids.add(id);
  }
  return (conflux?.processes || []).filter((pr) => ids.has(String(pr.id)) && (!pr.status || pr.status === 'active'));
}

export function processesOwnedBy(conflux, domainId) {
  return (conflux?.processes || []).filter(
    (pr) => String(pr.ownerDomainId || '') === String(domainId) && (!pr.status || pr.status === 'active'),
  );
}

/**
 * Собрать рабочую доску на домене: указы остаются, нити конфлюкса — теми же объектами.
 */
export function hydrateDomainFromConflux(domain, conflux, { mode = 'month' } = {}) {
  if (!domain || !conflux) return domain;
  normalizeConfluxBoard(conflux);
  const orders = (domain.plotlines || []).filter((p) => isOrderPlot(p));
  const extra =
    mode === 'ruler'
      ? (conflux.plotlines || []).filter((p) => plotVisibleToRuler(p, domain.id, conflux))
      : localPlotsForMonth(conflux, domain.id);
  domain.plotlines = [...orders, ...extra];

  const extraIds = new Set(extra.map((p) => p.id));
  const extraProcIds = new Set();
  for (const p of extra) {
    for (const id of asIdList(p.relatedProcessIds)) extraProcIds.add(id);
  }
  const borrowed = (conflux.processes || []).filter((pr) => {
    if (extraProcIds.has(String(pr.id))) return true;
    if (mode === 'ruler' && String(pr.ownerDomainId || '') === String(domain.id)) return true;
    return false;
  });
  const local = (domain.state.pendingActions || []).filter((pr) => !pr.confluxId);
  const seen = new Set(local.map((pr) => pr.id));
  domain.state.pendingActions = [...local, ...borrowed.filter((pr) => !seen.has(pr.id))];
  domain.closedPlotlines = [
    ...(domain.closedPlotlines || []).filter((p) => isOrderPlot(p)),
    ...(conflux.closedPlotlines || []),
  ];
  return domain;
}

export function stampNewBoardItems(domain, conflux) {
  if (!domain || !conflux) return;
  const existing = new Set((conflux.plotlines || []).map((p) => p.id));
  for (const p of domain.plotlines || []) {
    if (isOrderPlot(p)) continue;
    if (!p.confluxId && !existing.has(p.id)) stampPlotOnConflux(p, conflux, domain.id);
  }
  for (const pr of domain.state?.pendingActions || []) {
    const plot = (domain.plotlines || []).find((p) => asIdList(p.relatedProcessIds).includes(String(pr.id)));
    if (plot && isOrderPlot(plot)) continue;
    if (pr.confluxId || (plot && !isOrderPlot(plot))) {
      stampProcessOnConflux(pr, conflux, domain.id);
    }
  }
}

/** Забрать нити/дела обратно на конфлюкс; на домене остаются только указы. */
export function dehydrateDomainToConflux(domain, conflux) {
  if (!domain || !conflux) return;
  normalizeConfluxBoard(conflux);
  stampNewBoardItems(domain, conflux);

  const orders = [];
  const movedPlots = [];
  for (const p of domain.plotlines || []) {
    if (isOrderPlot(p)) orders.push(p);
    else movedPlots.push(p);
  }
  domain.plotlines = orders;

  const plotById = new Map((conflux.plotlines || []).map((p) => [p.id, p]));
  for (const p of movedPlots) plotById.set(p.id, p);
  conflux.plotlines = [...plotById.values()];

  const stay = [];
  const movedProcs = [];
  for (const pr of domain.state?.pendingActions || []) {
    if (pr.confluxId) movedProcs.push(pr);
    else stay.push(pr);
  }
  domain.state.pendingActions = stay;
  const procById = new Map((conflux.processes || []).map((p) => [p.id, p]));
  for (const pr of movedProcs) procById.set(pr.id, pr);
  conflux.processes = [...procById.values()];

  const keepClosed = [];
  for (const p of domain.closedPlotlines || []) {
    if (isOrderPlot(p)) keepClosed.push(p);
    else {
      if (!conflux.closedPlotlines.some((x) => x.id === p.id)) conflux.closedPlotlines.push(p);
    }
  }
  domain.closedPlotlines = keepClosed;
}

export function takeDomainBoardIntoConflux(domain, conflux) {
  normalizeConfluxBoard(conflux);
  const keepPlots = [];
  for (const p of domain.plotlines || []) {
    if (isOrderPlot(p)) {
      keepPlots.push(p);
      continue;
    }
    stampPlotOnConflux(p, conflux, domain.id);
    conflux.plotlines.push(p);
  }
  domain.plotlines = keepPlots;

  const keepClosed = [];
  for (const p of domain.closedPlotlines || []) {
    if (isOrderPlot(p)) keepClosed.push(p);
    else {
      p.confluxId = conflux.id;
      conflux.closedPlotlines.push(p);
    }
  }
  domain.closedPlotlines = keepClosed;

  const keepProcs = [];
  const movedPlotProcIds = new Set();
  for (const p of conflux.plotlines) {
    for (const id of asIdList(p.relatedProcessIds)) movedPlotProcIds.add(id);
  }
  for (const pr of domain.state?.pendingActions || []) {
    if (movedPlotProcIds.has(String(pr.id))) {
      stampProcessOnConflux(pr, conflux, domain.id);
      conflux.processes.push(pr);
    } else keepProcs.push(pr);
  }
  domain.state.pendingActions = keepProcs;
}

export function createMainConfluxPlot({ a, b, conflux, world, config }) {
  const eta = Math.max(1, Number(conflux.etaMonths) || 1);
  const dur = Math.max(1, Number(conflux.durationMonths) || 1);
  const plot = createPlotline({
    title: `Сопряжение «${a.name}» и «${b.name}»`,
    synopsis:
      `Летающие острова городов «${a.name}» и «${b.name}» сближаются. ` +
      `Сопряжение неизбежно; встреча будет длиться, пока края снова не разойдутся.`,
    closeWhen: 'Острова разошлись в небе, пути между ними больше нет.',
    kind: 'story',
    importance: 85,
    maxAgeMonths: eta + dur + 1,
    temperature: 70,
    tick: world?.tickIndex ?? null,
    confluxId: conflux.id,
    config,
  });
  plot.isMainConflux = true;
  plot.shared = true;
  plot.hostDomainId = null;
  plot.concernsDomainIds = [a.id, b.id];
  return plot;
}

export function pushInternalChronicle(conflux, { text, world, plotIds = [], tags = [], author = 'conflux' }) {
  const fact = createLoreFact({
    id: newId('lore'),
    text: String(text || '').trim(),
    tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, ...tags],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author,
    importance: 'critical',
    relatedPlotlineIds: plotIds.length ? plotIds : null,
  });
  conflux.lore = conflux.lore || [];
  conflux.lore.push(fact);
  for (const id of plotIds) {
    const plot = (conflux.plotlines || []).find((p) => p.id === id);
    if (!plot) continue;
    plot.chronicleIds = asIdList(plot.chronicleIds);
    if (!plot.chronicleIds.includes(fact.id)) plot.chronicleIds.push(fact.id);
  }
  return fact;
}

function clonePlotForReturn(plot, domainId, ownProcessIds) {
  const copy = {
    ...plot,
    id: newId('plot'),
    confluxId: null,
    shared: false,
    isMainConflux: false,
    hostDomainId: String(domainId),
    concernsDomainIds: [String(domainId)],
    relatedProcessIds: ownProcessIds.map(String),
    title: clipPlotText(plot.title, PLOT_TITLE_MAX),
    synopsis: clipPlotText(plot.synopsis, PLOT_SUMMARY_MAX),
    partnerGone: true,
  };
  delete copy.sharedReason;
  return copy;
}

function unstampLocal(plot) {
  const next = { ...plot, confluxId: null, shared: false };
  delete next.sharedReason;
  return next;
}

/**
 * Расстыковка: shared копируются обоим (чужие дела отрезаны);
 * главная нить — только городам, у которых на ней остались процессы;
 * локальные возвращаются хозяину.
 */
export function returnBoardsOnUndock(conflux, domainsById) {
  normalizeConfluxBoard(conflux);
  const leftover = [];
  for (const plot of conflux.plotlines || []) {
    const related = asIdList(plot.relatedProcessIds);
    const procs = (conflux.processes || []).filter((pr) => related.includes(String(pr.id)));

    if (plot.isMainConflux) {
      for (const domainId of asIdList(plot.concernsDomainIds)) {
        const domain = domainsById.get(domainId);
        if (!domain) continue;
        const own = procs.filter((pr) => String(pr.ownerDomainId || '') === String(domainId));
        if (!own.length) continue;
        const copy = clonePlotForReturn(plot, domainId, own.map((p) => p.id));
        domain.plotlines = domain.plotlines || [];
        domain.plotlines.push(copy);
        for (const pr of own) {
          const next = { ...pr };
          delete next.confluxId;
          domain.state.pendingActions.push(next);
        }
      }
      leftover.push(plot);
      continue;
    }

    if (isSharedPlot(plot)) {
      for (const domainId of asIdList(plot.concernsDomainIds)) {
        const domain = domainsById.get(domainId);
        if (!domain) continue;
        const own = procs.filter((pr) => String(pr.ownerDomainId || plotHostId(plot) || '') === String(domainId));
        const copy = clonePlotForReturn(plot, domainId, own.map((p) => p.id));
        domain.plotlines = domain.plotlines || [];
        domain.plotlines.push(copy);
        for (const pr of own) {
          const next = { ...pr };
          delete next.confluxId;
          domain.state.pendingActions.push(next);
        }
      }
      leftover.push(plot);
      continue;
    }

    const hostId = plotHostId(plot);
    const host = hostId ? domainsById.get(hostId) : null;
    if (host) {
      host.plotlines = host.plotlines || [];
      host.plotlines.push(unstampLocal(plot));
      for (const pr of procs) {
        const next = { ...pr };
        delete next.confluxId;
        host.state.pendingActions.push(next);
      }
    }
  }

  for (const closed of conflux.closedPlotlines || []) {
    const hostId = plotHostId(closed) || asIdList(closed.concernsDomainIds)[0];
    const host = hostId ? domainsById.get(hostId) : null;
    if (host && !isSharedPlot(closed)) {
      host.closedPlotlines = host.closedPlotlines || [];
      host.closedPlotlines.push({ ...closed, confluxId: null });
    }
  }

  conflux.plotlines = leftover.filter((p) => p.isMainConflux);
  conflux.processes = [];
  conflux.closedPlotlines = leftover.filter((p) => p.isMainConflux).length
    ? conflux.closedPlotlines
    : [];
}

export function approachingAnnounceText(domain, partner, remaining, rematch) {
  const months = Math.max(0, Math.round(Number(remaining) || 0));
  const when =
    months <= 0
      ? 'Сопряжение уже в этом месяце.'
      : months === 1
        ? 'До сопряжения около месяца.'
        : `До сопряжения по приметам — примерно ${months} мес.`;
  return [
    `На горизонте чужой летающий остров — город «${partner.name}».`,
    'Сопряжение уже неизбежно.',
    when,
    rematch ? 'Это повторный конфлюкс: острова уже сходились раньше.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function approachMonthText(partnerName, remaining, rematch) {
  const rematchHint = rematch ? ' Это повторный конфлюкс — острова уже сходились.' : '';
  return (
    `Остров соседа («${partnerName}») ближе: в разрывах тумана уже угадывают край чужой земли. ` +
    `До сопряжения по приметам осталось около ${remaining} мес.${rematchHint}`
  );
}

export function mixedChronicleForPrompt(domains, { limit = 40 } = {}) {
  const rows = [];
  for (const domain of domains || []) {
    for (const f of domain?.lore || []) {
      if (!(f.tags || []).includes('chronicle') && f.tags?.length) continue;
      if (f.secret) continue;
      rows.push({
        tick: Number(f.tick) || 0,
        date: f.gameDateLabel || '?',
        owner: domain.name,
        text: f.text,
      });
    }
  }
  rows.sort((a, b) => a.tick - b.tick);
  return rows
    .slice(-limit)
    .map((r) => `- (${r.date}, «${r.owner}») ${r.text}`)
    .join('\n');
}

export function knownPartnerLore(partner, conflux, viewerId) {
  const known = knownSetFor(conflux, viewerId);
  return (partner?.lore || []).filter((f) => known.has(String(f.id)) && !f.secret);
}

export function otherDomainId(conflux, domainId) {
  return asIdList(conflux?.domainIds).find((id) => id !== String(domainId)) || null;
}
