/**
 * Ревизия записи: тихую потерю превращает в громкую.
 *
 * Писатель читает мир или город, минуту думает (модели), потом сохраняет
 * целиком. Если за эту минуту кто-то уже записал своё, старая копия затрёт
 * чужую работу и никто об этом не узнает. Номер ревизии ловит именно это:
 * пишущий обязан предъявить ту версию, которую читал.
 *
 * Замок (`DomainQueue`, `guard.exclusive`) — первая защита; ревизия нужна
 * ровно для тех мест, где замок забыли взять.
 */

export class StaleWriteError extends Error {
  constructor(kind, id, { mine, stored } = {}) {
    super(`${kind} ${id || '?'}: запись от ревизии ${mine}, в хранилище уже ${stored}`);
    this.name = 'StaleWriteError';
    this.kind = kind;
    this.recordId = id || null;
    this.mine = mine ?? null;
    this.stored = stored ?? null;
  }
}

export function revisionOf(doc) {
  const n = Number(doc?.rev);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Следующий номер для записи.
 *
 * Копия без ревизии — новая запись или мир из снимка: спорить не о чем.
 * `force` для восстановления из снимка, где ревизии заведомо чужие.
 */
export function nextRevision(kind, doc, storedRev, { force = false } = {}) {
  const stored = revisionOf({ rev: storedRev }) ?? 0;
  const mine = revisionOf(doc);
  if (!force && mine != null && mine !== stored) {
    throw new StaleWriteError(kind, doc?.id, { mine, stored });
  }
  return stored + 1;
}
