/**
 * Темы города: короткий список того, чем город живёт. Вес темы — сумма модулей вкладов её объектов.
 */

import type { City } from '../city.js';
import { magnitude, rawToPoints } from './numbers.js';
import { activeObjects } from './objects.js';

export const MAX_THEMES = 6;

export function themeWeights(city: Pick<City, 'objects' | 'statScale'>): Array<{ name: string; weight: number }> {
  const sum = new Map<string, number>();
  for (const obj of activeObjects(city)) {
    const weight = magnitude(rawToPoints(city, obj.statEffect));
    for (const theme of obj.themes) sum.set(theme, (sum.get(theme) ?? 0) + weight);
  }
  return [...sum.entries()]
    .map(([name, weight]) => ({ name, weight }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, MAX_THEMES);
}

export function themeNames(city: Pick<City, 'objects' | 'statScale'>): string[] {
  return themeWeights(city).map((t) => t.name);
}
