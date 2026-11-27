/**
 * Что игрок видит, пока поднимается город: обучающий текст один раз и полоска прогресса,
 * которую клиент обновляет на месте.
 */

import { readFileSync } from 'node:fs';

export const GENESIS_TUTORIAL = readFileSync(new URL('./texts/genesis-tutorial.md', import.meta.url), 'utf8').trim();

const BAR = 10;

export function genesisProgressBar(step: number, total: number, label: string): string {
  const max = Math.max(1, total);
  const now = Math.max(0, Math.min(max, step));
  const filled = Math.round((now / max) * BAR);
  return `Город поднимается\n${'▓'.repeat(filled)}${'░'.repeat(BAR - filled)}  ${label}`.trim();
}
