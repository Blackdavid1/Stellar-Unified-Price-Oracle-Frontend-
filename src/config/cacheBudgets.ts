/**
 * Centralized, typed budgets for every in-memory cache.
 *
 * This module is the single source of truth for cache capacity limits and
 * eviction policies. Do not scatter magic numbers across cache
 * implementations — import the relevant budget from here instead.
 *
 * Each budget declares:
 *  - `maxItems`: hard cap on the number of retained entries.
 *  - `maxBytes`: optional hard cap on approximate retained bytes.
 *  - `eviction`: the eviction policy applied when a cap is exceeded.
 *  - `description`: human-readable documentation of the cache and policy.
 */

export type EvictionPolicy = 'lru' | 'fifo' | 'ring';

export interface CacheBudget {
  /** Hard cap on the number of retained entries. */
  readonly maxItems: number;
  /** Optional hard cap on approximate retained bytes. */
  readonly maxBytes?: number;
  /** Eviction policy applied when a cap is exceeded. */
  readonly eviction: EvictionPolicy;
  /** Human-readable documentation of the cache and its policy. */
  readonly description: string;
}

/**
 * Inventory of every in-memory cache in the app, keyed by a stable id.
 *
 * - `preload`: module preload cache (src/lib/preloadCache.ts). LRU by access.
 * - `history`: per-session history buffers. Ring buffer, oldest dropped first.
 * - `chartSeries`: chart series point buffers. Ring buffer per series.
 * - `analytics`: analytics event buffers. FIFO, oldest dropped first.
 */
export const CACHE_BUDGETS = {
  preload: {
    maxItems: 256,
    maxBytes: 8 * 1024 * 1024,
    eviction: 'lru',
    description:
      'Module preload cache. LRU eviction by last access; capped at 256 entries or ~8 MiB.',
  },
  history: {
    maxItems: 1000,
    maxBytes: 4 * 1024 * 1024,
    eviction: 'ring',
    description:
      'Per-session history buffers. Ring buffer retaining the most recent 1000 entries or ~4 MiB.',
  },
  chartSeries: {
    maxItems: 2000,
    maxBytes: 16 * 1024 * 1024,
    eviction: 'ring',
    description:
      'Chart series point buffers. Ring buffer retaining the most recent 2000 points per series or ~16 MiB.',
  },
  analytics: {
    maxItems: 5000,
    maxBytes: 8 * 1024 * 1024,
    eviction: 'fifo',
    description:
      'Analytics event buffers. FIFO eviction, oldest events dropped first; capped at 5000 events or ~8 MiB.',
  },
} as const satisfies Record<string, CacheBudget>;

export type CacheId = keyof typeof CACHE_BUDGETS;

export const CACHE_IDS = Object.keys(CACHE_BUDGETS) as CacheId[];

/**
 * Returns the budget for a cache id. Throws for unknown ids so that a
 * missing budget is caught at development time rather than silently
 * allowing an unbounded cache.
 */
export function getCacheBudget(id: CacheId): CacheBudget {
  const budget = CACHE_BUDGETS[id];
  if (!budget) {
    throw new Error(`No cache budget registered for "${id}"`);
  }
  return budget;
}

/**
 * Returns true when the given size is within the cache's item budget.
 * Used by the performance overlay and the soak test to assert that no
 * cache exceeds its budget.
 */
export function isWithinBudget(id: CacheId, size: number): boolean {
  return size <= getCacheBudget(id).maxItems;
}

/**
 * Returns the ids of every cache whose reported size exceeds its budget.
 * An empty array means all caches are within budget.
 */
export function findOverBudgetCaches(
  sizes: Partial<Record<CacheId, number>>,
): CacheId[] {
  return CACHE_IDS.filter((id) => {
    const size = sizes[id];
    return typeof size === 'number' && !isWithinBudget(id, size);
  });
}
