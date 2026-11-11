import type { Random } from '../../ports/random.js';

export const systemRandom: Random = { rng: () => Math.random() };
