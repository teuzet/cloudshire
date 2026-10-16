/**
 * Тонкие функции, без которых замороженное сопряжение не загружается.
 * Старый движок нитей сюда не переехал: синопсисы и судья статов больше не считаются.
 */

import { newId } from '../game/ids.js';
import { gameDateFromDay, worldDateLabel } from '../game/gameClock.js';

const ENTITY_KINDS = new Set([
  'place',
  'institution',
  'resource',
  'craft',
  'infrastructure',
  'custom',
  'tension',
  'cult',
  'artifact',
  'substance',
  'secret_place',
]);

function plotTypeOf(plot) {
  if (!plot) return 'story';
  if (plot.type === 'errand' || plot.kind === 'errand') return 'errand';
  if (plot.type === 'conflux' || plot.isMainConflux) return 'conflux';
  return 'story';
}

export function isStoryPlot(plot) {
  return plotTypeOf(plot) === 'story';
}

export function isConfluxPlot(plot) {
  return plotTypeOf(plot) === 'conflux';
}

export function isStakedStory(plot) {
  return isStoryPlot(plot);
}

export function createPlotline(raw = {}) {
  const plot = {
    type: 'story',
    status: 'open',
    title: '',
    synopsis: '',
    ...raw,
  };
  plot.id = String(plot.id || '').trim() || newId('plot');
  if (!plot.type) plot.type = 'story';
  return plot;
}

function awarenessMap(plot) {
  const raw = plot?.plotAwareness;
  const hadField = raw && typeof raw === 'object' && !Array.isArray(raw);
  const next = {};
  if (hadField) {
    for (const [key, value] of Object.entries(raw)) {
      if (value) next[String(key)] = true;
    }
  }
  const host = plot?.hostDomainId ? String(plot.hostDomainId) : null;
  if (host) next[host] = true;
  if (isConfluxPlot(plot)) {
    for (const id of Array.isArray(plot.concernsDomainIds) ? plot.concernsDomainIds : []) {
      if (id) next[String(id)] = true;
    }
  }
  if (!hadField || !Object.keys(next).length) {
    for (const id of Array.isArray(plot?.concernsDomainIds) ? plot.concernsDomainIds : []) {
      if (id) next[String(id)] = true;
    }
  }
  return next;
}

export function refreshPlotAwareness(plot) {
  if (!plot || typeof plot !== 'object') return plot;
  plot.plotAwareness = awarenessMap(plot);
  return plot;
}

export function stripPlotSecrets(plot) {
  if (!plot || typeof plot !== 'object') return plot;
  const {
    truth: _truth,
    truthGraph: _graph,
    resolutionFacts: _res,
    hiddenPremises: _hidden,
    hiddenAnswer: _answer,
    seed: _seed,
    discoveryLadder: _ladder,
    closureGate: _gate,
    ...rest
  } = plot;
  return rest;
}

function clip(text, max) {
  const value = String(text || '').trim();
  return value.length > max ? value.slice(0, max) : value;
}

export function normalizeCityEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim();
  if (!ENTITY_KINDS.has(kind)) return null;
  const name = clip(raw.name, 80);
  const about = clip(raw.about, 280);
  if (!name || !about) return null;
  const id = String(raw.id || '').trim() || newId('ent');
  return { id, kind, name, about };
}

export function normalizeCityEntities(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const one = normalizeCityEntity(item);
    if (!one) continue;
    const key = one.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(one);
  }
  return out;
}

export function addCityEntity(domain, raw) {
  if (!domain || typeof domain !== 'object') return null;
  const one = normalizeCityEntity(raw);
  if (!one) return null;
  const list = normalizeCityEntities(domain.cityEntities);
  const key = one.name.toLowerCase();
  const existing = list.find((item) => item.name.toLowerCase() === key);
  if (existing) return existing;
  list.push(one);
  domain.cityEntities = list;
  return one;
}

export function appendChronicle(
  domain,
  world,
  { text, plotId = null, author = 'system', importance = 'major', tags = ['chronicle'], day = null } = {},
) {
  const dated = day != null && day !== '' && Number.isFinite(Number(day));
  const fact = {
    id: newId('lore'),
    text: clip(text, 900),
    tags,
    gameDateLabel: dated ? gameDateFromDay(Number(day)).label : worldDateLabel(world),
    tick: world?.tickIndex ?? null,
    day: dated ? Math.round(Number(day)) : null,
    author,
    importance,
    createdAt: new Date().toISOString(),
    relatedPlotlineIds: plotId ? [plotId] : null,
  };
  domain.lore = Array.isArray(domain.lore) ? domain.lore : [];
  domain.lore.push(fact);
  if (plotId) {
    const plot = (domain.plotlines || []).find((item) => item.id === plotId);
    if (plot) {
      plot.chronicleIds = plot.chronicleIds || [];
      if (!plot.chronicleIds.includes(fact.id)) plot.chronicleIds.push(fact.id);
    }
  }
  return fact;
}

export async function keepStories() {
  return null;
}

export async function scoreChronicleStats() {
  return { scored: 0, catastrophe: null };
}

export async function scorePairChronicleStats() {
  return { scored: 0, catastrophe: null };
}
