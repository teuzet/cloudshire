/**
 * Снимки живого мира для тестового клиента: откатить состояние мира
 * (часы, очередь, каталоги, все острова), не выбранный город.
 * Это не архив wipe — тот же worldId, полная замена.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { projectRoot } from '../config.js';
import { newId } from './ids.js';
import { clockIsHeld, worldDay } from './scheduler.js';
import { gameDateFromDay, reanchorClock, tickIndexFromDay } from './gameClock.js';

export const PLAY_SNAPSHOT_KIND = 'cloudshire-live-world';
export const PLAY_SNAPSHOT_VERSION = 2;
const MAX_SAVES = 40;
const LABEL_MAX = 80;

export function playSavesDir(config) {
  const yamlDir = config?.storage?.yaml?.dir;
  const root = yamlDir
    ? path.isAbsolute(yamlDir)
      ? yamlDir
      : path.join(projectRoot(), yamlDir)
    : path.join(projectRoot(), 'data');
  return path.join(root, 'play-saves');
}

function savePath(config, id) {
  return path.join(playSavesDir(config), `${id}.yaml`);
}

function clipLabel(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX);
}

export function snapshotMeta(bundle) {
  const world = bundle?.world || {};
  const day = Math.max(0, Math.round(Number(world.dayIndex) || 0));
  return {
    id: bundle.id,
    label: bundle.label || '',
    savedAt: bundle.savedAt,
    dayIndex: day,
    dateLabel: gameDateFromDay(day).label,
    worldName: world.name || '',
    cityNames: (bundle.domains || []).map((d) => d.name).filter(Boolean),
    domainCount: (bundle.domains || []).length,
    catalogCards: 0,
  };
}

export async function captureLiveWorld(storage, { config = null, now = Date.now() } = {}) {
  const world = await storage.getWorld();
  if (!world) throw new Error('мира нет');
  const [domains, users, confluxes] = await Promise.all([
    storage.listDomains(),
    storage.listUserBindings(),
    storage.listConfluxes(),
  ]);
  const cloned = structuredClone(world);
  const day = worldDay(cloned, { now, config });
  cloned.dayIndex = day;
  cloned.tickIndex = tickIndexFromDay(day);
  cloned.gameDate = { ...gameDateFromDay(day), tick: cloned.tickIndex };
  return {
    kind: PLAY_SNAPSHOT_KIND,
    version: PLAY_SNAPSHOT_VERSION,
    world: cloned,
    domains: structuredClone(domains || []),
    users: structuredClone(users || []),
    confluxes: structuredClone(confluxes || []),
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function listPlaySnapshots(config) {
  const dir = playSavesDir(config);
  const files = await fs.readdir(dir).catch(() => []);
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.yaml')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
    if (!raw) continue;
    let bundle;
    try {
      bundle = yaml.load(raw);
    } catch {
      continue;
    }
    if (bundle?.kind !== PLAY_SNAPSHOT_KIND || !bundle.id) continue;
    out.push(snapshotMeta(bundle));
  }
  out.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  return out;
}

export async function writePlaySnapshot(config, bundle, { label = '' } = {}) {
  const existing = await listPlaySnapshots(config);
  if (existing.length >= MAX_SAVES) {
    return {
      ok: false,
      error: 'too_many',
      message: `уже ${MAX_SAVES} снимков — удали старый`,
    };
  }
  const id = newId('save');
  const packed = {
    ...bundle,
    id,
    label: clipLabel(label),
    savedAt: new Date().toISOString(),
  };
  await ensureDir(playSavesDir(config));
  const tmp = `${savePath(config, id)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, yaml.dump(packed, { lineWidth: 120, noRefs: true }), 'utf8');
  await fs.rename(tmp, savePath(config, id));
  return { ok: true, ...snapshotMeta(packed) };
}

export async function readPlaySnapshot(config, id) {
  const key = String(id || '').trim();
  if (!/^save_[a-z0-9]+$/i.test(key)) return null;
  const raw = await fs.readFile(savePath(config, key), 'utf8').catch(() => null);
  if (!raw) return null;
  const bundle = yaml.load(raw);
  if (bundle?.kind !== PLAY_SNAPSHOT_KIND || bundle.id !== key) return null;
  return bundle;
}

export async function deletePlaySnapshot(config, id) {
  const key = String(id || '').trim();
  if (!/^save_[a-z0-9]+$/i.test(key)) {
    return { ok: false, error: 'bad_id', message: 'нет такого снимка' };
  }
  try {
    await fs.unlink(savePath(config, key));
    return { ok: true, id: key };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: 'not_found', message: 'снимок уже удалён' };
    throw err;
  }
}

export async function restoreLiveWorld(storage, bundle, { config = null, now = Date.now() } = {}) {
  if (bundle?.kind !== PLAY_SNAPSHOT_KIND || !bundle.world?.id) {
    return { ok: false, error: 'bad_snapshot', message: 'файл снимка повреждён' };
  }
  if (typeof storage.replaceLiveWorld !== 'function') {
    return { ok: false, error: 'unsupported', message: 'это хранилище снимки не восстанавливает' };
  }
  const world = structuredClone(bundle.world);
  reanchorClock(world, {
    day: world.dayIndex,
    now,
    config,
    held: clockIsHeld(world),
  });
  await storage.replaceLiveWorld({
    world,
    domains: structuredClone(bundle.domains || []),
    users: structuredClone(bundle.users || []),
    confluxes: structuredClone(bundle.confluxes || []),
  });
  return { ok: true, worldId: world.id, clockHeld: clockIsHeld(world), ...snapshotMeta(bundle) };
}
