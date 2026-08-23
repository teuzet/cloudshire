import { advanceGameDate, filterChronicleForDomain, normalizeDomain } from './models.js';
import {
  processConfluxApproachingPhase,
  advanceDockedConfluxes,
  maybeMatchmakeConfluxes,
  advanceConfluxLifetimeCounters,
} from './conflux.js';
import { resolveDomainMonth } from './monthResolve.js';
import { getLogger } from '../log.js';

/** Игровая дата шапкой у письма месяца (только в отправке, не в dialogHistory). */
function withDateHeader(text, world) {
  const label = world?.gameDate?.label;
  if (!label) return text;
  return `— ${label} —\n\n${text}`;
}

export async function runWorldTick({ config, runtime, storage, app }) {
  app?.beginWorldTick?.();
  try {
    return await runWorldTickInner({ config, runtime, storage, app });
  } finally {
    app?.endWorldTick?.();
  }
}

async function runWorldTickInner({ config, runtime, storage, app }) {
  const world = await storage.getWorld();
  advanceGameDate(world);
  await storage.saveWorld(world);

  const matchmake = await maybeMatchmakeConfluxes({ config, storage, world });
  const confluxPhase = await processConfluxApproachingPhase({
    config,
    runtime,
    storage,
    world,
  });
  // После стыка/прелюдии: docked = конфлюкс, approaching+solo = соло (~50/50 цель).
  await advanceConfluxLifetimeCounters({ storage, world });

  const domains = await storage.listDomains();
  const results = [];
  const handled = new Set();
  const confluxNotes = [...(matchmake.notes || []), ...(confluxPhase.notes || [])];

  // Стыкованные пары: у каждого города свой месяц, но поворот, задевший соседа,
  // разносится в обе хроники и заводит зеркальную нить (docs/PIVOT_PLOTLINES.md).
  const pairBatches = [];
  for (const conflux of confluxPhase.dockedConfluxes || []) {
    const ids = (conflux.domainIds || []).slice(0, 2);
    const loaded = [];
    for (const id of ids) {
      const d = await storage.getDomain(id);
      if (d) {
        normalizeDomain(d);
        loaded.push(d);
      }
    }
    if (loaded.length < 2) continue;

    // Последовательно: второй город должен увидеть зеркала от первого.
    const resolvedDomains = [];
    for (let i = 0; i < loaded.length; i += 1) {
      const self = resolvedDomains[i] || loaded[i];
      const other = resolvedDomains[1 - i] || loaded[1 - i];
      const month = await resolveDomainMonth({
        config,
        runtime,
        domain: self,
        world,
        partner: other,
        confluxId: conflux.id,
      });
      resolvedDomains[i] = month.domain;
      // Зеркала писались в объект партнёра — переносим их в его актуальную копию.
      if (resolvedDomains[1 - i] && other !== resolvedDomains[1 - i]) {
        resolvedDomains[1 - i].lore = other.lore;
        resolvedDomains[1 - i].plotlines = other.plotlines;
      }
      pairBatches.push({
        conflux,
        domain: month.domain,
        chronicleAdds: month.chronicleAdds,
        highlight: month.highlight,
      });
    }
  }

  const advanced = await advanceDockedConfluxes(
    { storage, runtime, world },
    confluxPhase.dockedConfluxes,
  );
  confluxNotes.push(...(advanced.notes || []));

  for (const { conflux, domain, chronicleAdds, highlight } of pairBatches) {
    handled.add(domain.id);
    await storage.saveDomain(domain);

    const prelude = confluxPhase.chronicleAddsByDomain.get(domain.id) || [];
    const undockAdds = advanced.undockAddsByDomain?.get(domain.id) || [];
    const newsAdds = filterChronicleForDomain(
      [...prelude, ...chronicleAdds, ...undockAdds],
      domain.id,
    );
    const partnerId = (conflux.domainIds || []).find((id) => id !== domain.id);
    const partner = pairBatches.find((b) => b.domain.id === partnerId)?.domain || null;
    const news = await app.narrateTickNews(domain, newsAdds, world.gameDate, {
      undock: undockAdds.length > 0,
      partnerName: partner?.name || null,
      highlight,
    });
    await app.persistDialog(domain, 'assistant', news, { kind: 'tick_news' });
    await app.emitOutbound(domain.ownerUserId, withDateHeader(news, world), {
      agent: 'ruler',
      domainId: domain.id,
      kind: 'tick_news',
    });

    results.push({
      domainId: domain.id,
      name: domain.name,
      chronicleCount: newsAdds.length,
      status: domain.status,
      inConfluxDocked: undockAdds.length === 0,
      confluxEnded: undockAdds.length > 0,
      confluxId: conflux.id,
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

  // Solo — параллельно по доменам
  const soloDomains = domains.filter(
    (d) => !handled.has(d.id) && (!d.status || d.status === 'playing'),
  );
  for (const domain of domains) {
    if (handled.has(domain.id)) continue;
    if (domain.status && domain.status !== 'playing') {
      results.push({ domainId: domain.id, skipped: true, reason: domain.status });
    }
  }

  const soloResults = await Promise.all(
    soloDomains.map(async (domain) => {
      normalizeDomain(domain);

      // Месяц города целиком на нитях: движок считает, рассказчик описывает.
      const resolved = await resolveDomainMonth({
        config,
        runtime,
        domain,
        world,
      });

      await storage.saveDomain(resolved.domain);

      const prelude = confluxPhase.chronicleAddsByDomain.get(domain.id) || [];
      const newsAdds = filterChronicleForDomain(
        [...prelude, ...resolved.chronicleAdds],
        domain.id,
      );
      const news = await app.narrateTickNews(resolved.domain, newsAdds, world.gameDate, {
        highlight: resolved.highlight,
      });
      await app.persistDialog(resolved.domain, 'assistant', news, { kind: 'tick_news' });
      await app.emitOutbound(resolved.domain.ownerUserId, withDateHeader(news, world), {
        agent: 'ruler',
        domainId: resolved.domain.id,
        kind: 'tick_news',
      });

      return {
        domainId: resolved.domain.id,
        name: resolved.domain.name,
        chronicleCount: newsAdds.length,
        status: resolved.domain.status,
        inConfluxDocked: false,
        plotlines: (resolved.domain.plotlines || []).map((p) => ({
          id: p.id,
          title: p.title,
          temperature: p.temperature,
        })),
        news,
        statChanges: newsAdds
          .filter((c) => c.statChanges)
          .map((c) => ({ id: c.id, changes: c.statChanges })),
      };
    }),
  );
  results.push(...soloResults);

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
