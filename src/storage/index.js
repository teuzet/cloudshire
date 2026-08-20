import { YamlStorage } from './yaml.js';
import { MongoStorage } from './mongo.js';

export async function createStorage(config) {
  const driver = config.storage?.driver || 'yaml';

  if (driver === 'yaml') {
    const storage = new YamlStorage(config);
    await storage.init();
    return storage;
  }

  if (driver === 'mongo') {
    const storage = new MongoStorage(config);
    await storage.init();
    return storage;
  }

  throw new Error(`Unknown storage driver: ${driver}`);
}
