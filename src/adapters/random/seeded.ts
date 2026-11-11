import { seededRng } from '../../core/random.js';
import type { Random } from '../../ports/random.js';

export function seededRandom(seed: number): Random {
  return { rng: seededRng(seed) };
}
