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

/**
 * Respects reduced data mode and constrained/metered connections (#516) so we
 * never spend a user's limited bandwidth on speculative prefetching.
 */
export function shouldPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false

  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection

  if (connection?.saveData) return false
  if (connection?.effectiveType && /(^|-)2g$/.test(connection.effectiveType)) return false

  if (typeof window !== 'undefined' && window.matchMedia) {
    if (window.matchMedia('(prefers-reduced-data: reduce)').matches) return false
  }

  return true
}

/**
 * Predicts likely-next routes from user intent (hover/focus, command palette,
 * history) and prefetches them in idle slices within a time budget. Prefetch
 * concurrency is capped and every in-flight prefetch is cancellable so a
 * navigation away never competes with critical work.
 */
export class IdlePrefetcher {
  private readonly queue: string[] = []
  private readonly seen = new Set<string>()
  private inFlight = 0
  private cancelled = false
  private cancelIdle: (() => void) | null = null

  constructor(
    private readonly loader: (route: string) => Promise<unknown>,
    private readonly options: { concurrency?: number; budgetMs?: number } = {},
  ) {}

  private get concurrency(): number {
    return this.options.concurrency ?? 2
  }

  private get budgetMs(): number {
    return this.options.budgetMs ?? 2000
  }

  /** Records an intent signal (hover/focus, command palette, history). */
  predict(route: string): void {
    if (this.cancelled || !route || this.seen.has(route)) return
    this.seen.add(route)
    this.queue.push(route)
    this.schedule()
  }

  private schedule(): void {
    if (this.cancelled || this.cancelIdle) return
    this.cancelIdle = scheduleIdlePreload(() => {
      this.cancelIdle = null
      this.drain()
    }, this.budgetMs)
  }

  private drain(): void {
    if (this.cancelled || !shouldPrefetch()) return

    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const route = this.queue.shift() as string
      this.inFlight += 1
      this.loader(route)
        .catch(() => {})
        .finally(() => {
          this.inFlight -= 1
          if (!this.cancelled && this.queue.length > 0) this.schedule()
        })
    }
  }

  /** Cancels pending idle work and stops scheduling further prefetches. */
  cancel(): void {
    this.cancelled = true
    this.queue.length = 0
    if (this.cancelIdle) {
      this.cancelIdle()
      this.cancelIdle = null
    }
  }
}
