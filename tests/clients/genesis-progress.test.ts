import { describe, expect, it } from 'vitest';
import { GENESIS_TUTORIAL, genesisProgressBar } from '../../src/clients/genesis-progress.js';

describe('прогресс генезиса', () => {
  it('полоска заполняется по шагам и не выходит за края', () => {
    expect(genesisProgressBar(0, 6, 'начинаю…')).toContain('░░░░░░░░░░  начинаю…');
    expect(genesisProgressBar(3, 6, 'x')).toContain('▓▓▓▓▓░░░░░');
    expect(genesisProgressBar(9, 6, 'город готов')).toContain('▓▓▓▓▓▓▓▓▓▓  город готов');
  });

  it('обучающий текст на месте', () => {
    expect(GENESIS_TUTORIAL.length).toBeGreaterThan(300);
  });
});
