/**
 * Один писатель на город: операции над одним городом идут строго по очереди.
 * Разные города не ждут друг друга. Это в пределах процесса; ревизия
 * в хранилище страхует от второго процесса.
 */

export class CityLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(cityId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(cityId) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(cityId, tail);
    void tail.then(() => {
      if (this.tails.get(cityId) === tail) this.tails.delete(cityId);
    });
    return next;
  }
}
