/**
 * Хранилище в MongoDB. Документ = мир, город или черновик целиком.
 * Запись с проверкой ревизии: replaceOne по {_id, revision}; не совпало — StaleWriteError.
 */

import { MongoClient, type Collection, type Db } from 'mongodb';
import type { City, World } from '../../core/city.js';
import { StaleWriteError, type OnboardingDraft, type Storage } from '../../ports/storage.js';

type Doc<T> = T & { _id: string };

function strip<T>(doc: Doc<T> | null): T | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  void _id;
  return rest as T;
}

async function put<T extends { revision: number }>(col: Collection<Doc<T>>, id: string, doc: T, what: string): Promise<T> {
  const next = { ...doc, revision: doc.revision + 1 };
  const body = { ...next, _id: id } as Doc<T>;
  const res = await col.replaceOne({ _id: id, revision: doc.revision } as never, body);
  if (res.matchedCount === 1) return next;
  const exists = await col.countDocuments({ _id: id } as never, { limit: 1 });
  if (exists) throw new StaleWriteError(what);
  try {
    await col.insertOne(body as never);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new StaleWriteError(what);
    throw err;
  }
  return next;
}

export class MongoStorage implements Storage {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
  ) {}

  static async connect(uri: string, dbName = 'cloudshire'): Promise<MongoStorage> {
    const client = new MongoClient(uri);
    await client.connect();
    const storage = new MongoStorage(client, client.db(dbName));
    await storage.cities.createIndex({ ownerId: 1 }, { unique: true });
    return storage;
  }

  /** Только для тестов: снести базу целиком. */
  async dropDatabase(): Promise<void> {
    await this.db.dropDatabase();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private get worlds() {
    return this.db.collection<Doc<World>>('worlds');
  }
  private get cities() {
    return this.db.collection<Doc<City>>('cities');
  }
  private get drafts() {
    return this.db.collection<Doc<OnboardingDraft>>('drafts');
  }

  async getWorld(): Promise<World | null> {
    return strip(await this.worlds.findOne({}));
  }
  async saveWorld(world: World): Promise<World> {
    return put(this.worlds, world.id, world, 'мир');
  }
  async getCity(id: string): Promise<City | null> {
    return strip(await this.cities.findOne({ _id: id }));
  }
  async getCityByOwner(ownerId: string): Promise<City | null> {
    return strip(await this.cities.findOne({ ownerId }));
  }
  async listCities(): Promise<City[]> {
    return (await this.cities.find({}).toArray()).map((d) => strip(d) as City);
  }
  async saveCity(city: City): Promise<City> {
    return put(this.cities, city.id, city, `город ${city.id}`);
  }
  async deleteCity(id: string): Promise<void> {
    await this.cities.deleteOne({ _id: id });
  }
  async getDraft(ownerId: string): Promise<OnboardingDraft | null> {
    return strip(await this.drafts.findOne({ _id: ownerId }));
  }
  async saveDraft(draft: OnboardingDraft): Promise<OnboardingDraft> {
    return put(this.drafts, draft.ownerId, draft, `черновик ${draft.ownerId}`);
  }
  async deleteDraft(ownerId: string): Promise<void> {
    await this.drafts.deleteOne({ _id: ownerId });
  }
}
