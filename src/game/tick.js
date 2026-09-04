import { advanceGameDate, filterChronicleForDomain, normalizeDomain } from './models.js';
import { ageDomainPeople } from './ages.js';
import {
  processConfluxApproachingPhase,
  advanceDockedConfluxes,
  maybeMatchmakeConfluxes,
  advanceConfluxLifetimeCounters,
  monthsUntilDock,
} from './conflux.js';
import { resolveDomainMonth } from './monthResolve.js';
import { scoreConfluxAwareness } from './confluxAwareness.js';
import { resolveConfluxSharedMonth } from './confluxMonth.js';
import {
  normalizeConfluxBoard,
  revealKnownLore,
  otherDomainId,
  maybeGrantAwarenessFromKnownLore,
} from './confluxBoard.js';
import { releaseInactiveProcessesFromOpenPlots } from './plotlines.js';
import { resolveIslandImage } from './islandImage.js';
import { getLogger } from '../log.js';
import { shouldSendTickNews, splitTickNews } from './newsSchedule.js';

/** Игровая дата шапкой у письма месяца (только в отправке, не в dialogHistory). */
function withDateHeader(text, world) {
  const label = world?.gameDate?.label;
  if (!label) return text;
  return `— ${label} —\n\n${text}`;
}

function withoutSeed(entries) {
  return (entries || []).filter((f) => !(f.tags || []).includes('seed'));
}

export async function runWorldTick({ config, runtime, storage, app }) {
  app?.beginWorldTick?.();
  try {
    return await runWorldTickInner({ config, runtime, storage, app });
  } finally {
    app?.endWorldTick?.();
  }
}

export async function emitConfluxAnnouncements({ app, storage, items }) {
  const world = await storage.getWorld();
  for (const item of items || []) {
    const announce = item?.announce;
    if (!announce) continue;
    const conflux = item.confluxId ? await storage.getConflux(item.confluxId).catch(() => null) : null;
    const otherIds = Object.keys(announce);
    for (const [domainId, text] of Object.entries(announce)) {
      const domain = await storage.getDomain(domainId);
      if (!domain?.ownerUserId || !text) continue;
      const partnerId =
        (conflux ? otherDomainId(conflux, domainId) : null) ||
        otherIds.find((id) => id !== domainId) ||
        null;
      const partner = partnerId ? await storage.getDomain(partnerId) : null;
      const remaining =
        conflux && world ? monthsUntilDock(conflux, world) : item.etaMonths;
      const letter = await app.narrateConfluxSighting(domain, {
        kind: 'announce',
        fact: text,
        partnerName: partner?.name || null,
        remaining,
        rematch: Boolean(item.rematch || conflux?.rematch),
      });
      await app.persistDialog(domain, 'assistant', letter, { kind: 'conflux_announce' });
      await app.emitOutbound(domain.ownerUserId, withDateHeader(letter, world), {
        agent: 'ruler',
        domainId: domain.id,
        kind: 'conflux_announce',
      });
    }
  }
}

async function emitApproachPhotos({ app, storage, config, notes }) {
  const world = await storage.getWorld();
  for (const note of notes || []) {
    if (!note?.photoSoon || !note.confluxId) continue;
    const conflux = await storage.getConflux(note.confluxId);
    if (!conflux) continue;
    for (const domainId of conflux.domainIds || []) {
      const domain = await storage.getDomain(domainId);
      const partnerId = otherDomainId(conflux, domainId);
      const partner = partnerId ? await storage.getDomain(partnerId) : null;
      if (!domain?.ownerUserId || !partner) continue;
      const remaining = monthsUntilDock(conflux, world);
      const fact = `Чужой остров «${partner.name}» уже близко — до сопряжения около месяца.`;
      const letter = await app.narrateConfluxSighting(domain, {
        kind: 'approach',
        fact,
        partnerName: partner.name,
        remaining,
        rematch: Boolean(conflux.rematch),
      });
      const picture = await resolveIslandImage({ domain: partner, config });
      await app.persistDialog(domain, 'assistant', letter, { kind: 'conflux_approach' });
      await app.emitOutbound(domain.ownerUserId, withDateHeader(letter, world), {
        agent: 'ruler',
        domainId: domain.id,
        kind: 'conflux_approach',
        photoUrl: partner.imageUrl || null,
        photoPath: picture?.abs || null,
        photoBuffer: picture?.buffer || null,
      });
    }
  }
}

async function runWorldTickInner({ config, runtime, storage, app }) {
  const world = await storage.getWorld();
  advanceGameDate(world);
  await storage.saveWorld(world);

  const matchmake = await maybeMatchmakeConfluxes({ config, storage, world });
  await emitConfluxAnnouncements({ app, storage, items: matchmake.notes });

  const confluxPhase = await processConfluxApproachingPhase({
    config,
    runtime,
    storage,
    world,
  });
  await emitApproachPhotos({
    app,
    storage,
    config,
    notes: confluxPhase.notes,
  });
  await advanceConfluxLifetimeCounters({ storage, world });

  const domains = await storage.listDomains();
  for (const domain of domains) {
    ageDomainPeople(domain, world);
  }
  const byId = new Map(domains.map((d) => [d.id, d]));
  const results = [];
  const confluxNotes = [...(matchmake.notes || []), ...(confluxPhase.notes || [])];
  const sharedAdds = new Map();
  const extraOutcomesByConflux = new Map();

  const active = await storage.listConfluxes({ status: ['approaching', 'docked'] });
  for (const conflux of active) {
    normalizeConfluxBoard(conflux);
    const pair = (conflux.domainIds || []).map((id) => byId.get(id)).filter(Boolean);
    if (pair.length < 2) continue;
    for (const d of pair) normalizeDomain(d);

    if (conflux.status === 'docked') {
      await scoreConfluxAwareness({
        config,
        runtime,
        conflux,
        domains: pair,
        world,
      });
      for (const d of pair) {
        const other = pair.find((x) => x.id !== d.id);
        revealKnownLore({ conflux, viewerId: d.id, partner: other });
      }
    }

    const shared = await resolveConfluxSharedMonth({
      config,
      runtime,
      conflux,
      domains: pair,
      world,
    });
    for (const [id, adds] of shared.chronicleAddsByDomain || []) {
      sharedAdds.set(id, [...(sharedAdds.get(id) || []), ...(adds || [])]);
    }
    extraOutcomesByConflux.set(conflux.id, shared.processOutcomes || []);
    if (conflux.status === 'docked') {
      maybeGrantAwarenessFromKnownLore(conflux, pair);
    }
    await storage.saveConflux(conflux);
    for (const d of pair) {
      await storage.saveDomain(d);
      byId.set(d.id, d);
    }
  }

  const monthById = new Map();
  for (const domain of domains) {
    if (domain.status && domain.status !== 'playing') {
      results.push({ domainId: domain.id, skipped: true, reason: domain.status });
    }
  }

  const playing = domains.filter((d) => !d.status || d.status === 'playing');
  for (const domain of playing) {
    normalizeDomain(domain);
    const live = byId.get(domain.id) || domain;
    const conflux = active.find((c) => (c.domainIds || []).includes(live.id)) || null;
    const partnerId = conflux ? otherDomainId(conflux, live.id) : null;
    const partner = conflux?.status === 'docked' && partnerId ? byId.get(partnerId) : null;
    const resolved = await resolveDomainMonth({
      config,
      runtime,
      storage,
      domain: live,
      world,
      partner,
      conflux,
      confluxId: conflux?.id || null,
      skipPlotClocks: Boolean(conflux),
      extraProcessOutcomes: conflux ? extraOutcomesByConflux.get(conflux.id) || [] : [],
    });
    monthById.set(live.id, resolved);
    byId.set(live.id, resolved.domain);
    for (const row of resolved.flowAdds || []) {
      sharedAdds.set(row.domainId, [...(sharedAdds.get(row.domainId) || []), row.fact]);
    }
    await storage.saveDomain(resolved.domain);
    if (conflux) {
      if (conflux.status === 'docked') {
        const pair = (conflux.domainIds || []).map((id) => byId.get(id)).filter(Boolean);
        maybeGrantAwarenessFromKnownLore(conflux, pair);
      }
      await storage.saveConflux(conflux);
    }
  }

  for (const conflux of active) {
    releaseInactiveProcessesFromOpenPlots({
      plotlines: conflux.plotlines,
      state: { pendingActions: conflux.processes || [] },
    });
    await storage.saveConflux(conflux);
  }

  const dockedNow = (await storage.listConfluxes({ status: ['docked'] })) || [];
  const advanced = await advanceDockedConfluxes({ storage, runtime, world }, dockedNow);
  confluxNotes.push(...(advanced.notes || []));

  for (const resolved of monthById.values()) {
    let domain = resolved.domain;
    const prelude = confluxPhase.chronicleAddsByDomain.get(domain.id) || [];
    const undockAdds = advanced.undockAddsByDomain?.get(domain.id) || [];
    const shared = sharedAdds.get(domain.id) || [];
    if (undockAdds.length) {
      const fresh = await storage.getDomain(domain.id);
      if (fresh) domain = fresh;
    }

    const newsAdds = filterChronicleForDomain(
      withoutSeed([...prelude, ...shared, ...resolved.chronicleAdds, ...undockAdds]),
      domain.id,
    );
    const conflux = active.find((c) => (c.domainIds || []).includes(domain.id)) || null;
    const partnerId = conflux ? otherDomainId(conflux, domain.id) : null;
    const partner = partnerId ? byId.get(partnerId) : null;
    const undocked = undockAdds.length > 0;
    const sendNews = undocked || shouldSendTickNews(domain, world.gameDate, newsAdds);
    let news = null;
    if (sendNews) {
      news = await app.narrateTickNews(domain, newsAdds, world.gameDate, {
        undock: undocked,
        partnerName: partner?.name || null,
        highlight: resolved.highlight,
        stewardActs: resolved.stewardActs || [],
      });
      const parts = splitTickNews(news);
      for (const part of parts) {
        await app.persistDialog(domain, 'assistant', part, { kind: 'tick_news' });
        await app.emitOutbound(domain.ownerUserId, withDateHeader(part, world), {
          agent: 'ruler',
          domainId: domain.id,
          kind: 'tick_news',
        });
      }
    }

    results.push({
      domainId: domain.id,
      name: domain.name,
      chronicleCount: newsAdds.length,
      status: domain.status,
      inConfluxDocked: Boolean(conflux && conflux.status === 'docked' && undockAdds.length === 0),
      confluxEnded: undockAdds.length > 0,
      confluxId: conflux?.id || null,
      plotlines: (domain.plotlines || []).map((p) => ({
        id: p.id,
        title: p.title,
        temperature: p.temperature,
      })),
      news,
      statChanges: newsAdds
        .filter((c) => c.statChanges)
        .map((c) => ({ id: c.id, changes: c.statChanges })),
    });
  }

  await storage.saveWorld(world);

  return {
    world: {
      id: world.id,
      tickIndex: world.tickIndex,
      gameDate: world.gameDate,
    },
    conflux: confluxNotes,
    results,
  };
}
