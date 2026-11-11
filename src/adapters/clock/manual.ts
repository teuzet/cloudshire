import type { Clock } from '../../ports/clock.js';

/** Часы для тестов и сценариев: стоят, пока их не подвинут. */
export class ManualClock implements Clock {
  constructor(private ms: number = Date.UTC(2026, 0, 1)) {}

  now(): number {
    return this.ms;
  }

  set(ms: number): void {
    this.ms = ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
