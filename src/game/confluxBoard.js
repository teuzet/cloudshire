/**
 * Доска нитей пары: контейнер, ссылки на нити хозяина, возврат при расставании.
 * Карточки нитей соседа на доску города не кладём. Постоянный порядок города
 * живёт в `domain.modifiers` и на доску не попадает.
 */

import { createPlotline, refreshPlotAwareness } from './plotlines.js';
import { newId } from './ids.js';
import { createLoreFact } from './models.js';
import { attachThreat, createThreat } from './threats.js';

function asIdList(raw) {
  return [...new Set((Array.isArray(raw) ? raw : []).map(String).filter(Boolean))];
}

export function isSharedPlot(plot) {
  if (!plot) return false;
  if (plot.isMainConflux) return true;
  return asIdList(plot.concernsDomainIds).length >= 2 || Boolean(plot.shared);
}

export function plotConcerns(plot, domainId) {
  return asIdList(plot?.concernsDomainIds).includes(String(domainId));
}

export function plotHostId(plot) {
  return plot?.hostDomainId ? String(plot.hostDomainId) : asIdList(plot?.concernsDomainIds)[0] || null;
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
  if (!plot) return false;
  return activeNonIntelOwners(plot, conflux).length >= 2;
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

/**
 * Кому из городов писать хронику этого бита.
 * До стыковки чужой берег не виден: запись только хозяину дела или нити.
 */
export function chronicleReceiversForBeat(conflux, plot, beat, domains) {
  const list = domains || [];
  if (conflux?.status === 'docked') {
    return list.filter((d) => plot?.isMainConflux || plotConcerns(plot, d.id));
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

export function sharePlotWithDomain(plot, domainId, { reason = 'process', day = null, how = null } = {}) {
  if (!plot) return plot;
  const id = String(domainId);
  plot.concernsDomainIds = asIdList(plot.concernsDomainIds);
  if (!plot.concernsDomainIds.includes(id)) plot.concernsDomainIds.push(id);
  if (plot.concernsDomainIds.length >= 2 || plot.isMainConflux) {
    plot.shared = true;
    plot.sharedReason = reason;
  }
  plot.learnedBy = Array.isArray(plot.learnedBy) ? plot.learnedBy : [];
  if (!plot.learnedBy.some((row) => String(row.domainId) === id)) {
    plot.learnedBy.push({
      domainId: id,
      day: day != null ? Math.round(Number(day) || 0) : null,
      how: how || reason,
    });
  }
  return plot;
}

export function stampPlotOnConflux(plot, conflux, domainId) {
  if (!plot) return plot;
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

function confluxPlotIds(conflux) {
  const ids = new Set();
  for (const p of [...(conflux?.plotlines || []), ...(conflux?.closedPlotlines || [])]) {
    if (p?.id) ids.add(String(p.id));
  }
  return ids;
}

function confluxRelatedProcessIds(conflux) {
  const ids = new Set();
  for (const p of [...(conflux?.plotlines || []), ...(conflux?.closedPlotlines || [])]) {
    for (const id of asIdList(p.relatedProcessIds)) ids.add(id);
  }
  return ids;
}

/** Дело принадлежит уехавшей нити — открытой или уже закрытой. */
export function processBelongsOnConflux(process, conflux) {
  if (!process || !conflux) return false;
  if (process.confluxId && String(process.confluxId) === String(conflux.id)) return true;
  if (confluxRelatedProcessIds(conflux).has(String(process.id))) return true;
  if (process.plotlineId && confluxPlotIds(conflux).has(String(process.plotlineId))) return true;
  return false;
}

export function normalizeConfluxBoard(conflux) {
  if (!conflux || typeof conflux !== 'object') return conflux;
  if (!Array.isArray(conflux.plotlines)) conflux.plotlines = [];
  if (!Array.isArray(conflux.plotRefs)) conflux.plotRefs = [];
  if (!conflux.passage || typeof conflux.passage !== 'object') {
    conflux.passage = {
      text: '',
      state: 'open',
      contact: conflux.contact || null,
      relief: conflux.contact?.relief || null,
    };
  }
  if (conflux.container == null) conflux.container = null;
  if (!Array.isArray(conflux.closedPlotlines)) conflux.closedPlotlines = [];
  if (!Array.isArray(conflux.processes)) conflux.processes = [];
  if (!Array.isArray(conflux.lore)) conflux.lore = [];
  if (conflux.mainPlotId == null) conflux.mainPlotId = null;
  if (!conflux.forecast || typeof conflux.forecast !== 'object') conflux.forecast = {};
  if (!conflux.synopsis || typeof conflux.synopsis !== 'object') conflux.synopsis = {};
  if (!conflux.quiet || typeof conflux.quiet !== 'object') {
    conflux.quiet = { nextAttemptDay: null, cooldownUntilDay: null };
  }
  if (conflux.container) clearPairEndings(conflux.container);
  return conflux;
}

export function sharedPlots(conflux) {
  return (conflux?.plotlines || []).filter((p) => isSharedPlot(p));
}

/**
 * Нити лежат у хозяина. На время хода правителя поверх домена виден только
 * контейнер пары — карточки нитей соседа на доску не кладём.
 */
export function overlayConfluxView(domain, conflux, partner = null) {
  if (!domain || !conflux) return domain;
  void partner;
  normalizeConfluxBoard(conflux);
  const extra = [];
  const seen = new Set((domain.plotlines || []).map((p) => p?.id).filter(Boolean));
  const add = (plot) => {
    if (!plot?.id || seen.has(plot.id)) return;
    extra.push(plot);
    seen.add(plot.id);
  };
  if (conflux.container) {
    const syn = conflux.synopsis?.[domain.id];
    add({
      ...conflux.container,
      synopsis: syn || conflux.container.synopsis,
      endings: [],
      threats: [],
    });
  }
  for (const p of conflux.plotlines || []) {
    if (p?.isMainConflux) add(p);
  }
  domain._confluxOverlayIds = extra.map((p) => p.id);
  domain.plotlines = [...(domain.plotlines || []), ...extra];
  return domain;
}

export function stripConfluxView(domain) {
  if (!domain) return domain;
  const overlay = new Set(domain._confluxOverlayIds || []);
  if (overlay.size) {
    domain.plotlines = (domain.plotlines || []).filter((p) => !overlay.has(p.id));
  }
  delete domain._confluxOverlayIds;
  return domain;
}

export function stampNewBoardItems(domain, conflux) {
  if (!domain || !conflux) return;
  normalizeConfluxBoard(conflux);
  const overlay = new Set(domain._confluxOverlayIds || []);
  const refs = conflux.plotRefs || [];
  for (const p of domain.plotlines || []) {
    if (!p?.id || overlay.has(p.id)) continue;
    stampPlotOnConflux(p, conflux, domain.id);
    if (!refs.some((r) => r.plotId === p.id)) {
      refs.push({ plotId: p.id, hostDomainId: domain.id });
    }
  }
  conflux.plotRefs = refs;
  for (const pr of domain.state?.pendingActions || []) {
    const plot = (domain.plotlines || []).find((p) => asIdList(p.relatedProcessIds).includes(String(pr.id)));
    if (pr.confluxId || plot) stampProcessOnConflux(pr, conflux, domain.id);
  }
}

export async function overlayWithPartner(storage, domain, conflux) {
  if (!domain || !conflux) return { partner: null };
  const partnerId = otherDomainId(conflux, domain.id);
  const partner = partnerId && storage ? await storage.getDomain(partnerId) : null;
  overlayConfluxView(domain, conflux, partner);
  return { partner };
}

export function takeDomainBoardIntoConflux(domain, conflux) {
  normalizeConfluxBoard(conflux);
  stampNewBoardItems(domain, conflux);
}

export function createEmptyContainer({ a, b, conflux, world, config }) {
  const plot = createPlotline({
    title: `Сопряжение «${a.name}» и «${b.name}»`,
    synopsis:
      `Летающие острова городов «${a.name}» и «${b.name}» сошлись. ` +
      `Что из этого выйдет — решат дела людей на проходе.`,
    closeWhen: PAIR_CLOSE_WHEN,
    kind: 'story',
    storyType: 'freeform',
    isMainConflux: true,
    maxAgeMonths: 4,
    temperature: 70,
    tick: world?.tickIndex ?? null,
    confluxId: conflux.id,
    config,
  });
  plot.shared = true;
  plot.hostDomainId = null;
  plot.concernsDomainIds = [a.id, b.id];
  plot.crystallized = false;
  plot.endings = [];
  plot.threats = [];
  plot.maxDepth = 0;
  plot.gravity = null;
  if (!plot.stats || typeof plot.stats !== 'object') plot.stats = {};
  plot.stats.budget = 0;
  plot.stats.remaining = 0;
  refreshPlotAwareness(plot);
  return plot;
}

export const PARTING_ENDING_ID = 'end_parting';
export const PARTING_EVENT = 'parting';
export const PAIR_CLOSE_WHEN = 'Острова разошлись в небе, пути между ними больше нет.';
export const PARTING_THREAT_TEXT = 'Острова разойдутся, и всё вернётся как было.';
export const DOCK_MEET_EVENT = 'dock_meet';
export const DOCK_MEET_TEXT = 'Острова сошлись.';

/**
 * Часы расставания: обязательство мира со сроком на конец стыковки.
 *
 * Раньше к ним прилагалась ещё и «нейтральная концовка разъезда», а само
 * обязательство искали по её id. Концовкой она не была: у сопряжения нет
 * исходов на выбор, оно кончается по часам, а чем именно кончилось — это
 * накопленное к тому дню, и его собирает финальная хроника из прогноза.
 * Концовку сняли, часы остались, и ищутся они теперь по своему событию.
 */
export function seedPartingClock(plot, { day = 0, dockEndDay } = {}) {
  if (!plot) return null;
  clearPairEndings(plot);
  const existing = findPartingThreat(plot);
  if (existing) {
    existing.eventKind = PARTING_EVENT;
    if (dockEndDay != null) existing.dueDay = Math.round(Number(dockEndDay));
    return existing;
  }
  const due = dockEndDay != null ? Math.round(Number(dockEndDay)) : Math.round(Number(day) || 0) + 1;
  return attachThreat(
    plot,
    createThreat({
      plot,
      text: PARTING_THREAT_TEXT,
      outcome: 'neutral',
      valence: 'neutral',
      known: true,
      day,
      dueDay: due,
      eventKind: PARTING_EVENT,
      band: 'YEAR',
    }),
  );
}

/** Сейвы со старыми часами держат их на id снятой концовки. */
export function findPartingThreat(plot) {
  return (
    (plot?.threats || []).find(
      (t) => t?.eventKind === PARTING_EVENT || t?.endingId === PARTING_ENDING_ID,
    ) || null
  );
}

/**
 * Сопряжение живёт без списка концовок. Старые сейвы держат их с тех пор,
 * когда кристаллизация раздавала исходы по номеру в массиве, поэтому чистим
 * при каждой нормализации доски, а не только при заводе часов.
 */
function clearPairEndings(plot) {
  plot.endings = [];
  plot.closeWhen = PAIR_CLOSE_WHEN;
}

/** Обязательство стыковки: по нему пишутся первая хроника и описание прохода. */
export function seedDockMeet(plot, { day = 0 } = {}) {
  if (!plot) return null;
  const existing = (plot.threats || []).find((t) => t.eventKind === DOCK_MEET_EVENT);
  if (existing) return existing;
  return attachThreat(
    plot,
    createThreat({
      plot,
      text: DOCK_MEET_TEXT,
      outcome: 'neutral',
      valence: 'neutral',
      known: true,
      day,
      dueDay: Math.round(Number(day) || 0),
      band: 'DAYS',
      eventKind: DOCK_MEET_EVENT,
    }),
  );
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

/**
 * Расстыковка: нити остаются у хозяина, второй город уходит из concerns.
 * Судья keep/drop решает, жива ли общая нить без соседа.
 */
export async function returnBoardsOnUndock(conflux, domainsById, { decideContinuation = null } = {}) {
  normalizeConfluxBoard(conflux);
  const decide =
    decideContinuation ||
    (async ({ plot, domainId }) => plotHostId(plot) === String(domainId) || plotConcerns(plot, domainId));

  for (const domain of domainsById.values()) {
    if (!domain) continue;
    const kept = [];
    for (const plot of domain.plotlines || []) {
      if (plot?.isMainConflux || plot?.id === conflux.container?.id) continue;
      const concerns = asIdList(plot.concernsDomainIds);
      const shared = concerns.length >= 2 || plot.shared;
      if (plot.confluxId === conflux.id || shared) {
        const hostId = plotHostId(plot) || domain.id;
        if (shared) {
          const keep = await decide({ plot, domainId: domain.id, domain, conflux });
          if (!keep && String(hostId) !== String(domain.id)) continue;
        }
        plot.concernsDomainIds = [String(hostId)];
        plot.shared = false;
        delete plot.sharedReason;
        plot.confluxId = null;
        refreshPlotAwareness(plot);
      }
      kept.push(plot);
    }
    domain.plotlines = kept;
    for (const pr of domain.state?.pendingActions || []) {
      if (pr.confluxId === conflux.id) delete pr.confluxId;
    }
  }

  if (conflux.container) {
    conflux.container.crystallized = conflux.container.crystallized || false;
    conflux.closedPlotlines = conflux.closedPlotlines || [];
    conflux.closedPlotlines.push(conflux.container);
    conflux.container = null;
  }
  conflux.plotlines = [];
  conflux.processes = [];
  conflux.plotRefs = [];
}

export function approachingAnnounceText(domain, partner, remaining, rematch) {
  const days = Number(remaining);
  const when =
    remaining == null || remaining === ''
      ? ''
      : Number.isFinite(days)
        ? days <= 0
          ? 'Сопряжение уже в эту пору.'
          : days === 1
            ? 'До сопряжения день.'
            : `До сопряжения примерно ${Math.round(days)} дн.`
        : `До сопряжения ${remaining}.`;
  return [
    `На горизонте чужой летающий остров — город «${partner.name}».`,
    'Сопряжение уже неизбежно.',
    when,
    rematch ? 'Это повторный конфлюкс: острова уже сходились раньше.' : '',
  ]
    .filter(Boolean)
    .join(' ');
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

export function otherDomainId(conflux, domainId) {
  return asIdList(conflux?.domainIds).find((id) => id !== String(domainId)) || null;
}
