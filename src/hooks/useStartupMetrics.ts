import { useEffect, useRef, useState } from 'react';

/**
 * Cold vs warm start instrumentation (#684).
 *
 * A "cold" start is a first visit with an empty cache; a "warm" start is a
 * returning user whose cache was hydrated. We measure TTI and first meaningful
 * paint (FMP) for each separately, enforce separate budgets, and report the
 * field cold:warm ratio so we can tell which start users actually get.
 */

export type StartupKind = 'cold' | 'warm';

export interface StartupBudget {
  /** Time to interactive budget in ms. */
  tti: number;
  /** First meaningful paint budget in ms. */
  fmp: number;
}

export interface StartupSample {
  kind: StartupKind;
  tti: number;
  fmp: number;
  /** Whether the sample stayed within its kind's budget. */
  withinBudget: boolean;
}

export interface StartupMetrics {
  kind: StartupKind;
  tti: number | null;
  fmp: number | null;
  withinBudget: boolean | null;
  /** Field cold:warm ratio observed so far (cold / warm). */
  coldWarmRatio: number | null;
}

/** Separate budgets for cold and warm starts. */
export const STARTUP_BUDGETS: Record<StartupKind, StartupBudget> = {
  cold: { tti: 5000, fmp: 2500 },
  warm: { tti: 2000, fmp: 1000 },
};

const WARM_MARKER_KEY = 'startup:warm';
const WARM_MARKER_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/**
 * A warm start is only valid if the cache marker is present and fresh.
 * Stale markers are treated as cold so we never present warmed data as fresh
 * (staleness discipline, #516).
 */
export function detectStartupKind(now: number = Date.now()): StartupKind {
  if (typeof window === 'undefined') return 'cold';
  try {
    const raw = window.localStorage.getItem(WARM_MARKER_KEY);
    if (!raw) return 'cold';
    const marker = JSON.parse(raw) as { at?: number };
    if (typeof marker.at !== 'number') return 'cold';
    if (now - marker.at > WARM_MARKER_TTL_MS) return 'cold';
    return 'warm';
  } catch {
    return 'cold';
  }
}

/** Mark the cache as warmed for the next visit. */
export function markCacheWarmed(now: number = Date.now()): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WARM_MARKER_KEY, JSON.stringify({ at: now }));
  } catch {
    /* storage unavailable; stay cold */
  }
}

/**
 * Validate warmed data before display. Returns true only when the payload is
 * present and not older than `maxAgeMs`, so stale data is never shown as fresh.
 */
export function isWarmedDataFresh(
  warmedAt: number | null | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (typeof warmedAt !== 'number') return false;
  return now - warmedAt <= maxAgeMs;
}

function readFmp(): number | null {
  if (typeof performance === 'undefined') return null;
  const entries = performance.getEntriesByType?.('paint') ?? [];
  const fmp = entries.find((e) => e.name === 'first-contentful-paint');
  return fmp ? fmp.startTime : null;
}

function readTti(): number | null {
  if (typeof performance === 'undefined') return null;
  const nav = performance.getEntriesByType?.('navigation')?.[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (nav && typeof nav.domInteractive === 'number') return nav.domInteractive;
  return null;
}

/**
 * Instrument a single startup. Reports TTI and FMP for the detected kind,
 * checks them against that kind's budget, and updates the field cold:warm
 * ratio. Also warms the cache for the next visit.
 */
export function useStartupMetrics(): StartupMetrics {
  const [metrics, setMetrics] = useState<StartupMetrics>({
    kind: 'cold',
    tti: null,
    fmp: null,
    withinBudget: null,
    coldWarmRatio: null,
  });
  const reported = useRef(false);

  useEffect(() => {
    if (reported.current) return;
    reported.current = true;

    const kind = detectStartupKind();
    const tti = readTti();
    const fmp = readFmp();
    const budget = STARTUP_BUDGETS[kind];
    const withinBudget =
      tti !== null && fmp !== null
        ? tti <= budget.tti && fmp <= budget.fmp
        : null;

    const sample: StartupSample = {
      kind,
      tti: tti ?? 0,
      fmp: fmp ?? 0,
      withinBudget: withinBudget ?? false,
    };

    // Field cold:warm ratio, persisted across visits.
    let coldWarmRatio: number | null = null;
    try {
      const counts = JSON.parse(
        window.localStorage.getItem('startup:counts') ?? '{}',
      ) as { cold?: number; warm?: number };
      counts[kind] = (counts[kind] ?? 0) + 1;
      window.localStorage.setItem('startup:counts', JSON.stringify(counts));
      const cold = counts.cold ?? 0;
      const warm = counts.warm ?? 0;
      coldWarmRatio = warm > 0 ? cold / warm : null;
    } catch {
      /* ignore */
    }

    setMetrics({ kind, tti, fmp, withinBudget, coldWarmRatio });

    // Warm the cache for the next visit so more cold starts become warm.
    markCacheWarmed();

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('startup:metrics', { detail: sample }),
      );
    }
  }, []);

  return metrics;
}
