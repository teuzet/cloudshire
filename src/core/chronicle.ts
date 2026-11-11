/**
 * Хроника и речь. Хроника — сухие факты случившегося; речь жреца — отдельный канал.
 */

import type { ChronicleEntry, City, DialogEntry } from './city.js';

export const DIALOG_KEEP = 200;

export function appendChronicle(city: Pick<City, 'chronicle'>, entry: ChronicleEntry): ChronicleEntry {
  city.chronicle.push({ ...entry, text: entry.text.trim().slice(0, 1500) });
  return entry;
}

export function recentChronicle(city: Pick<City, 'chronicle'>, count: number): ChronicleEntry[] {
  return city.chronicle.slice(-count);
}

export function appendDialog(city: Pick<City, 'dialog'>, entry: DialogEntry): void {
  city.dialog.push({ ...entry, text: entry.text.trim() });
  if (city.dialog.length > DIALOG_KEEP) city.dialog.splice(0, city.dialog.length - DIALOG_KEEP);
}

export function recentDialog(city: Pick<City, 'dialog'>, count: number): DialogEntry[] {
  return city.dialog.slice(-count);
}
