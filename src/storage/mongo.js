import { MongoClient } from 'mongodb';
import { createWorldFromConfig, normalizeDomain, normalizeWorld } from '../game/models.js';
import { writeWorldArchive } from './worldArchive.js';
import { getLogger } from '../log.js';
import { attachStoryPoolsFromCatalog } from '../game/annotationCatalog.js';
import { stripOfficerPortraitPayload } from '../game/officers.js';

/**
 * Mongo implementation of the same storage surface as YamlStorage.
 */
export class MongoStorage {
  constructor(config) {
    this.config = config;
    this.driver = 'mongo';
    this.client = null;
    this.db = null;
  }

  async init() {
    const { uri, db } = this.config.storage.mongo;
    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db(db);

    await this.db.collection('domains').createIndex({ ownerUserId: 1, worldId: 1 });
    await this.db.collection('users').createIndex({ userId: 1 }, { unique: true });
    await this.db.collection('world_archives').createIndex({ worldId: 1 }, { unique: true });
    await this.db.collection('usage').createIndex({ worldId: 1, ts: -1 });

    const world = await this.getWorld();
    if (!world) {
      const created = createWorldFromConfig(this.config);
      await attachStoryPoolsFromCatalog(created, this);
      await this.saveWorld(created);
    }
  }

  col(name) {
    return this.db.collection(name);
  }

  async getWorld() {
    const doc = await this.col('world').findOne({ _id: 'current' });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    const world = normalizeWorld(rest, this.config);
    await attachStoryPoolsFromCatalog(world, this);
    return world;
  }

  async saveWorld(world) {
    normalizeWorld(world, this.config);
    world.updatedAt = new Date().toISOString();
    const doc = { ...world, _id: 'current' };
    await this.col('world').replaceOne({ _id: 'current' }, doc, { upsert: true });
    return world;
  }

  async getDomain(domainId) {
    const doc = await this.col('domains').findOne({ _id: domainId });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return normalizeDomain({ id: _id, ...rest });
  }

  async saveDomain(domain) {
    normalizeDomain(domain);
    stripOfficerPortraitPayload(domain);
    domain.updatedAt = new Date().toISOString();
    const { id, ...rest } = domain;
    await this.col('domains').replaceOne({ _id: id }, { _id: id, ...rest }, { upsert: true });
    return domain;
  }

  async deleteDomain(domainId) {
    await this.col('domains').deleteOne({ _id: domainId });
  }

  async listDomains() {
    const docs = await this.col('domains').find({}).toArray();
    return docs.map(({ _id, ...rest }) => normalizeDomain({ id: _id, ...rest }));
  }

  async getUserBinding(userId) {
    const doc = await this.col('users').findOne({ userId: String(userId) });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
  }

  async listUserBindings() {
    const docs = await this.col('users').find({}).toArray();
    return docs.map(({ _id, ...rest }) => rest);
  }

  async saveUserBinding(binding) {
    binding.updatedAt = new Date().toISOString();
    await this.col('users').replaceOne(
      { userId: String(binding.userId) },
      { ...binding, userId: String(binding.userId) },
      { upsert: true },
    );
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
    const doc = await this.col('confluxes').findOne({ _id: confluxId });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { id: _id, ...rest };
  }

  async saveConflux(conflux) {
    conflux.updatedAt = new Date().toISOString();
    const { id, ...rest } = conflux;
    await this.col('confluxes').replaceOne({ _id: id }, { _id: id, ...rest }, { upsert: true });
    return conflux;
  }

  async listConfluxes({ status } = {}) {
    const filter = {};
    if (status) {
      const list = Array.isArray(status) ? status : [status];
      filter.status = { $in: list };
    }
    const docs = await this.col('confluxes').find(filter).toArray();
    return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
  }

  async appendUsage(row) {
    if (!row || typeof row !== 'object') return;
    await this.col('usage').insertOne({ ...row });
  }

  async listUsage({ worldId = null, limit = 5000 } = {}) {
    const filter = {};
    if (worldId) filter.worldId = String(worldId);
    const docs = await this.col('usage')
      .find(filter)
      .sort({ ts: 1 })
      .limit(Math.max(1, Math.min(50000, Number(limit) || 5000)))
      .toArray();
    return docs.map(({ _id, ...rest }) => rest);
  }

  async getAnnotationCatalog(kind = 'mystery') {
    const id = kind === 'suspense' ? 'suspense' : 'mystery';
    const doc = await this.col('annotation_catalog').findOne({ _id: id });
    return { kind: id, cards: Array.isArray(doc?.cards) ? doc.cards : [] };
  }

  async saveAnnotationCatalog(doc, kind = 'mystery') {
    const id = doc?.kind === 'suspense' || kind === 'suspense' ? 'suspense' : 'mystery';
    await this.col('annotation_catalog').replaceOne(
      { _id: id },
      {
        _id: id,
        kind: id,
        cards: Array.isArray(doc?.cards) ? doc.cards : [],
        updatedAt: new Date().toISOString(),
      },
      { upsert: true },
    );
    return doc;
  }

  async wipeAll({ reason = 'wipe' } = {}) {
    const world = await this.getWorld();
    const domains = await this.listDomains();
    const users = await this.listUserBindings();
    const confluxes = await this.listConfluxes();

    let archiveDir = null;
    let archivedWorldId = world?.id || null;

    if (world) {
      archivedWorldId = world.id;
      const skipDisk = this.config.logging?.file === false || process.env.DYNO || process.env.RAILWAY_ENVIRONMENT;
      if (!skipDisk) {
        try {
          const archived = await writeWorldArchive({
            config: this.config,
            world,
            domains,
            users,
            confluxes,
            reason,
          });
          archiveDir = archived.archiveDir;
        } catch (err) {
          getLogger().warn('wipe.disk_archive_skipped', { error: err.message });
        }
      }

      let usageRows = [];
      try {
        usageRows = await this.listUsage({ worldId: world.id, limit: 20000 });
      } catch {
        usageRows = [];
      }

      await this.col('world_archives').replaceOne(
        { worldId: world.id },
        {
          worldId: world.id,
          seasonKey: world.seasonKey || null,
          archivedAt: new Date().toISOString(),
          reason,
          archiveDir,
          world: { ...world, status: 'archived', endedAt: new Date().toISOString() },
          domains,
          users,
          confluxes,
          usage: usageRows,
        },
        { upsert: true },
      );
    }

    await this.col('domains').deleteMany({});
    await this.col('users').deleteMany({});
    await this.col('confluxes').deleteMany({});
    await this.col('world').deleteMany({});
    if (world?.id) {
      await this.col('usage').deleteMany({ worldId: world.id });
    }

    const next = createWorldFromConfig(this.config);
    await attachStoryPoolsFromCatalog(next, this);
    await this.saveWorld(next);

    return {
      ok: true,
      driver: 'mongo',
      archivedWorldId,
      newWorldId: next.id,
      archiveDir,
      world: next,
    };
  }

  async close() {
    if (this.client) await this.client.close();
  }
}
