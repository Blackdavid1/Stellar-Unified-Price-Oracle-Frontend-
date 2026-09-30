import { useEffect, useRef, useCallback } from 'react';

/**
 * Idle-time prefetch and predictive hydration of likely-next routes (#680).
 *
 * - Predicts likely next routes from intent (hover/focus, command palette, history).
 * - Prefetches in idle slices within a time budget.
 * - Caps concurrency and cancels in-flight prefetches on navigation away.
 * - Respects reduced data mode / constrained connections (#516).
 */

export interface PrefetchOptions {
  /** Total idle time budget in ms for a single prefetch batch. */
  budgetMs?: number;
  /** Maximum number of concurrent prefetches. */
  maxConcurrency?: number;
  /** Timeout for a single prefetch request in ms. */
  requestTimeoutMs?: number;
  /** Optional predicate to skip prefetching for a route. */
  shouldPrefetch?: (route: string) => boolean;
}

const DEFAULT_BUDGET_MS = 2000;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** Detect constrained / metered connections or reduced data mode (#516). */
export function isConstrainedConnection(): boolean {
  if (typeof navigator === 'undefined') return false;

  const nav = navigator as Navigator & {
    connection?: {
      saveData?: boolean;
      effectiveType?: string;
    };
  };

  const conn = nav.connection;
  if (conn) {
    if (conn.saveData) return true;
    if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') {
      return true;
    }
  }

  if (typeof window !== 'undefined' && window.matchMedia) {
    if (window.matchMedia('(prefers-reduced-data: reduce)').matches) {
      return true;
    }
  }

  return false;
}

/** Schedule a callback during idle time, falling back to a timeout. */
function onIdle(cb: () => void, timeout = 1000): () => void {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    const id = (window as Window & {
      requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback(cb, { timeout });
    return () => {
      (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(id);
    };
  }
  const id = setTimeout(cb, 1);
  return () => clearTimeout(id);
}

/**
 * Prefetch a batch of routes in idle slices, capped and cancellable.
 * Returns a cancel function.
 */
export function prefetchRoutes(
  routes: string[],
  prefetch: (route: string) => Promise<unknown>,
  options: PrefetchOptions = {},
): () => void {
  const {
    budgetMs = DEFAULT_BUDGET_MS,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    shouldPrefetch,
  } = options;

  let cancelled = false;
  const cancelIdle = { current: null as null | (() => void) };

  if (isConstrainedConnection()) {
    return () => {};
  }

  const queue = routes.filter((r) => (shouldPrefetch ? shouldPrefetch(r) : true));
  const start = Date.now();
  let active = 0;
  let index = 0;

  const runNext = () => {
    if (cancelled) return;
    if (Date.now() - start > budgetMs) return;
    if (index >= queue.length) return;

    while (active < maxConcurrency && index < queue.length) {
      const route = queue[index++];
      active++;

      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, requestTimeoutMs);
      });

      Promise.race([prefetch(route), timeout])
        .catch(() => {})
        .finally(() => {
          active--;
          if (!cancelled) {
            cancelIdle.current = onIdle(runNext);
          }
        });
    }
  };

  cancelIdle.current = onIdle(runNext);

  return () => {
    cancelled = true;
    if (cancelIdle.current) cancelIdle.current();
  };
}

/**
 * React hook: predict likely next routes from intent and prefetch them in idle time.
 */
export function usePrefetch(
  prefetch: (route: string) => Promise<unknown>,
  options: PrefetchOptions = {},
) {
  const cancelRef = useRef<null | (() => void)>(null);
  const historyRef = useRef<string[]>([]);

  const cancel = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
    }
  }, []);

  const schedule = useCallback(
    (routes: string[]) => {
      cancel();
      if (!routes.length) return;
      cancelRef.current = prefetchRoutes(routes, prefetch, options);
    },
    [cancel, prefetch, options],
  );

  // Cancel in-flight prefetches on navigation away / unmount.
  useEffect(() => {
    return () => cancel();
  }, [cancel]);

  // Intent: hover/focus on links.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleIntent = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('#')) return;
      schedule([href]);
    };

    document.addEventListener('mouseover', handleIntent, { passive: true });
    document.addEventListener('focusin', handleIntent, { passive: true });
    return () => {
      document.removeEventListener('mouseover', handleIntent);
      document.removeEventListener('focusin', handleIntent);
    };
  }, [schedule]);

  // Intent: command palette / history-driven prediction.
  const predictFromHistory = useCallback(
    (candidates: string[]) => {
      const history = historyRef.current;
      const ranked = candidates
        .filter((c) => !history.includes(c))
        .slice(0, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
      schedule(ranked);
    },
    [schedule, options.maxConcurrency],
  );

  const recordNavigation = useCallback((route: string) => {
    historyRef.current = [route, ...historyRef.current].slice(0, 10);
  }, []);

  return { schedule, cancel, predictFromHistory, recordNavigation };
}

export default usePrefetch;
