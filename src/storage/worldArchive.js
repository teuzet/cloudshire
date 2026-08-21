/**
 * Архивация мира (снимок данных + логи) при wipe.
 * Живой мир — data/; архивы — data/archives/<worldId>/ (или storage.archivesDir).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { projectRoot } from '../config.js';
import { getLogger } from '../log.js';
import { getUsageFilePath, worldLogsDir } from '../llm/usage.js';

export function archivesRoot(config) {
  if (config.storage?.archivesDir) {
    const d = config.storage.archivesDir;
    return path.isAbsolute(d) ? d : path.join(projectRoot(), d);
  }
  if (config.storage?.yaml?.dir) {
    return path.join(config.storage.yaml.dir, 'archives');
  }
  return path.join(projectRoot(), 'archives');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeYamlFile(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, yaml.dump(data, { lineWidth: 120, noRefs: true }), 'utf8');
}

async function copyFileIfExists(src, dest) {
  if (!src || !fs.existsSync(src)) return false;
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
  return true;
}

/**
 * Записать архив мира на диск.
 * @returns {{ archiveDir: string, worldId: string, copiedLogs: object }}
 */
export async function writeWorldArchive({
  config,
  world,
  domains = [],
  users = [],
  confluxes = [],
  reason = 'wipe',
  sessionLogPath = null,
}) {
  const worldId = String(world.id);
  const archiveDir = path.join(archivesRoot(config), worldId);
  await ensureDir(archiveDir);

  const archivedAt = new Date().toISOString();
  const snapshot = {
    ...world,
    status: 'archived',
    endedAt: archivedAt,
    archiveReason: reason,
  };

  await writeYamlFile(path.join(archiveDir, 'world.yaml'), snapshot);

  for (const d of domains) {
    await writeYamlFile(path.join(archiveDir, 'domains', `${d.id}.yaml`), d);
  }
  for (const u of users) {
    const uid = u.userId ?? u.id;
    await writeYamlFile(path.join(archiveDir, 'users', `${uid}.yaml`), u);
  }
  for (const c of confluxes) {
    await writeYamlFile(path.join(archiveDir, 'confluxes', `${c.id}.yaml`), c);
  }

  const logsDest = path.join(archiveDir, 'logs');
  await ensureDir(logsDest);
  const usageSrc = getUsageFilePath() || path.join(worldLogsDir(config, worldId), 'usage.jsonl');
  const sessionSrc = sessionLogPath || getLogger()?.filePath || null;

  const copiedLogs = {
    usage: await copyFileIfExists(usageSrc, path.join(logsDest, 'usage.jsonl')),
    session: await copyFileIfExists(sessionSrc, path.join(logsDest, 'session.log')),
  };

  // Если usage ещё в live-папке мира — тоже
  const liveUsage = path.join(worldLogsDir(config, worldId), 'usage.jsonl');
  if (!copiedLogs.usage && liveUsage !== usageSrc) {
    copiedLogs.usage = await copyFileIfExists(liveUsage, path.join(logsDest, 'usage.jsonl'));
  }

  const meta = {
    worldId,
    seasonKey: world.seasonKey || null,
    name: world.name || null,
    archivedAt,
    reason,
    tickIndex: world.tickIndex ?? null,
    gameDate: world.gameDate || null,
    createdAt: world.createdAt || null,
    counts: {
      domains: domains.length,
      users: users.length,
      confluxes: confluxes.length,
    },
    logs: copiedLogs,
  };
  await writeYamlFile(path.join(archiveDir, 'meta.yaml'), meta);

  getLogger().info('world.archived', {
    worldId,
    archiveDir,
    reason,
    ...meta.counts,
    logs: copiedLogs,
  });

  return { archiveDir, worldId, copiedLogs, meta };
}
