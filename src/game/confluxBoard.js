/**
 * Доска нитей и дел на конфлюксе: перевод с городов, видимость, просачивание, возврат.
 * Указы (kind: order) остаются на домене.
 */

import { createPlotline, isOrderPlot, clipPlotText, plotScale, PLOT_SUMMARY_MAX, PLOT_TITLE_MAX, refreshPlotAwareness } from './plotlines.js';
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

export function cityKnowsPlot(plot, domainId) {
  if (!plot || isOrderPlot(plot)) return false;
  refreshPlotAwareness(plot);
  const id = String(domainId);
  if (plot.isMainConflux) return true;
  if (plot.plotAwareness?.[id]) return true;
  if (plotHostId(plot) === id) return true;
  return false;
}

export function grantPlotAwareness(plot, domainId, conflux = null, domains = []) {
  if (!plot || isOrderPlot(plot)) return plot;
  refreshPlotAwareness(plot);
  const id = String(domainId);
  plot.plotAwareness[id] = true;
  if (conflux) backfillPlotChronicles(plot, id, conflux, domains);
  return plot;
}

function plotFacts(plot, conflux, domains = []) {
  const ids = new Set(asIdList(plot?.chronicleIds));
  const bags = [conflux?.lore, ...(domains || []).map((d) => d?.lore)];
  const out = [];
  const seen = new Set();
  for (const lore of bags) {
    for (const fact of lore || []) {
      if (!fact?.id) continue;
      const fid = String(fact.id);
      if (seen.has(fid)) continue;
      if (ids.has(fid) || String(fact.sourcePlotId || '') === String(plot.id)) {
        if (fact.secret) continue;
        seen.add(fid);
        out.push(fact);
      }
    }
  }
  return out;
}

export function backfillPlotChronicles(plot, domainId, conflux, domains = []) {
  normalizeConfluxBoard(conflux);
  const viewer = (domains || []).find((d) => String(d.id) === String(domainId));
  const alreadyKnown = knownSetFor(conflux, domainId);
  const hostId = plotHostId(plot);
  for (const fact of plotFacts(plot, conflux, domains)) {
    if (fact.secret) continue;
    const wasKnown = alreadyKnown.has(String(fact.id));
    markLoreKnown(conflux, domainId, fact.id);
    if (!viewer || String(viewer.id) === String(hostId)) continue;
    if (wasKnown) continue;
    const already = (viewer.lore || []).some(
      (f) => String(f.id) === String(fact.id) || String(f.leakedFromId || '') === String(fact.id),
    );
    if (already) continue;
    viewer.lore = viewer.lore || [];
    const copy = createLoreFact({
      id: newId('lore'),
      text: fact.text,
      tags: ['chronicle', 'conflux-backfill'],
      gameDateLabel: fact.gameDateLabel,
      tick: fact.tick,
      author: 'conflux-backfill',
      importance: fact.importance || 'minor',
      sourcePlotId: plot.id,
      relatedPlotlineIds: [plot.id],
      plotClosed: Boolean(fact.plotClosed),
      plotCloseReason: fact.plotCloseReason || null,
    });
    copy.leakedFromId = fact.id;
    viewer.lore.push(copy);
  }
}

export function allPlotChroniclesKnown(plot, conflux, domainId) {
  const ids = asIdList(plot?.chronicleIds);
  if (!ids.length) return false;
  const known = knownSetFor(conflux, domainId);
  return ids.every((id) => known.has(id));
}

export function maybeGrantAwarenessFromKnownLore(conflux, domains = []) {
  normalizeConfluxBoard(conflux);
  let granted = 0;
  for (const plot of conflux.plotlines || []) {
    if (isOrderPlot(plot)) continue;
    for (const domain of domains) {
      if (cityKnowsPlot(plot, domain.id)) continue;
      if (!allPlotChroniclesKnown(plot, conflux, domain.id)) continue;
      grantPlotAwareness(plot, domain.id, conflux, domains);
      granted += 1;
    }
  }
  return granted;
}

export function activeNonIntelOwners(plot, conflux) {
  const related = new Set(asIdList(plot?.relatedProcessIds));
  const owners = new Set();
  for (const pr of conflux?.processes || []) {
    if (!related.has(String(pr.id))) continue;
    if (pr.status && pr.status !== 'active') continue;
    if (pr.intel) continue;
    const owner = String(pr.ownerDomainId || plotHostId(plot) || '');
    if (owner) owners.add(owner);
  }
  return [...owners];
}

/** Derived: два города реально действуют в нити (не разведка). */
export function isContested(plot, conflux) {
  if (!plot || isOrderPlot(plot)) return false;
  return activeNonIntelOwners(plot, conflux).length >= 2;
}

export function contestedPlots(conflux) {
  return (conflux?.plotlines || []).filter((p) => isContested(p, conflux));
}

export function confluxMonthPlots(conflux) {
  return (conflux?.plotlines || []).filter((p) => {
    if (isOrderPlot(p)) return false;
    return Boolean(p.isMainConflux) || isContested(p, conflux);
  });
}

export function nativePlotsForMonth(conflux, domainId) {
  const id = String(domainId);
  return (conflux?.plotlines || []).filter((p) => {
    if (isOrderPlot(p)) return false;
    if (p.isMainConflux) return false;
    if (isContested(p, conflux)) return false;
    return plotHostId(p) === id;
  });
}

export function findPlotByChronicleId(conflux, chronicleId, domains = []) {
  const id = String(chronicleId || '');
  if (!id) return null;
  for (const plot of conflux?.plotlines || []) {
    if (asIdList(plot.chronicleIds).includes(id)) return plot;
  }
  for (const lore of [conflux?.lore, ...(domains || []).map((d) => d?.lore)]) {
    const fact = (lore || []).find((f) => String(f.id) === id || String(f.leakedFromId || '') === id);
    if (!fact) continue;
    const source = String(fact.sourcePlotId || fact.relatedPlotlineIds?.[0] || '');
    if (!source) continue;
    const plot = (conflux?.plotlines || []).find((p) => p.id === source);
    if (plot) return plot;
  }
  return null;
}

export function leakedTracesForViewer(conflux, viewerId, domains = []) {
  normalizeConfluxBoard(conflux);
  const known = knownSetFor(conflux, viewerId);
  const traces = [];
  const seen = new Set();
  const consider = [];
  for (const d of domains || []) {
    if (String(d.id) === String(viewerId)) {
      for (const f of d?.lore || []) {
        if (f?.sourcePlotId || (f.tags || []).includes('leaked')) consider.push(f);
      }
    } else {
      for (const f of d?.lore || []) {
        if (known.has(String(f.id)) && !f.secret) consider.push(f);
      }
    }
  }
  for (const fact of consider) {
    const plot =
      findPlotByChronicleId(conflux, fact.leakedFromId || fact.id, domains) ||
      ((conflux.plotlines || []).find((p) => p.id === fact.sourcePlotId) || null);
    if (!plot || isOrderPlot(plot) || cityKnowsPlot(plot, viewerId)) continue;
    const key = `${plot.id}:${fact.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    traces.push({
      chronicleId: fact.id,
      text: fact.text,
      plotId: plot.id,
      plotHidden: true,
    });
  }
  return traces;
}

export function takeIntelOffer(conflux, viewerId, key) {
  normalizeConfluxBoard(conflux);
  const id = String(viewerId);
  const k = String(key);
  const list = conflux.intelOffers[id] || [];
  if (list.includes(k)) return false;
  list.push(k);
  conflux.intelOffers[id] = list;
  return true;
}

export function copyChronicleToAwareCities({ plot, fact, conflux, domains, author = 'conflux-flow' }) {
  if (!plot || !fact) return [];
  const added = [];
  const hostId = plotHostId(plot);
  for (const domain of domains || []) {
    if (!cityKnowsPlot(plot, domain.id)) continue;
    if (hostId && String(domain.id) === String(hostId)) continue;
    const already = (domain.lore || []).some(
      (f) => String(f.leakedFromId || '') === String(fact.id) || (f.sourcePlotId === plot.id && f.text === fact.text && Number(f.tick) === Number(fact.tick)),
    );
    if (already) continue;
    domain.lore = domain.lore || [];
    const copy = createLoreFact({
      id: newId('lore'),
      text: fact.text,
      tags: ['chronicle', 'conflux', `conflux:${conflux.id}`, 'aware-flow'],
      gameDateLabel: fact.gameDateLabel,
      tick: fact.tick,
      author,
      importance: fact.importance || 'minor',
      sourcePlotId: plot.id,
      relatedPlotlineIds: [plot.id],
      plotClosed: Boolean(fact.plotClosed),
      plotCloseReason: fact.plotCloseReason || null,
    });
    domain.lore.push(copy);
    markLoreKnown(conflux, domain.id, fact.id);
    added.push({ domainId: domain.id, fact: copy });
  }
  return added;
}

/**
 * Кому из городов писать хронику этого бита.
 * До стыковки чужой берег не виден: запись только хозяину дела или нити.
 */
export function chronicleReceiversForBeat(conflux, plot, beat, domains) {
  const list = domains || [];
  const aware = list.filter((d) => cityKnowsPlot(plot, d.id));
  if (conflux?.status === 'docked') {
    return aware.length ? aware : list.filter((d) => plot?.isMainConflux || plotConcerns(plot, d.id));
  }

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

export function sharePlotWithDomain(plot, domainId, { reason = 'process', conflux = null, domains = [] } = {}) {
  if (!plot || isOrderPlot(plot)) return plot;
  const id = String(domainId);
  plot.concernsDomainIds = asIdList(plot.concernsDomainIds);
  if (!plot.concernsDomainIds.includes(id)) plot.concernsDomainIds.push(id);
  if (plot.concernsDomainIds.length >= 2 || plot.isMainConflux) {
    plot.shared = true;
    plot.sharedReason = reason;
  }
  grantPlotAwareness(plot, id, conflux, domains);
  return plot;
}

/**
 * Голая хроника соседу: без карточки сюжета. Полное знание — только если известны все записи нити.
 */
export function maybeLeakChronicle({ plot, fact, conflux, viewerId, viewerDomain = null, domains = [], rng = Math.random } = {}) {
  if (!plot || !fact || isOrderPlot(plot)) return false;
  if (conflux?.status !== 'docked') return false;
  if (cityKnowsPlot(plot, viewerId)) return false;
  const chance = leakChanceFromImportance(plotScale(plot), averageAwareness(conflux));
  if (chance <= 0 || rng() >= chance) return false;
  markLoreKnown(conflux, viewerId, fact.id);
  if (viewerDomain) {
    viewerDomain.lore = viewerDomain.lore || [];
    const exists = viewerDomain.lore.some(
      (f) => String(f.id) === String(fact.id) || String(f.leakedFromId || '') === String(fact.id),
    );
    if (!exists) {
      const copy = createLoreFact({
        id: newId('lore'),
        text: fact.text,
        tags: ['chronicle', 'leaked', `conflux:${conflux.id}`],
        gameDateLabel: fact.gameDateLabel,
        tick: fact.tick,
        author: 'conflux-leak',
        importance: 'minor',
        sourcePlotId: plot.id,
        plotClosed: Boolean(fact.plotClosed),
        plotCloseReason: fact.plotCloseReason || null,
      });
      copy.leakedFromId = fact.id;
      viewerDomain.lore.push(copy);
    }
  }
  if (allPlotChroniclesKnown(plot, conflux, viewerId)) {
    const all = [...new Set([...(domains || []), viewerDomain].filter(Boolean))];
    grantPlotAwareness(plot, viewerId, conflux, all);
  }
  return true;
}

/** Совместимость: бросок «просочится ли что-то», без шаринга карточки. */
export function maybeLeakPlot(plot, conflux, otherDomainId, rng = Math.random) {
  if (!plot || isOrderPlot(plot)) return false;
  if (conflux?.status !== 'docked') return false;
  if (cityKnowsPlot(plot, otherDomainId)) return false;
  const chance = leakChanceFromImportance(plotScale(plot), averageAwareness(conflux));
  return chance > 0 && rng() < chance;
}

export function stampPlotOnConflux(plot, conflux, domainId) {
  if (!plot || isOrderPlot(plot)) return plot;
  plot.confluxId = conflux.id;
  plot.hostDomainId = plot.hostDomainId || String(domainId);
  plot.concernsDomainIds = asIdList(plot.concernsDomainIds);
  if (!plot.concernsDomainIds.length) plot.concernsDomainIds = [String(domainId)];
  plot.shared = isSharedPlot(plot);
  plot.isMainConflux = Boolean(plot.isMainConflux);
  refreshPlotAwareness(plot);
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
  if (!conflux.intelOffers || typeof conflux.intelOffers !== 'object') conflux.intelOffers = {};
  if (!Array.isArray(conflux.plotlines)) conflux.plotlines = [];
  if (!Array.isArray(conflux.closedPlotlines)) conflux.closedPlotlines = [];
  if (!Array.isArray(conflux.processes)) conflux.processes = [];
  if (!Array.isArray(conflux.lore)) conflux.lore = [];
  for (const id of asIdList(conflux.domainIds)) {
    if (!Number.isFinite(Number(conflux.awareness[id]))) conflux.awareness[id] = 0;
    if (!Array.isArray(conflux.knownLoreIds[id])) conflux.knownLoreIds[id] = [];
    if (!Array.isArray(conflux.intelOffers[id])) conflux.intelOffers[id] = [];
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
  void conflux;
  return cityKnowsPlot(plot, domainId);
}

export function localPlotsForMonth(conflux, domainId) {
  return nativePlotsForMonth(conflux, domainId);
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
  const closedIds = new Set((conflux.closedPlotlines || []).map((p) => p?.id).filter(Boolean));
  const orders = (domain.plotlines || []).filter((p) => isOrderPlot(p));
  const extra = (
    mode === 'ruler'
      ? (conflux.plotlines || []).filter((p) => plotVisibleToRuler(p, domain.id, conflux))
      : localPlotsForMonth(conflux, domain.id)
  ).filter((p) => p && !closedIds.has(p.id));
  const seenPlots = new Set(orders.map((p) => p.id));
  domain.plotlines = [...orders, ...extra.filter((p) => !seenPlots.has(p.id))];

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

  const closedById = new Map();
  for (const p of conflux.closedPlotlines || []) {
    if (p?.id) closedById.set(p.id, p);
  }
  for (const p of domain.closedPlotlines || []) {
    if (isOrderPlot(p)) continue;
    if (!p?.id) continue;
    closedById.set(p.id, p);
  }
  conflux.closedPlotlines = [...closedById.values()];
  const skipOpen = new Set(closedById.keys());

  const plotById = new Map();
  for (const p of conflux.plotlines || []) {
    if (!p?.id || skipOpen.has(p.id) || p.status === 'closed') continue;
    plotById.set(p.id, p);
  }
  for (const p of movedPlots) {
    if (!p?.id || skipOpen.has(p.id) || p.status === 'closed') continue;
    plotById.set(p.id, p);
  }
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
  domain.closedPlotlines = (domain.closedPlotlines || []).filter((p) => isOrderPlot(p));
}

export function takeDomainBoardIntoConflux(domain, conflux) {
  normalizeConfluxBoard(conflux);
  const keepPlots = [];
  const existingPlotIds = new Set((conflux.plotlines || []).map((p) => p.id));
  for (const p of domain.plotlines || []) {
    if (isOrderPlot(p)) {
      keepPlots.push(p);
      continue;
    }
    stampPlotOnConflux(p, conflux, domain.id);
    if (!existingPlotIds.has(p.id)) {
      conflux.plotlines.push(p);
      existingPlotIds.add(p.id);
    }
  }
  domain.plotlines = keepPlots;

  const keepClosed = [];
  for (const p of domain.closedPlotlines || []) {
    if (isOrderPlot(p)) keepClosed.push(p);
    else {
      p.confluxId = conflux.id;
      if (!conflux.closedPlotlines.some((x) => x.id === p.id)) conflux.closedPlotlines.push(p);
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
      if (!conflux.processes.some((x) => x.id === pr.id)) conflux.processes.push(pr);
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
    storyType: 'freeform',
    isMainConflux: true,
    importance: 85,
    maxAgeMonths: eta + dur + 1,
    temperature: 70,
    tick: world?.tickIndex ?? null,
    confluxId: conflux.id,
    config,
  });
  plot.shared = true;
  plot.hostDomainId = null;
  plot.concernsDomainIds = [a.id, b.id];
  refreshPlotAwareness(plot);
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
    plotAwareness: { [String(domainId)]: true },
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
  refreshPlotAwareness(next);
  return next;
}

function returnOwnProcesses(domain, procs) {
  domain.state.pendingActions = domain.state.pendingActions || [];
  for (const pr of procs) {
    const next = { ...pr };
    delete next.confluxId;
    domain.state.pendingActions.push(next);
  }
}

/**
 * Расстыковка: нераскрытая нить городу не отдаётся;
 * раскрытая — только если предпосылка может жить здесь без соседа.
 * Главная нить встречи — только городам с живыми делами на ней.
 */
export async function returnBoardsOnUndock(conflux, domainsById, { decideContinuation = null } = {}) {
  normalizeConfluxBoard(conflux);
  const leftover = [];
  const cityIds = asIdList(conflux.domainIds);
  const decide =
    decideContinuation ||
    (async ({ plot, domainId }) => cityKnowsPlot(plot, domainId));

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
        returnOwnProcesses(domain, own);
      }
      leftover.push(plot);
      continue;
    }

    for (const domainId of cityIds) {
      const domain = domainsById.get(domainId);
      if (!domain) continue;
      const own = procs.filter((pr) => String(pr.ownerDomainId || '') === String(domainId));
      if (!cityKnowsPlot(plot, domainId)) {
        returnOwnProcesses(domain, own);
        continue;
      }
      const keep = await decide({ plot, domainId, domain, conflux });
      if (!keep) {
        returnOwnProcesses(domain, own);
        continue;
      }
      const copy = clonePlotForReturn(plot, domainId, own.map((p) => p.id));
      domain.plotlines = domain.plotlines || [];
      domain.plotlines.push(copy);
      returnOwnProcesses(domain, own);
    }
    leftover.push(plot);
  }

  for (const closed of conflux.closedPlotlines || []) {
    const hostId = plotHostId(closed) || asIdList(closed.concernsDomainIds)[0];
    const host = hostId ? domainsById.get(hostId) : null;
    if (host && cityKnowsPlot(closed, hostId) && !isSharedPlot(closed)) {
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

/** Успех targeted-intel: карточка открывается; лестницу и тайну не двигаем. CRITICAL = SUCCESS. */
export function applyIntelFinishes({ conflux, domains = [], world, outcomes = [] }) {
  const adds = [];
  for (const o of outcomes || []) {
    if (!o?.intel || !o.finished) continue;
    const plot =
      (conflux.plotlines || []).find((p) => p.id === o.plotlineId) ||
      (conflux.plotlines || []).find((p) => asIdList(p.relatedProcessIds).includes(String(o.processId)));
    const owner = (domains || []).find((d) => String(d.id) === String(o.ownerDomainId));
    if (!owner) continue;
    const success = o.finish === 'ok' || o.finish === 'crit';
    if (success && plot) grantPlotAwareness(plot, owner.id, conflux, domains);
    const text =
      success && plot
        ? `Лазутчики собрали связную картину: «${plot.title}». ${String(plot.synopsis || '').trim()}`.trim()
        : 'Лазутчики не собрали ясной картины.';
    const fact = createLoreFact({
      id: newId('lore'),
      text,
      tags: ['chronicle', 'intel', `conflux:${conflux.id}`],
      gameDateLabel: world?.gameDate?.label,
      tick: world?.tickIndex,
      author: 'conflux-intel',
      importance: success ? 'major' : 'minor',
      sourcePlotId: plot?.id || null,
      relatedPlotlineIds: success && plot ? [plot.id] : null,
      processFinish: o.finish || null,
      relatedPendingId: o.processId || null,
    });
    owner.lore = owner.lore || [];
    owner.lore.push(fact);
    if (success && plot) {
      plot.chronicleIds = asIdList(plot.chronicleIds);
      if (!plot.chronicleIds.includes(fact.id)) plot.chronicleIds.push(fact.id);
    }
    adds.push({ domainId: owner.id, fact });
  }
  return adds;
}
