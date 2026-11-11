/**
 * Зависимости потоков. Поток знает порты и агентов, но не провайдеров и не транспорт.
 */

import type { City, PoolName, World } from '../core/city.js';
import { makeId } from '../core/random.js';
import type { Rules } from '../core/rules.js';
import { dayAt } from '../core/time.js';
import type { Scenario } from '../core/world/scenario.js';
import type { AgentDeps } from '../agents/_shared/runtime.js';
import type { Clock } from '../ports/clock.js';
import type { Notifier, OutboundMessage } from '../ports/notifier.js';
import type { Random } from '../ports/random.js';
import { StaleWriteError, type Storage } from '../ports/storage.js';

export interface FlowLog {
  warn(event: string, data: Record<string, unknown>): void;
}

export interface FlowDeps {
  rules: Rules;
  agents: AgentDeps;
  storage: Storage;
  clock: Clock;
  random: Random;
  notifier: Notifier;
  /** Заготовки историй из scenarios/*.yaml. */
  scenarios: readonly Scenario[];
  log?: FlowLog;
}

export function newId(deps: Pick<FlowDeps, 'random'>, prefix: string): string {
  return makeId(prefix, deps.random.rng);
}

export function today(deps: Pick<FlowDeps, 'rules' | 'clock'>, world: Pick<World, 'clock'>): number {
  return dayAt(world.clock, deps.clock.now(), deps.rules);
}

export async function requireWorld(deps: Pick<FlowDeps, 'storage'>): Promise<World> {
  const world = await deps.storage.getWorld();
  if (!world) throw new Error('мир не создан');
  return world;
}

/** Агент сломался — поток идёт дальше по запасному пути и оставляет след в логе. */
export async function tryAgent<T>(deps: Pick<FlowDeps, 'log'>, what: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    deps.log?.warn('agent_failed', { what, error: String(err) });
    return fallback;
  }
}

/**
 * Вынуть имена из пула мира. Пул общий для всех городов, поэтому запись
 * с проверкой ревизии и повтором: два города не получат одно имя.
 */
export async function takeNames(deps: Pick<FlowDeps, 'storage'>, count: number): Promise<PoolName[]> {
  if (count <= 0) return [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const world = await requireWorld(deps);
    const names = world.namePool.slice(0, count);
    if (!names.length) return [];
    try {
      await deps.storage.saveWorld({ ...world, namePool: world.namePool.slice(names.length) });
      return names;
    } catch (err) {
      if (!(err instanceof StaleWriteError)) throw err;
    }
  }
  throw new Error('пул имён: не удалось записать мир');
}

/** Имена, которые агент не взял, возвращаются в пул (в конец). */
export async function returnNames(deps: Pick<FlowDeps, 'storage'>, names: PoolName[]): Promise<void> {
  if (!names.length) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const world = await requireWorld(deps);
    try {
      await deps.storage.saveWorld({ ...world, namePool: [...world.namePool, ...names] });
      return;
    } catch (err) {
      if (!(err instanceof StaleWriteError)) throw err;
    }
  }
}

/** Имена, которые реально появились в тексте. */
export function namesUsed(names: PoolName[], ...texts: string[]): PoolName[] {
  const all = texts.join('\n');
  return names.filter((n) => all.includes(n.name));
}

export async function sendAll(deps: Pick<FlowDeps, 'notifier' | 'log'>, messages: OutboundMessage[]): Promise<void> {
  for (const m of messages) {
    try {
      await deps.notifier.send(m);
    } catch (err) {
      deps.log?.warn('notify_failed', { ownerId: m.ownerId, error: String(err) });
    }
  }
}

export type { City };
