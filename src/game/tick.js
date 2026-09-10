import { advanceGameDate } from './models.js';
import { ageDomainPeople } from './ages.js';
import { monthsUntilDock } from './conflux.js';
import { otherDomainId } from './confluxBoard.js';
import { resolveIslandImage } from './islandImage.js';

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
  void config;
  void runtime;
  void app;
  const world = await storage.getWorld();
  advanceGameDate(world);
  await storage.saveWorld(world);
  const domains = await storage.listDomains();
  for (const domain of domains) {
    ageDomainPeople(domain, world);
    await storage.saveDomain(domain);
  }
  return {
    tickIndex: world.tickIndex,
    gameDate: world.gameDate,
    skipped: 'conflux_days',
    results: [],
    confluxNotes: [],
  };
}

