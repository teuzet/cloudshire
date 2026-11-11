import type { City, CitySeed, World } from '../core/city.js';

/**
 * Хранилище. Каждый документ несёт revision: запись поверх чужой, более
 * свежей ревизии бросает StaleWriteError, а не тихо затирает чужое.
 */
export class StaleWriteError extends Error {
  constructor(what: string) {
    super(`устаревшая запись: ${what}`);
    this.name = 'StaleWriteError';
  }
}

/** Черновик онбординга игрока: разговор до появления города. */
export interface OnboardingDraft {
  ownerId: string;
  messages: Array<{ role: 'patron' | 'guide'; text: string }>;
  /** Готовая «рыба» для генезиса, когда игрок её подтвердил. */
  seed: CitySeed | null;
  status: 'talking' | 'generating' | 'failed';
  revision: number;
}

export interface Storage {
  getWorld(): Promise<World | null>;
  saveWorld(world: World): Promise<World>;

  getCity(id: string): Promise<City | null>;
  getCityByOwner(ownerId: string): Promise<City | null>;
  listCities(): Promise<City[]>;
  saveCity(city: City): Promise<City>;
  deleteCity(id: string): Promise<void>;

  getDraft(ownerId: string): Promise<OnboardingDraft | null>;
  saveDraft(draft: OnboardingDraft): Promise<OnboardingDraft>;
  deleteDraft(ownerId: string): Promise<void>;
}
