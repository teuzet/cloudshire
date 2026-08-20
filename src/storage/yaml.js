import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { createWorldFromConfig, normalizeDomain } from '../game/models.js';

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

export class YamlStorage {
  constructor(config) {
    this.config = config;
    this.root = config.storage.yaml.dir;
    this.driver = 'yaml';
  }

  async init() {
    await ensureDir(this.root);
    await ensureDir(path.join(this.root, 'domains'));
    await ensureDir(path.join(this.root, 'users'));
    await ensureDir(path.join(this.root, 'confluxes'));

    let world = await this.getWorld();
    if (!world) {
      world = createWorldFromConfig(this.config);
      await this.saveWorld(world);
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

  async getWorld() {
    return readYaml(this.worldPath(), null);
  }

  async saveWorld(world) {
    world.updatedAt = new Date().toISOString();
    await writeYaml(this.worldPath(), world);
    return world;
  }

  async getDomain(domainId) {
    const domain = await readYaml(this.domainPath(domainId), null);
    return domain ? normalizeDomain(domain) : null;
  }

  async saveDomain(domain) {
    normalizeDomain(domain);
    domain.updatedAt = new Date().toISOString();
    await writeYaml(this.domainPath(domain.id), domain);
    return domain;
  }

  async listDomains() {
    const dir = path.join(this.root, 'domains');
    const files = await fs.readdir(dir).catch(() => []);
    const domains = [];
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const domain = await readYaml(path.join(dir, file), null);
      if (domain) domains.push(normalizeDomain(domain));
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
    binding.updatedAt = new Date().toISOString();
    await writeYaml(this.userPath(String(binding.userId)), binding);
    return binding;
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

  async saveConflux(conflux) {
    conflux.updatedAt = new Date().toISOString();
    await writeYaml(this.confluxPath(conflux.id), conflux);
    return conflux;
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

  async wipeAll() {
    const domains = await this.listDomains();
    for (const d of domains) {
      await fs.unlink(this.domainPath(d.id)).catch(() => {});
    }
    const usersDir = path.join(this.root, 'users');
    const userFiles = await fs.readdir(usersDir).catch(() => []);
    for (const file of userFiles) {
      if (file.endsWith('.yaml')) {
        await fs.unlink(path.join(usersDir, file)).catch(() => {});
      }
    }
    const confluxDir = path.join(this.root, 'confluxes');
    const confluxFiles = await fs.readdir(confluxDir).catch(() => []);
    for (const file of confluxFiles) {
      if (file.endsWith('.yaml')) {
        await fs.unlink(path.join(confluxDir, file)).catch(() => {});
      }
    }
    await fs.unlink(this.worldPath()).catch(() => {});
    const world = createWorldFromConfig(this.config);
    await this.saveWorld(world);
    return { ok: true, driver: 'yaml' };
  }

  async close() {}
}
