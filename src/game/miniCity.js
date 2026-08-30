import { statEpithet } from './stats.js';
import { plotConcerns } from './confluxBoard.js';
import { activeProcesses, pausedProcesses, processOwnedBy } from './processes.js';
import { listStandingOrders } from './orders.js';
import { gameDateFromTickIndex, worldDateLabel } from './tickClock.js';

function clip(text, max = 800) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

export function gameDateLabelAtTick(world, tick) {
  if (!Number.isInteger(Number(tick))) return null;
  return gameDateFromTickIndex(tick).label;
}

function cityParticipates(plot, domainId) {
  if (!plot || plot.kind !== 'story') return false;
  if (plot.isMainConflux) return true;
  return plotConcerns(plot, domainId);
}

function statName(config, id) {
  const def = (config?.stats || []).find((s) => s.id === id);
  return def?.name || null;
}

function ownProcesses(domain, conflux) {
  const id = domain.id;
  const local = [...activeProcesses(domain), ...pausedProcesses(domain)];
  const fromBoard = (conflux?.processes || []).filter((p) => processOwnedBy(p, id));
  const seen = new Set();
  const out = [];
  for (const p of [...local, ...fromBoard]) {
    if (!p?.id || seen.has(p.id)) continue;
    if (p.status && p.status !== 'active' && p.status !== 'paused') continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function slimProcess(process, config) {
  const names = (process.linkedStats || [])
    .map((id) => statName(config, id))
    .filter(Boolean);
  const left = Number(process.monthsLeft);
  return {
    summary: clip(process.summary || 'Дело', 120),
    detail: clip(process.detail || '', 600),
    monthsLeft: Number.isFinite(left) ? Math.max(0, left) : null,
    paused: process.status === 'paused',
    linkedStats: names,
  };
}

function collectEvents(domain, conflux, config) {
  const id = String(domain.id);
  const byId = new Map();
  for (const p of domain.plotlines || []) {
    if (p?.kind === 'story' && p.id) byId.set(p.id, p);
  }
  for (const p of conflux?.plotlines || []) {
    if (!p?.id || p.kind !== 'story') continue;
    if (!cityParticipates(p, id)) continue;
    byId.set(p.id, p);
  }

  const procs = ownProcesses(domain, conflux);
  return [...byId.values()].map((plot) => {
    const related = new Set((plot.relatedProcessIds || []).map(String));
    return {
      title: clip(plot.title || 'История', 80),
      synopsis: clip(plot.synopsis || '', 600),
      processes: procs.filter((pr) => related.has(String(pr.id))).map((pr) => slimProcess(pr, config)),
    };
  });
}

/**
 * Справочник города для мини-аппки: без тайн, id и статов жреца.
 */
export function miniCityPayload({ domain, conflux = null, world = null, config, generating = false } = {}) {
  if (!domain) {
    return {
      city: null,
      generating: Boolean(generating),
      gameDate: null,
      stats: [],
      events: [],
      processes: [],
      orders: [],
    };
  }

  const tick = world?.tickIndex ?? world?.gameDate?.tick ?? null;
  const stats = (config?.stats || []).map((def) => {
    const value = Number(domain.stats?.[def.id]);
    const v = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
    const officer = (domain.officers || []).find((o) => o.statId === def.id) || null;
    const proc = officer?.processId
      ? ownProcesses(domain, conflux).find((p) => p.id === officer.processId)
      : null;
    return {
      id: def.id,
      name: def.name,
      value: v,
      epithet: statEpithet(v, config),
      about: clip(def.about || '', 280),
      officer: officer
        ? {
            id: officer.id,
            office: officer.office,
            title: officer.title,
            name: officer.name,
            nature: clip(officer.nature || '', 280),
            hasPortrait: Boolean(officer.portraitPath || officer.portraitBase64),
            busy: Boolean(officer.processId),
            process: proc ? slimProcess(proc, config) : null,
          }
        : null,
    };
  });
  const faithRaw = Number(domain.state?.faith);
  const faith = Number.isFinite(faithRaw)
    ? Math.max(0, Math.min(100, Math.round(faithRaw)))
    : null;

  const orders = listStandingOrders(domain, { tick })
    .filter((o) => o.pending !== 'create')
    .map((o) => ({
      text: clip(o.text || '', 400),
      since: gameDateLabelAtTick(world, o.declaredTick),
      remainingMonths: o.indefinite ? null : o.remainingMonths,
      indefinite: Boolean(o.indefinite),
    }));

  return {
    city: {
      name: domain.name || 'Город',
      hasImage: Boolean(domain.imagePath || domain.imageBase64),
    },
    generating: Boolean(generating),
    gameDate: worldDateLabel(world),
    faith:
      faith == null
        ? null
        : {
            name: config.faith?.name || 'Вера',
            value: faith,
            epithet: statEpithet(faith, config),
            about: clip(
              config.faith?.about ||
                'Насколько город ещё верит, что ты — его бог.',
              280,
            ),
          },
    stats,
    events: collectEvents(domain, conflux, config),
    processes: (domain.officers || []).map((o) => {
      const proc = o.processId
        ? ownProcesses(domain, conflux).find((p) => p.id === o.processId)
        : null;
      return {
        title: o.title,
        name: o.name,
        office: o.office,
        officerId: o.id,
        hasPortrait: Boolean(o.portraitPath || o.portraitBase64),
        process: proc ? slimProcess(proc, config) : null,
      };
    }),
    orders,
  };
}
