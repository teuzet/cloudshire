/**
 * Объекты мира: устойчивые части города со своей историей версий.
 * Типы и лимиты длин приходят из конфига; без конфига нормализатор
 * чинит форму и не судит, знакомый ли это тип.
 */

import { newId } from '../game/ids.js';
import { objectLimits, objectTypes } from './scales.js';

export const STAT_IDS = ['prosperity', 'influence', 'knowledge', 'security'];

const STATUSES = ['active', 'deleted'];

function clip(text, max) {
  const s = String(text || '').trim();
  if (!Number.isFinite(max) || max <= 0) return s;
  return s.slice(0, max);
}

export function emptyStatEffect() {
  const out = {};
  for (const id of STAT_IDS) out[id] = 0;
  return out;
}

export function normalizeStatEffect(raw) {
  const out = emptyStatEffect();
  if (!raw || typeof raw !== 'object') return out;
  for (const id of STAT_IDS) {
    const n = Number(raw[id]);
    out[id] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function sameEffect(a, b) {
  return STAT_IDS.every((id) => a[id] === b[id]);
}

function normalizeVersion(raw, fallbackDay) {
  if (!raw || typeof raw !== 'object') return null;
  const version = Math.round(Number(raw.version));
  if (!Number.isFinite(version) || version < 1) return null;
  return {
    version,
    description: String(raw.description || '').trim(),
    statEffect: normalizeStatEffect(raw.statEffect),
    createdDay: Math.max(0, Math.round(Number(raw.createdDay ?? fallbackDay) || 0)),
  };
}

function applyHead(obj) {
  const last = obj.versions[obj.versions.length - 1];
  if (!last) return obj;
  obj.version = last.version;
  obj.description = last.description;
  obj.statEffect = normalizeStatEffect(last.statEffect);
  return obj;
}

export function normalizeWorldObject(raw, config = null) {
  if (!raw || typeof raw !== 'object') return null;
  const limits = config ? objectLimits(config) : null;
  const name = limits ? clip(raw.name, limits.nameMax) : String(raw.name || '').trim();
  if (!name) return null;

  const type = String(raw.type || '').trim();
  if (!type) return null;
  if (config && !objectTypes(config).includes(type)) return null;

  const day = Math.max(0, Math.round(Number(raw.createdDay) || 0));
  let versions = (Array.isArray(raw.versions) ? raw.versions : [])
    .map((item) => normalizeVersion(item, day))
    .filter(Boolean);

  const description = limits
    ? clip(raw.description, limits.descriptionMax)
    : String(raw.description || '').trim();

  if (!versions.length) {
    versions = [
      {
        version: 1,
        description,
        statEffect: normalizeStatEffect(raw.statEffect),
        createdDay: day,
      },
    ];
  }

  const status = STATUSES.includes(raw.status) ? raw.status : 'active';
  const obj = {
    id: String(raw.id || '').trim() || newId('obj'),
    type,
    name,
    description,
    statEffect: normalizeStatEffect(raw.statEffect),
    refs: [...new Set((Array.isArray(raw.refs) ? raw.refs : []).map((id) => String(id || '').trim()).filter(Boolean))],
    version: Math.max(1, Math.round(Number(raw.version) || versions.length)),
    versions,
    status,
    createdDay: day,
    deletedDay: raw.deletedDay == null ? null : Math.max(0, Math.round(Number(raw.deletedDay) || 0)),
    protected: Boolean(raw.protected),
  };
  applyHead(obj);
  if (limits) obj.description = clip(obj.description, limits.descriptionMax);
  if (limits && obj.versions.length) {
    const last = obj.versions[obj.versions.length - 1];
    last.description = obj.description;
  }
  return obj;
}

export function normalizeWorldObjects(list, config = null) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => normalizeWorldObject(item, config)).filter(Boolean);
}

export function createWorldObject(config, {
  id = null,
  type,
  name,
  description = '',
  statEffect = null,
  refs = [],
  day = 0,
  protected: isProtected = false,
} = {}) {
  const known = objectTypes(config);
  const kind = String(type || '').trim();
  if (!known.includes(kind)) {
    throw new Error(`неизвестный тип объекта: ${kind || '(пусто)'}`);
  }
  const limits = objectLimits(config);
  const title = clip(name, limits.nameMax);
  if (!title) throw new Error('у объекта нет имени');
  const createdDay = Math.max(0, Math.round(Number(day) || 0));
  const effect = normalizeStatEffect(statEffect);
  const text = clip(description, limits.descriptionMax);
  return {
    id: id ? String(id) : newId('obj'),
    type: kind,
    name: title,
    description: text,
    statEffect: effect,
    refs: [...new Set((refs || []).map((ref) => String(ref || '').trim()).filter(Boolean))],
    version: 1,
    versions: [{ version: 1, description: text, statEffect: { ...effect }, createdDay }],
    status: 'active',
    createdDay,
    deletedDay: null,
    protected: Boolean(isProtected),
  };
}

export function addObjectVersion(obj, { description, statEffect, day } = {}) {
  if (!obj) return null;
  const next = Math.max(1, Math.round(Number(obj.version) || 0)) + 1;
  if (!Array.isArray(obj.versions)) obj.versions = [];
  obj.versions.push({
    version: next,
    description: String(description || '').trim(),
    statEffect: normalizeStatEffect(statEffect),
    createdDay: Math.max(0, Math.round(Number(day) || 0)),
  });
  return applyHead(obj);
}

export function deleteWorldObject(obj, day) {
  if (!obj) return null;
  obj.status = 'deleted';
  obj.deletedDay = Math.max(0, Math.round(Number(day) || 0));
  return obj;
}

export function activeObjects(domain) {
  return (domain?.worldObjects || []).filter((obj) => obj && obj.status === 'active');
}

export function findObject(domain, id) {
  const needle = String(id || '');
  return (domain?.worldObjects || []).find((obj) => obj && String(obj.id) === needle) || null;
}

export function statEffectsEqual(a, b) {
  return sameEffect(normalizeStatEffect(a), normalizeStatEffect(b));
}
