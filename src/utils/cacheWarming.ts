/**
 * Cache-warming strategy for cold vs warm start instrumentation (#684).
 *
 * Cold start: empty cache, no prior session data.
 * Warm start: returning user, cache hydrated from IndexedDB.
 *
 * Warming must never surface stale data as fresh (#516 staleness discipline),
 * so every warmed entry is validated against a max-age before it is used.
 */

export type StartKind = 'cold' | 'warm';

export interface StartupMetrics {
  kind: StartKind;
  /** Time to interactive, in milliseconds. */
  tti: number;
  /** First meaningful paint, in milliseconds. */
  fmp: number;
}

/**
 * Separate budgets for cold and warm starts. Warm starts are expected to be
 * faster because the cache is already hydrated.
 */
export const STARTUP_BUDGETS: Record<StartKind, { tti: number; fmp: number }> = {
  cold: { tti: 4000, fmp: 2500 },
  warm: { tti: 2000, fmp: 1200 },
};

/** Maximum age (ms) a warmed entry may have before it is considered stale. */
export const WARM_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

interface WarmedEntry<T> {
  value: T;
  /** Epoch ms when the entry was written. */
  cachedAt: number;
}

const CACHE_PREFIX = 'warm:';

/**
 * Determine whether this session is a cold or warm start based on whether a
 * prior warm cache exists.
 */
export function detectStartKind(): StartKind {
  if (typeof window === 'undefined') return 'cold';
  try {
    return window.localStorage.getItem('warm:session') ? 'warm' : 'cold';
  } catch {
    return 'cold';
  }
}

/**
 * Record a startup measurement and report whether it stayed within budget.
 * Cold and warm starts are budgeted separately.
 */
export function recordStartup(metrics: StartupMetrics): { withinBudget: boolean } {
  const budget = STARTUP_BUDGETS[metrics.kind];
  const withinBudget = metrics.tti <= budget.tti && metrics.fmp <= budget.fmp;

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem('warm:session', '1');
    } catch {
      /* storage unavailable; warming is best-effort */
    }
  }

  return { withinBudget };
}

/**
 * Validate a warmed entry for staleness before display (#516). Returns the
 * value only when it is fresh; otherwise returns null so callers fall back to
 * a network fetch rather than showing stale data as fresh.
 */
export function readWarmed<T>(entry: WarmedEntry<T> | null | undefined, now = Date.now()): T | null {
  if (!entry) return null;
  if (typeof entry.cachedAt !== 'number') return null;
  if (now - entry.cachedAt > WARM_CACHE_MAX_AGE_MS) return null;
  return entry.value;
}

/**
 * Hydrate a value from IndexedDB, validating staleness before returning it.
 * Resolves to null when the entry is missing, stale, or storage is unavailable.
 */
export async function hydrateFromIndexedDB<T>(key: string): Promise<T | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const entry = await new Promise<WarmedEntry<T> | null>((resolve) => {
      const request = indexedDB.open('warm-cache', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries');
      };
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('entries', 'readonly');
        const get = tx.objectStore('entries').get(CACHE_PREFIX + key);
        get.onsuccess = () => resolve((get.result as WarmedEntry<T>) ?? null);
        get.onerror = () => resolve(null);
      };
    });
    return readWarmed<T>(entry);
  } catch {
    return null;
  }
}

/**
 * Emit preload hints for resources that make a cold start behave more like a
 * warm one. Safe to call during startup; no-ops outside the browser.
 */
export function emitPreloadHints(urls: string[]): void {
  if (typeof document === 'undefined') return;
  for (const url of urls) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.href = url;
    link.as = 'fetch';
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }
}

/**
 * Report the field cold:warm ratio from recorded start kinds.
 */
export function coldWarmRatio(kinds: StartKind[]): { cold: number; warm: number; ratio: number } {
  const cold = kinds.filter((k) => k === 'cold').length;
  const warm = kinds.filter((k) => k === 'warm').length;
  const ratio = warm === 0 ? (cold > 0 ? Infinity : 0) : cold / warm;
  return { cold, warm, ratio };
}
