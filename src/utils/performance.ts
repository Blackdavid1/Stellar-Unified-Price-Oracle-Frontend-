/**
 * Startup performance instrumentation and cache-warming utilities.
 *
 * Issue #684: cold (empty cache) and warm (returning user) starts behave very
 * differently, so we measure and budget them separately. Warmed data is always
 * validated for staleness before it is shown as fresh (#516 staleness discipline).
 */

export type StartupKind = 'cold' | 'warm';

export interface StartupMetrics {
  kind: StartupKind;
  /** Time to interactive, in milliseconds. */
  tti: number;
  /** First meaningful paint, in milliseconds. */
  fmp: number;
  /** Epoch ms when the measurement was captured. */
  timestamp: number;
}

/**
 * Separate budgets for cold and warm starts. Cold starts are allowed more time
 * because they must fetch and hydrate everything from scratch.
 */
export const STARTUP_BUDGETS: Record<StartupKind, { tti: number; fmp: number }> = {
  cold: { tti: 5000, fmp: 2500 },
  warm: { tti: 2000, fmp: 1000 },
};

/** Maximum age (ms) before warmed data is considered stale and must be refetched. */
export const WARM_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

const WARM_MARKER_KEY = 'app:has-warmed-cache';

/**
 * Determine whether this is a cold or warm start. A warm start is a returning
 * user whose cache was previously hydrated; a cold start has an empty cache.
 */
export function detectStartupKind(): StartupKind {
  try {
    return localStorage.getItem(WARM_MARKER_KEY) === '1' ? 'warm' : 'cold';
  } catch {
    return 'cold';
  }
}

/** Mark that the cache has been warmed so subsequent starts are warm. */
export function markCacheWarmed(): void {
  try {
    localStorage.setItem(WARM_MARKER_KEY, '1');
  } catch {
    // Storage unavailable (private mode, quota); stay cold rather than throw.
  }
}

/**
 * Record a startup measurement and report whether it stayed within budget.
 * Cold and warm starts are budgeted separately.
 */
export function recordStartup(metrics: StartupMetrics): { withinBudget: boolean } {
  const budget = STARTUP_BUDGETS[metrics.kind];
  const withinBudget = metrics.tti <= budget.tti && metrics.fmp <= budget.fmp;

  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(`startup:${metrics.kind}:tti`, { startTime: metrics.tti });
    performance.mark(`startup:${metrics.kind}:fmp`, { startTime: metrics.fmp });
  }

  return { withinBudget };
}

/**
 * Report the field cold:warm ratio so we can track how many users actually get
 * a warm start. Returns the ratio of cold starts to warm starts (cold / warm).
 */
export function reportColdWarmRatio(counts: { cold: number; warm: number }): number {
  if (counts.warm <= 0) {
    return counts.cold > 0 ? Infinity : 0;
  }
  return counts.cold / counts.warm;
}

interface WarmedEntry<T> {
  data: T;
  cachedAt: number;
}

/**
 * Validate warmed data for staleness before display. Returns the data only when
 * it is fresh enough; otherwise returns null so the caller refetches instead of
 * showing stale data as fresh (#516).
 */
export function readWarmedData<T>(
  entry: WarmedEntry<T> | null | undefined,
  maxAgeMs: number = WARM_CACHE_MAX_AGE_MS,
  now: number = Date.now(),
): T | null {
  if (!entry || typeof entry.cachedAt !== 'number') {
    return null;
  }
  if (now - entry.cachedAt > maxAgeMs) {
    return null;
  }
  return entry.data;
}

/**
 * Cache-warming strategy: hydrate from IndexedDB and emit preload hints so more
 * cold starts become warm. Warming is best-effort and never blocks startup.
 */
export async function warmCache(
  hydrate: () => Promise<void>,
  preloadUrls: string[] = [],
): Promise<void> {
  if (typeof document !== 'undefined') {
    for (const url of preloadUrls) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.href = url;
      link.as = 'fetch';
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
  }

  try {
    await hydrate();
    markCacheWarmed();
  } catch {
    // Warming is opportunistic; a failure just means the next start stays cold.
  }
}
