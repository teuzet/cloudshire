import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { createWorldFromConfig, normalizeDomain, normalizeWorld } from '../game/models.js';
import { writeWorldArchive } from './worldArchive.js';
import { createWipeGuard } from './wipeGuard.js';
import { attachStoryPoolsFromCatalog } from '../game/annotationCatalog.js';
import { ensureOfficersFromLore, stripOfficerPortraitPayload } from '../game/officers.js';
import { nextRevision } from './revision.js';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readYaml(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return yaml.load(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeYaml(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, yaml.dump(data, { lineWidth: 120, noRefs: true }), 'utf8');
  await fs.rename(tmp, filePath);
}

async function clearYamlDir(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  for (const file of files) {
    if (file.endsWith('.yaml') || file.endsWith('.tmp')) {
      await fs.unlink(path.join(dir, file)).catch(() => {});
    }
  }
}

export class YamlStorage {
  constructor(config) {
    this.config = config;
    this.root = config.storage.yaml.dir;
    this.driver = 'yaml';
    this.guard = createWipeGuard();
  }

  async init() {
    await ensureDir(this.root);
    await ensureDir(path.join(this.root, 'domains'));
    await ensureDir(path.join(this.root, 'users'));
    await ensureDir(path.join(this.root, 'confluxes'));
    await ensureDir(path.join(this.root, 'archives'));

    let world = await this.getWorld();
    if (!world) {
      world = createWorldFromConfig(this.config);
      await attachStoryPoolsFromCatalog(world, this);
      this.guard.setLiveWorld(world.id);
      await this.writeWorldUnlocked(world);
    } else {
      this.guard.setLiveWorld(world.id);
    }
  }

  worldPath() {
    return path.join(this.root, 'world.yaml');
  }

  domainPath(domainId) {
    return path.join(this.root, 'domains', `${domainId}.yaml`);
  }

  userPath(userId) {
    return path.join(this.root, 'users', `${userId}.yaml`);
  }

  confluxPath(confluxId) {
    return path.join(this.root, 'confluxes', `${confluxId}.yaml`);
  }

  annotationCatalogPath(kind = 'mystery') {
    const file = kind === 'suspense' ? 'suspense-annotation-catalog.yaml' : 'annotation-catalog.yaml';
    return path.join(this.root, file);
  }

  async getAnnotationCatalog(kind = 'mystery') {
    const k = kind === 'suspense' ? 'suspense' : 'mystery';
    const data = await readYaml(this.annotationCatalogPath(k), { cards: [] });
    return { kind: k, cards: Array.isArray(data?.cards) ? data.cards : [] };
  }

  async saveAnnotationCatalog(doc, kind = 'mystery') {
    const k = doc?.kind === 'suspense' || kind === 'suspense' ? 'suspense' : 'mystery';
    await writeYaml(this.annotationCatalogPath(k), {
      kind: k,
      cards: Array.isArray(doc?.cards) ? doc.cards : [],
      updatedAt: new Date().toISOString(),
    });
    return doc;
  }

  async getWorld() {
    const world = await readYaml(this.worldPath(), null);
    if (!world) return null;
    const normalized = normalizeWorld(world, this.config);
    await attachStoryPoolsFromCatalog(normalized, this);
    return normalized;
  }

  async writeWorldUnlocked(world, { force = false } = {}) {
    if (!this.guard.acceptWorld(world)) {
      this.guard.reject('world', world?.id);
      return world;
    }
    normalizeWorld(world, this.config);
    const stored = await readYaml(this.worldPath(), null);
    world.rev = nextRevision('world', world, stored?.rev, { force });
    world.updatedAt = new Date().toISOString();
    await writeYaml(this.worldPath(), world);
    return world;
  }

  async saveWorld(world, { force = false } = {}) {
    return this.guard.exclusive(() => this.writeWorldUnlocked(world, { force }));
  }

  /**
   * Взять мир, поменять, отдать — под тем же замком, что и запись.
   * Единственный безопасный способ править мир, который держат минутами:
   * очередь заданий у него общая на всех.
   */
  async updateWorld(mutate) {
    return this.guard.exclusive(async () => {
      const world = await this.getWorld();
      if (!world) return null;
      await mutate(world);
      return this.writeWorldUnlocked(world);
    });
  }

  async getDomain(domainId) {
    const domain = await readYaml(this.domainPath(domainId), null);
    if (!domain) return null;
    normalizeDomain(domain);
    ensureOfficersFromLore(domain, this.config);
    return domain;
  }

  async writeDomainUnlocked(domain, { force = false } = {}) {
    if (!this.guard.acceptDomain(domain)) {
      this.guard.reject('domain', domain?.id);
      return domain;
    }
    normalizeDomain(domain);
    ensureOfficersFromLore(domain, this.config);
    stripOfficerPortraitPayload(domain);
    const stored = await readYaml(this.domainPath(domain.id), null);
    domain.rev = nextRevision('domain', domain, stored?.rev, { force });
    domain.updatedAt = new Date().toISOString();
    await writeYaml(this.domainPath(domain.id), domain);
    return domain;
  }

  async saveDomain(domain, { force = false } = {}) {
    return this.guard.exclusive(() => this.writeDomainUnlocked(domain, { force }));
  }

  /** Взять город, поменять, отдать. Для писателей в чужой город. */
  async updateDomain(domainId, mutate) {
    return this.guard.exclusive(async () => {
      const domain = await this.getDomain(domainId);
      if (!domain) return null;
      await mutate(domain);
      return this.writeDomainUnlocked(domain);
    });
  }

  async deleteDomain(domainId) {
    await fs.unlink(this.domainPath(domainId)).catch(() => {});
  }

  async listDomains() {
    const dir = path.join(this.root, 'domains');
    const files = await fs.readdir(dir).catch(() => []);
    const domains = [];
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const domain = await readYaml(path.join(dir, file), null);
      if (domain) {
        normalizeDomain(domain);
        ensureOfficersFromLore(domain, this.config);
        domains.push(domain);
      }
    }
    return domains;
  }

  async getUserBinding(userId) {
    return readYaml(this.userPath(String(userId)), null);
  }

  async listUserBindings() {
    const dir = path.join(this.root, 'users');
    const files = await fs.readdir(dir).catch(() => []);
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const binding = await readYaml(path.join(dir, file), null);
      if (binding) out.push(binding);
    }
    return out;
  }

  async saveUserBinding(binding) {
    return this.guard.exclusive(async () => {
      if (!this.guard.acceptBinding(binding)) {
        this.guard.reject('user', binding?.userId);
        return binding;
      }
      binding.updatedAt = new Date().toISOString();
      await writeYaml(this.userPath(String(binding.userId)), binding);
      return binding;
    });
  }

  async getDomainForUser(userId, worldId) {
    const binding = await this.getUserBinding(userId);
    if (!binding) return null;
    if (worldId && binding.worldId !== worldId) return null;
    if (!binding.domainId) return null;
    return this.getDomain(binding.domainId);
  }

  async getConflux(confluxId) {
    return readYaml(this.confluxPath(confluxId), null);
  }

  async deleteConflux(confluxId) {
    await fs.unlink(this.confluxPath(confluxId)).catch(() => {});
  }

  async saveConflux(conflux) {
    return this.guard.exclusive(async () => {
      if (!this.guard.acceptConflux(conflux)) {
        this.guard.reject('conflux', conflux?.id);
        return conflux;
      }
      conflux.updatedAt = new Date().toISOString();
      await writeYaml(this.confluxPath(conflux.id), conflux);
      return conflux;
    });
  }

  async listConfluxes({ status } = {}) {
    const dir = path.join(this.root, 'confluxes');
    const files = await fs.readdir(dir).catch(() => []);
    const out = [];
    const statusFilter = status
      ? new Set(Array.isArray(status) ? status : [status])
      : null;
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const c = await readYaml(path.join(dir, file), null);
      if (!c) continue;
      if (statusFilter && !statusFilter.has(c.status)) continue;
      out.push(c);
    }
    return out;
  }

  async sweepForeignUnlocked() {
    const live = this.guard.liveWorldId;
    if (!live) return;
    for (const d of await this.listDomains()) {
      if (String(d.worldId || '') !== live) await this.deleteDomain(d.id);
    }
    for (const c of await this.listConfluxes()) {
      if (String(c.worldId || '') !== live) {
        await fs.unlink(this.confluxPath(c.id)).catch(() => {});
      }
    }
    for (const u of await this.listUserBindings()) {
      if (u.worldId && String(u.worldId) !== live) {
        await fs.unlink(this.userPath(u.userId || u.id)).catch(() => {});
      }
    }
  }

  /**
   * Архив текущего мира + логи, затем новый уникальный мир.
   * @returns {{ ok, driver, archivedWorldId, newWorldId, archiveDir }}
   */
  async wipeAll({ reason = 'wipe' } = {}) {
    return this.guard.exclusive(async () => {
      const world = await this.getWorld();
      const domains = await this.listDomains();
      const users = await this.listUserBindings();
      const confluxes = await this.listConfluxes();

      let archiveDir = null;
      let archivedWorldId = world?.id || null;

      if (world) {
        const archived = await writeWorldArchive({
          config: this.config,
          world,
          domains,
          users,
          confluxes,
          reason,
        });
        archiveDir = archived.archiveDir;
        archivedWorldId = archived.worldId;
      }

      await clearYamlDir(path.join(this.root, 'domains'));
      await clearYamlDir(path.join(this.root, 'users'));
      await clearYamlDir(path.join(this.root, 'confluxes'));
      await fs.unlink(this.worldPath()).catch(() => {});

      const next = createWorldFromConfig(this.config);
      await attachStoryPoolsFromCatalog(next, this);
      this.guard.setLiveWorld(next.id);
      await this.writeWorldUnlocked(next);
      await this.sweepForeignUnlocked();

      return {
        ok: true,
        driver: 'yaml',
        archivedWorldId,
        newWorldId: next.id,
        archiveDir,
        world: next,
      };
    });
  }

  /** Заменить живой мир снимком. Тот же worldId, без архива. */
  async replaceLiveWorld({ world, domains = [], users = [], confluxes = [], catalogs = null } = {}) {
    if (!world?.id) throw new Error('snapshot has no world');
    return this.guard.exclusive(async () => {
      this.guard.setLiveWorld(world.id);
      await clearYamlDir(path.join(this.root, 'domains'));
      await clearYamlDir(path.join(this.root, 'users'));
      await clearYamlDir(path.join(this.root, 'confluxes'));
      // Ревизии снимка чужие живому хранилищу: откат — не гонка писателей.
      await this.writeWorldUnlocked(world, { force: true });
      for (const domain of domains) {
        if (!domain?.id) continue;
        await this.writeDomainUnlocked(domain, { force: true });
      }
      for (const binding of users) {
        if (!this.guard.acceptBinding(binding)) continue;
        const uid = binding.userId ?? binding.id;
        if (!uid) continue;
        binding.updatedAt = new Date().toISOString();
        await writeYaml(this.userPath(String(uid)), { ...binding, userId: String(uid) });
      }
      for (const conflux of confluxes) {
        if (!conflux?.id || !this.guard.acceptConflux(conflux)) continue;
        conflux.updatedAt = new Date().toISOString();
        await writeYaml(this.confluxPath(conflux.id), conflux);
      }
      if (catalogs) {
        await this.saveAnnotationCatalog(catalogs.mystery, 'mystery');
        await this.saveAnnotationCatalog(catalogs.suspense, 'suspense');
      }
      return { ok: true, driver: 'yaml', worldId: world.id };
    });
  }

  async close() {}
}
