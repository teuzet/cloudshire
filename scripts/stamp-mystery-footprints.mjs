#!/usr/bin/env node
/**
 * Переименовать axes.truthArena → arena и проставить storyFootprint стартовому пулу тайн.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { stampStarterFootprint } from '../src/game/annotationPool.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'config/mystery-annotation-pool.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const cards = (raw.cards || []).map((card) => {
  const stamped = stampStarterFootprint(card);
  if (!stamped) throw new Error(`bad card ${card.id || card.title}`);
  return stamped;
});
fs.writeFileSync(
  file,
  `${JSON.stringify({ version: raw.version || 1, kind: 'mystery', cards }, null, 2)}\n`,
);
console.log(`stamped ${cards.length} mystery cards`);
