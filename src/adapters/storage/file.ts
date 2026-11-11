import fs from 'node:fs/promises';
import path from 'node:path';
import type { City, World } from '../../core/city.js';
import { StaleWriteError, type OnboardingDraft, type Storage } from '../../ports/storage.js';

/**
 * Хранилище в JSON-файлах для локальной игры:
 *   <dir>/world.json, <dir>/cities/<id>.json, <dir>/drafts/<ownerId>.json
 * Запись атомарная: сначала во временный файл, потом rename.
 */
export class FileStorage implements Storage {
  constructor(private readonly dir: string) {}

  private file(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  private async read<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async write(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  private async put<T extends { revision: number }>(file: string, doc: T, what: string): Promise<T> {
    const stored = await this.read<T>(file);
    if (stored && stored.revision !== doc.revision) throw new StaleWriteError(what);
    const next = { ...doc, revision: doc.revision + 1 };
    await this.write(file, next);
    return next;
  }

  getWorld(): Promise<World | null> {
    return this.read<World>(this.file('world.json'));
  }

  saveWorld(world: World): Promise<World> {
    return this.put(this.file('world.json'), world, 'мир');
  }

  getCity(id: string): Promise<City | null> {
    return this.read<City>(this.file('cities', `${id}.json`));
  }

  async getCityByOwner(ownerId: string): Promise<City | null> {
    return (await this.listCities()).find((c) => c.ownerId === ownerId) ?? null;
  }

  async listCities(): Promise<City[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.file('cities'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: City[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const city = await this.read<City>(this.file('cities', name));
      if (city) out.push(city);
    }
    return out;
  }

  saveCity(city: City): Promise<City> {
    return this.put(this.file('cities', `${city.id}.json`), city, `город ${city.id}`);
  }

  async deleteCity(id: string): Promise<void> {
    await fs.rm(this.file('cities', `${id}.json`), { force: true });
  }

  getDraft(ownerId: string): Promise<OnboardingDraft | null> {
    return this.read<OnboardingDraft>(this.file('drafts', `${encodeURIComponent(ownerId)}.json`));
  }

  saveDraft(draft: OnboardingDraft): Promise<OnboardingDraft> {
    return this.put(this.file('drafts', `${encodeURIComponent(draft.ownerId)}.json`), draft, `черновик ${draft.ownerId}`);
  }

  async deleteDraft(ownerId: string): Promise<void> {
    await fs.rm(this.file('drafts', `${encodeURIComponent(ownerId)}.json`), { force: true });
  }
}
