import type { City, World } from '../../core/city.js';
import { StaleWriteError, type OnboardingDraft, type Storage } from '../../ports/storage.js';

/**
 * Хранилище в памяти. Отдаёт и принимает копии, как настоящее:
 * правка объекта после save не меняет сохранённое.
 */
export class MemoryStorage implements Storage {
  private world: World | null = null;
  private readonly cities = new Map<string, City>();
  private readonly drafts = new Map<string, OnboardingDraft>();

  async getWorld(): Promise<World | null> {
    return this.world ? structuredClone(this.world) : null;
  }

  async saveWorld(world: World): Promise<World> {
    if (this.world && this.world.revision !== world.revision) throw new StaleWriteError('мир');
    const next = { ...structuredClone(world), revision: world.revision + 1 };
    this.world = next;
    return structuredClone(next);
  }

  async getCity(id: string): Promise<City | null> {
    const city = this.cities.get(id);
    return city ? structuredClone(city) : null;
  }

  async getCityByOwner(ownerId: string): Promise<City | null> {
    for (const city of this.cities.values()) if (city.ownerId === ownerId) return structuredClone(city);
    return null;
  }

  async listCities(): Promise<City[]> {
    return [...this.cities.values()].map((c) => structuredClone(c));
  }

  async saveCity(city: City): Promise<City> {
    const stored = this.cities.get(city.id);
    if (stored && stored.revision !== city.revision) throw new StaleWriteError(`город ${city.id}`);
    const next = { ...structuredClone(city), revision: city.revision + 1 };
    this.cities.set(city.id, next);
    return structuredClone(next);
  }

  async deleteCity(id: string): Promise<void> {
    this.cities.delete(id);
  }

  async getDraft(ownerId: string): Promise<OnboardingDraft | null> {
    const draft = this.drafts.get(ownerId);
    return draft ? structuredClone(draft) : null;
  }

  async saveDraft(draft: OnboardingDraft): Promise<OnboardingDraft> {
    const stored = this.drafts.get(draft.ownerId);
    if (stored && stored.revision !== draft.revision) throw new StaleWriteError(`черновик ${draft.ownerId}`);
    const next = { ...structuredClone(draft), revision: draft.revision + 1 };
    this.drafts.set(draft.ownerId, next);
    return structuredClone(next);
  }

  async deleteDraft(ownerId: string): Promise<void> {
    this.drafts.delete(ownerId);
  }
}
