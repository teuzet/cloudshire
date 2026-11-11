import type { Rng } from '../core/random.js';

/** Источник случайности. core получает из него функцию Rng. */
export interface Random {
  rng: Rng;
}
