import { statEpithet } from './stats.js';
import { plotConcerns } from './confluxBoard.js';
import { activeProcesses, pausedProcesses, processOwnedBy } from './processes.js';
import { blessManaCost, currentMana } from './mana.js';
import { listStandingOrders } from './orders.js';
import { gameDateFromTickIndex, worldDateLabel } from './tickClock.js';
import { domainHasIslandImage, officerHasPortrait } from '../storage/r2.js';
import { formatAxesForSpeech, formatLookForSpeech } from './officers.js';

function clip(text, max = 800) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

const DESC_SECTION_MAX = 8000;

function sectionsFromMarkdown(description) {
  const raw = String(description || '').trim();
  if (!raw) return [];
  if (!/^##\s+/m.test(raw)) {
    return [{ id: 'city', title: 'Город', text: clip(raw, DESC_SECTION_MAX) }];
  }
  return raw
    .split(/^##\s+/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, i) => {
      const nl = chunk.indexOf('\n');
      const title = (nl < 0 ? chunk : chunk.slice(0, nl)).trim() || `Раздел ${i + 1}`;
      const text = nl < 0 ? '' : chunk.slice(nl).trim();
      return { id: `s${i}`, title, text: clip(text, DESC_SECTION_MAX) };
    })
    .filter((s) => s.text);
}

export function cityDescriptionSections(domain, config) {
  const defs = Array.isArray(config?.genesis?.aspects) ? config.genesis.aspects : [];
  const aspects = domain?.aspects && typeof domain.aspects === 'object' ? domain.aspects : {};
  const fromAspects = defs
    .map((def) => {
      const text = String(aspects[def.id] || '').trim();
      if (!text) return null;
      return { id: def.id, title: def.title || def.id, text: clip(text, DESC_SECTION_MAX) };
    })
    .filter(Boolean);
  if (fromAspects.length) return fromAspects;
  return sectionsFromMarkdown(domain?.description);
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

function slimProcess(process, config, { mana = 0 } = {}) {
  const names = (process.linkedStats || [])
    .map((id) => statName(config, id))
    .filter(Boolean);
  const left = Number(process.monthsLeft);
  const expected = Number(process.expectedMonths);
  const objective = Number(process.objectiveMonths || process.expectedMonths);
  const done = Number(process.monthsDone);
  const cost = blessManaCost(process);
  const active = !process.status || process.status === 'active';
  return {
    id: process.id,
    summary: clip(process.summary || 'Дело', 180),
    detail: clip(process.detail || '', 1200),
    monthsLeft: Number.isFinite(left) ? Math.max(0, left) : null,
    expectedMonths: Number.isFinite(expected) ? Math.max(1, Math.round(expected)) : null,
    objectiveMonths: Number.isFinite(objective) ? Math.max(1, Math.round(objective)) : null,
    monthsDone: Number.isFinite(done) ? Math.max(0, Math.round(done)) : null,
    paused: process.status === 'paused',
    linkedStats: names,
    blessed: Boolean(process.blessed),
    blessCost: cost,
    canBless: active && process.status !== 'paused' && !process.blessed && mana >= cost,
  };
}

function officerAgeYears(officer) {
  const n = Number(officer?.look?.ageYears || officer?.ageYears);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function slimOfficerSlot(officer, process, config, mana) {
  const ageYears = officerAgeYears(officer);
  const gender = officer?.gender === 'female' || officer?.gender === 'male' ? officer.gender : null;
  return {
    title: officer.title,
    name: officer.name,
    office: officer.office,
    officerId: officer.id,
    hasPortrait: officerHasPortrait(officer),
    portraitUrl: officer.portraitUrl || null,
    nature: clip(officer.nature || '', 800),
    look: clip(formatLookForSpeech(officer.look, gender), 280),
    temper: officer?.axes ? clip(formatAxesForSpeech(officer.axes, config), 120) : '',
    ageYears,
    gender,
    process: process ? slimProcess(process, config, { mana }) : null,
  };
}

function collectEvents(domain, conflux, config, mana = 0) {
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
      processes: procs.filter((pr) => related.has(String(pr.id))).map((pr) => slimProcess(pr, config, { mana })),
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
  const mana = currentMana(domain);
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
            hasPortrait: officerHasPortrait(officer),
            portraitUrl: officer.portraitUrl || null,
            busy: Boolean(officer.processId),
            process: proc ? slimProcess(proc, config, { mana }) : null,
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
      hasImage: domainHasIslandImage(domain),
      imageUrl: domain.imageUrl || null,
      sections: cityDescriptionSections(domain, config),
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
    mana: {
      name: config.mana?.name || 'Мана',
      value: mana,
      max: 100,
      about: clip(
        config.mana?.about || 'Сила, которой ты благословляешь дела города.',
        280,
      ),
    },
    stats,
    events: collectEvents(domain, conflux, config, mana),
    processes: (domain.officers || []).map((o) => {
      const proc = o.processId
        ? ownProcesses(domain, conflux).find((p) => p.id === o.processId)
        : null;
      return slimOfficerSlot(o, proc, config, mana);
    }),
    orders,
  };
}
