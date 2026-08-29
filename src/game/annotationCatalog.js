/**
 * Каталоги mystery/suspense-аннотаций переживают wipe.
 * Пул на мире = стартер этого жанра + каталог этого жанра.
 */

import { getLogger } from '../log.js';
import { seedMysteryAnnotation } from './mysteryAnnotation.js';
import { seedSuspenseAnnotation } from './suspenseAnnotation.js';
import { plotConfig } from './plotlines.js';
import {
  annotationCardFromGenerated,
  annotationKindOf,
  annotationTagsFromCard,
  loadStarterPool,
  mergeAnnotationCatalog,
  normalizeAnnotationCard,
  poolKeyOf,
  poolMinSize,
  refillBatchSize,
} from './annotationPool.js';

export async function loadAnnotationCatalog(storage, kind = 'mystery') {
  const k = annotationKindOf(kind);
  if (!storage?.getAnnotationCatalog) return { kind: k, cards: [] };
  const doc = await storage.getAnnotationCatalog(k);
  const cards = (doc?.cards || []).map((c) => normalizeAnnotationCard(c)).filter(Boolean);
  return { kind: k, cards };
}

export function mergeWorldAnnotationPool(world, catalogCards = [], kind = 'mystery') {
  if (!world || typeof world !== 'object') return [];
  const k = annotationKindOf(kind);
  const key = poolKeyOf(k);
  world[key] = mergeAnnotationCatalog(
    loadStarterPool(k),
    mergeAnnotationCatalog(catalogCards, world[key] || []),
  );
  return world[key];
}

export function mergeWorldMysteryPool(world, catalogCards = []) {
  return mergeWorldAnnotationPool(world, catalogCards, 'mystery');
}

export function mergeWorldSuspensePool(world, catalogCards = []) {
  return mergeWorldAnnotationPool(world, catalogCards, 'suspense');
}

export async function attachStoryPoolsFromCatalog(world, storage) {
  const mystery = await loadAnnotationCatalog(storage, 'mystery');
  const suspense = await loadAnnotationCatalog(storage, 'suspense');
  mergeWorldAnnotationPool(world, mystery.cards, 'mystery');
  mergeWorldAnnotationPool(world, suspense.cards, 'suspense');
  return world;
}

export async function attachMysteryPoolFromCatalog(world, storage) {
  return attachStoryPoolsFromCatalog(world, storage);
}

function annotationCfg(cfg, kind) {
  return annotationKindOf(kind) === 'suspense' ? cfg.suspenseAnnotation : cfg.mysteryAnnotation;
}

async function seedOne(kind, opts) {
  return annotationKindOf(kind) === 'suspense' ? seedSuspenseAnnotation(opts) : seedMysteryAnnotation(opts);
}

/**
 * Если стартер+каталог короче порога — долить пачку с фабрики и сохранить в каталог.
 * Не гоняет до poolMin за один вызов: максимум refillBatch карточек.
 */
export async function refillAnnotationPool({
  world,
  storage,
  runtime,
  config,
  kind = 'mystery',
  log: parentLog,
  rng = Math.random,
} = {}) {
  const k = annotationKindOf(kind);
  const log = (parentLog || getLogger()).child({ scope: 'annotation.refill', kind: k });
  const { cards: catalogCards } = await loadAnnotationCatalog(storage, k);
  mergeWorldAnnotationPool(world, catalogCards, k);
  const durable = mergeAnnotationCatalog(loadStarterPool(k), catalogCards);
  const min = poolMinSize(config, k);
  const poolKey = poolKeyOf(k);
  if (durable.length >= min) {
    return { added: [], poolSize: world[poolKey].length, skipped: 'pool_ok', kind: k };
  }
  if (!runtime || !storage?.saveAnnotationCatalog) {
    return { added: [], poolSize: world[poolKey].length, skipped: 'no_runtime', kind: k };
  }

  const batch = refillBatchSize(config, k);
  const cfg = plotConfig(config);
  const ann = annotationCfg(cfg, k);
  const recent = catalogCards.slice(-(ann?.recentWindow || 5)).map((c) => ({
    arena: c.axes?.arena,
    seed: { tags: annotationTagsFromCard(c) },
  }));
  const added = [];
  let nextCatalog = [...catalogCards];

  for (let i = 0; i < batch; i += 1) {
    try {
      const result = await seedOne(k, {
        config,
        runtime,
        log,
        recent,
        rng,
      });
      if (!result?.ok || !result.annotation) continue;
      const card = annotationCardFromGenerated({ ...result, kind: k });
      if (!card) continue;
      nextCatalog.push(card);
      recent.push({
        arena: card.axes?.arena,
        seed: { tags: annotationTagsFromCard(card) },
      });
      added.push(card);
    } catch (err) {
      log.warn('annotation.refill_failed', { error: err.message, index: i, kind: k });
    }
  }

  if (added.length) {
    world[poolKey] = mergeAnnotationCatalog(world[poolKey], added);
    await storage.saveAnnotationCatalog({ cards: nextCatalog }, k);
    log.info('annotation.refilled', { added: added.length, catalog: nextCatalog.length, kind: k });
  }
  return { added, poolSize: world[poolKey].length, skipped: null, kind: k };
}

export async function refillMysteryAnnotationPool(opts = {}) {
  return refillAnnotationPool({ ...opts, kind: 'mystery' });
}

export async function refillSuspenseAnnotationPool(opts = {}) {
  return refillAnnotationPool({ ...opts, kind: 'suspense' });
}
