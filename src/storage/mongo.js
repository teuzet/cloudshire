import { MongoClient } from 'mongodb';
import { createWorldFromConfig, normalizeDomain } from '../game/models.js';

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

    const world = await this.getWorld();
    if (!world) {
      await this.saveWorld(createWorldFromConfig(this.config));
    }
  }

  col(name) {
    return this.db.collection(name);
  }

  async getWorld() {
    return this.col('world').findOne({ _id: 'current' });
  }

  async saveWorld(world) {
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
    domain.updatedAt = new Date().toISOString();
    const { id, ...rest } = domain;
    await this.col('domains').replaceOne({ _id: id }, { _id: id, ...rest }, { upsert: true });
    return domain;
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

  async wipeAll() {
    await this.col('domains').deleteMany({});
    await this.col('users').deleteMany({});
    await this.col('confluxes').deleteMany({});
    await this.col('world').deleteMany({});
    await this.saveWorld(createWorldFromConfig(this.config));
    return { ok: true, driver: 'mongo' };
  }

  async close() {
    if (this.client) await this.client.close();
  }
}
