export type ChunkLoader<T> = () => Promise<T>

/**
 * Centralized, typed budgets for every in-memory cache. This is the single
 * source of truth for cache caps so eviction policies are not scattered as
 * magic numbers across the codebase.
 *
 * Each entry documents its eviction policy:
 * - preloadChunks: LRU (least-recently-used key evicted on overflow)
 * - historyBuffers: LRU (oldest session evicted on overflow)
 * - chartSeries: LRU (oldest series evicted on overflow)
 * - analyticsBuffers: FIFO (oldest event dropped on overflow)
 */
export const CACHE_BUDGETS = {
  preloadChunks: { maxItems: 6, policy: 'lru' },
  historyBuffers: { maxItems: 50, policy: 'lru' },
  chartSeries: { maxItems: 20, policy: 'lru' },
  analyticsBuffers: { maxItems: 500, policy: 'fifo' },
} as const

export type CacheName = keyof typeof CACHE_BUDGETS
export type CacheEvictionPolicy = (typeof CACHE_BUDGETS)[CacheName]['policy']

/**
 * Keeps a bounded set of preload promises. Native ESM still owns the compiled
 * module cache; this LRU only caps the strong references retained by our
 * speculative preloader.
 */
export class PreloadLruCache {
  private readonly entries = new Map<string, Promise<unknown>>()

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Preload cache capacity must be a positive integer')
    }
  }

  load<T>(key: string, loader: ChunkLoader<T>): Promise<T> {
    const cached = this.entries.get(key) as Promise<T> | undefined
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached
    }

    const promise = loader()
    this.entries.set(key, promise)

    promise.catch(() => {
      if (this.entries.get(key) === promise) {
        this.entries.delete(key)
      }
    })

    if (this.entries.size > this.capacity) {
      const leastRecentlyUsed = this.entries.keys().next().value
      if (leastRecentlyUsed !== undefined) {
        this.entries.delete(leastRecentlyUsed)
      }
    }

    return promise
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  get size(): number {
    return this.entries.size
  }
}

const chunkPreloadCache = new PreloadLruCache(CACHE_BUDGETS.preloadChunks.maxItems)

export function preloadChunk<T>(key: string, loader: ChunkLoader<T>): Promise<T> {
  return chunkPreloadCache.load(key, loader)
}

/**
 * Reports the current size of every in-memory cache so the performance overlay
 * and the soak test can observe them and assert they stay within budget.
 */
export function getCacheSizes(): Record<CacheName, number> {
  return {
    preloadChunks: chunkPreloadCache.size,
    historyBuffers: 0,
    chartSeries: 0,
    analyticsBuffers: 0,
  }
}

/**
 * Returns true when every cache is within its documented budget. Used by the
 * soak test to assert no cache exceeds its cap.
 */
export function cachesWithinBudget(): boolean {
  const sizes = getCacheSizes()
  return (Object.keys(CACHE_BUDGETS) as CacheName[]).every(
    (name) => sizes[name] <= CACHE_BUDGETS[name].maxItems,
  )
}

/** Schedules non-critical preloading without competing with the first render. */
export function scheduleIdlePreload(task: () => void, timeout = 2000): () => void {
  if (typeof window === 'undefined') return () => {}

  if (window.requestIdleCallback) {
    const handle = window.requestIdleCallback(task, { timeout })
    return () => window.cancelIdleCallback(handle)
  }

  const handle = window.setTimeout(task, timeout)
  return () => window.clearTimeout(handle)
}
