/**
 * Зависимости потоков. Поток знает порты и агентов, но не провайдеров и не транспорт.
 */

import type { City, PoolName, World } from '../core/city.js';
import { makeId } from '../core/random.js';
import type { Rules } from '../core/rules.js';
import { dayAt } from '../core/time.js';
import type { Scenario } from '../core/world/scenario.js';
import type { Namer } from '../core/people.js';
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
  /** Кто даёт имена новым людям во время потока; ставит `withNamer`. */
  namer?: Namer;
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

/** Сколько свободных имён поток держит под рукой для новых людей. */
const NAMER_PEEK = 24;

/**
 * Дать потоку раздатчика имён: каждый новый человек без личного имени получит имя из пула мира.
 * Имена не вынимаются заранее: в конце потока из пула уходят только розданные.
 */
export async function withNamer<T>(deps: FlowDeps, run: (deps: FlowDeps) => Promise<T>): Promise<T> {
  if (deps.namer) return run(deps);
  const world = await requireWorld(deps);
  // С конца пула: с начала имена вынимает takeNames для агентов того же потока.
  const free = world.namePool.slice(-NAMER_PEEK).reverse();
  const known = new Set([...(world.allNames ?? []), ...world.namePool.map((n) => n.name)]);
  const used = new Set<string>();
  const namer: Namer = {
    known,
    take(gender) {
      const pick = free.find((n) => !used.has(n.name) && n.gender === gender) ?? free.find((n) => !used.has(n.name));
      if (!pick) return null;
      used.add(pick.name);
      return pick.name;
    },
  };
  try {
    return await run({ ...deps, namer });
  } finally {
    if (used.size) await dropNames(deps, used);
  }
}

/** Убрать розданные имена из пула мира. */
async function dropNames(deps: Pick<FlowDeps, 'storage'>, names: ReadonlySet<string>): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const world = await requireWorld(deps);
    try {
      await deps.storage.saveWorld({ ...world, namePool: world.namePool.filter((n) => !names.has(n.name)) });
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
