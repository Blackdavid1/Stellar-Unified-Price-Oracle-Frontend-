import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Reference-price oracle hook (issue #664).
 *
 * Fetches an INDEPENDENT benchmark price source that is used purely for
 * evaluation / ground-truth cross-checks. It is NEVER part of the aggregate
 * and must never be surfaced as a tradable price.
 */

export interface ReferencePricePoint {
  /** ISO timestamp of the observation. */
  timestamp: string;
  /** Benchmark price. Evaluation only — not tradable. */
  price: number;
}

export interface ReferenceDeviationPoint {
  timestamp: string;
  /** Aggregate price at this observation. */
  aggregate: number;
  /** Independent benchmark price at this observation. */
  reference: number;
  /** Signed relative deviation: (aggregate - reference) / reference. */
  deviation: number;
}

export interface ReferenceDeviationOptions {
  /** Rolling window (in points) used to detect sustained bias. */
  windowSize?: number;
  /** Absolute mean deviation above which a sustained-bias alert fires. */
  biasThreshold?: number;
  /** Polling interval in ms for the read-only reference feed. */
  pollIntervalMs?: number;
  /** Injectable fetcher (defaults to the read-only reference endpoint). */
  fetcher?: (signal?: AbortSignal) => Promise<ReferencePricePoint[]>;
}

export interface ReferenceDeviationResult {
  /** Time series of aggregate-vs-reference deviation. */
  series: ReferenceDeviationPoint[];
  /** Rolling mean deviation over the configured window. */
  rollingBias: number | null;
  /** True when sustained bias exceeds the configured threshold. */
  biasAlert: boolean;
  /** Latest benchmark price, for evaluation only. */
  latestReference: number | null;
  loading: boolean;
  error: Error | null;
  /** Force a refresh of the read-only reference feed. */
  refresh: () => void;
}

const DEFAULT_WINDOW = 12;
const DEFAULT_BIAS_THRESHOLD = 0.02;
const DEFAULT_POLL_INTERVAL = 60_000;

/**
 * Read-only reference feed. This endpoint is a benchmark oracle and is
 * intentionally kept separate from every aggregation source so it can act as
 * independent ground truth.
 */
async function defaultFetcher(signal?: AbortSignal): Promise<ReferencePricePoint[]> {
  const res = await fetch('/api/reference-price', {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Reference oracle request failed: ${res.status}`);
  }
  const data = (await res.json()) as ReferencePricePoint[];
  return Array.isArray(data) ? data : [];
}

/**
 * Compute the signed relative deviation between the aggregate and the
 * independent reference. The reference is used only as the denominator here —
 * it never feeds back into the aggregate.
 */
export function computeDeviation(
  aggregate: number,
  reference: number,
): number {
  if (!Number.isFinite(reference) || reference === 0) return 0;
  return (aggregate - reference) / reference;
}

/**
 * Score an aggregation strategy against the reference oracle. Lower is better.
 * Used to rank strategies and tune outlier thresholds without ever mutating
 * the aggregate itself.
 */
export function scoreAgainstReference(
  series: ReferenceDeviationPoint[],
): number {
  if (series.length === 0) return 0;
  const sumSq = series.reduce((acc, p) => acc + p.deviation * p.deviation, 0);
  return Math.sqrt(sumSq / series.length);
}

/**
 * Evaluate a candidate outlier threshold against the reference oracle and
 * return the resulting deviation series. The reference is consumed read-only.
 */
export function evaluateOutlierThreshold(
  aggregateSeries: { timestamp: string; price: number }[],
  referenceSeries: ReferencePricePoint[],
  threshold: number,
): ReferenceDeviationPoint[] {
  const referenceByTime = new Map(
    referenceSeries.map((p) => [p.timestamp, p.price]),
  );
  return aggregateSeries
    .filter((p) => referenceByTime.has(p.timestamp))
    .map((p) => {
      const reference = referenceByTime.get(p.timestamp) as number;
      const aggregate = Math.abs(p.price) > threshold ? p.price : reference;
      return {
        timestamp: p.timestamp,
        aggregate,
        reference,
        deviation: computeDeviation(aggregate, reference),
      };
    });
}

/**
 * Track aggregate-vs-reference deviation over time and alert on sustained bias.
 *
 * @param aggregateSeries aggregate observations (never includes the reference)
 */
export function useReferenceDeviation(
  aggregateSeries: { timestamp: string; price: number }[],
  options: ReferenceDeviationOptions = {},
): ReferenceDeviationResult {
  const {
    windowSize = DEFAULT_WINDOW,
    biasThreshold = DEFAULT_BIAS_THRESHOLD,
    pollIntervalMs = DEFAULT_POLL_INTERVAL,
    fetcher = defaultFetcher,
  } = options;

  const [referenceSeries, setReferenceSeries] = useState<ReferencePricePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const points = await fetcherRef.current(controller.signal);
        if (!cancelled) {
          setReferenceSeries(points);
          setError(null);
        }
      } catch (err) {
        if (!cancelled && (err as Error).name !== 'AbortError') {
          setError(err as Error);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(load, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [pollIntervalMs, nonce]);

  const series = useMemo<ReferenceDeviationPoint[]>(() => {
    const referenceByTime = new Map(
      referenceSeries.map((p) => [p.timestamp, p.price]),
    );
    return aggregateSeries
      .filter((p) => referenceByTime.has(p.timestamp))
      .map((p) => {
        const reference = referenceByTime.get(p.timestamp) as number;
        return {
          timestamp: p.timestamp,
          aggregate: p.price,
          reference,
          deviation: computeDeviation(p.price, reference),
        };
      });
  }, [aggregateSeries, referenceSeries]);

  const rollingBias = useMemo<number | null>(() => {
    if (series.length === 0) return null;
    const window = series.slice(-windowSize);
    const mean = window.reduce((acc, p) => acc + p.deviation, 0) / window.length;
    return mean;
  }, [series, windowSize]);

  const biasAlert = useMemo<boolean>(() => {
    if (rollingBias === null) return false;
    return Math.abs(rollingBias) >= biasThreshold;
  }, [rollingBias, biasThreshold]);

  const latestReference = useMemo<number | null>(() => {
    if (referenceSeries.length === 0) return null;
    return referenceSeries[referenceSeries.length - 1].price;
  }, [referenceSeries]);

  return {
    series,
    rollingBias,
    biasAlert,
    latestReference,
    loading,
    error,
    refresh,
  };
}

export default useReferenceDeviation;
