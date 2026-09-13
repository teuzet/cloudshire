import { syncWorldClock } from './gameClock.js';
import { daysUntilDock } from './confluxTime.js';
import { otherDomainId } from './confluxBoard.js';

/** Игровая дата шапкой у вести (только в отправке, не в dialogHistory). */
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
        conflux && world?.dayIndex != null
          ? daysUntilDock(conflux, world.dayIndex)
          : Math.max(0, Math.round(Number(item.etaMonths || 0) * 30));
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

async function runWorldTickInner({ config, runtime, storage, app }) {
  void config;
  void runtime;
  void app;
  const world = await storage.updateWorld((fresh) => syncWorldClock(fresh));
  return {
    world,
    tickIndex: world.tickIndex,
    gameDate: world.gameDate,
    skipped: 'derived_clock',
    results: [],
    confluxNotes: [],
  };
}
